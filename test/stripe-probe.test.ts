// §2a stripe{} block: key type and mode, per-resource permissions from probes, the contradicted rule,
// the hourly cache, and that no key or Stripe error message ever comes back.
import { describe, it, expect, vi } from "vitest";
import { env } from "./setup.ts";
import { signed, useSecret } from "./helpers.ts";
import ops from "../netlify/functions/ops.mts";
import { interpret, keyInfo, RESOURCES } from "../netlify/shared/ops/stripe-probe.mts";

const p = (status: number | null, errorType: string | null = null) => ({ status, errorType });
const KEY = ["rk", "live", "fake-test-key-not-real-mnop"].join("_");

describe("stripe permission rules", () => {
  it("reads key type and mode from the prefix only", () => {
    expect(keyInfo("rk_live_x")).toEqual({ mode: "live", type: "restricted" });
    expect(keyInfo("sk_test_x")).toEqual({ mode: "test", type: "secret" });
    expect(keyInfo(undefined)).toEqual({ mode: "unknown", type: "unknown" });
  });

  it("counts a write probe's 404 as write only when the key can read", () => {
    expect(interpret({ read: p(200), write: p(404, "invalid_request_error") })).toEqual({ permission: "write", contradicted: false });
    expect(interpret({ read: p(200), write: p(403, "invalid_request_error") })).toEqual({ permission: "read", contradicted: false });
    expect(interpret({ read: p(403, "invalid_request_error"), write: p(403, "invalid_request_error") })).toEqual({ permission: "none", contradicted: false });
    expect(interpret({ read: p(403), write: p(404) })).toEqual({ permission: "unknown", contradicted: true });
    expect(interpret({ read: p(200), write: null })).toEqual({ permission: "read", contradicted: false });
    expect(interpret({ read: p(null, "network_error"), write: p(null, "network_error") }).permission).toBe("unknown");
  });

  it("only probes with GETs and no-parameter POSTs on made-up ids", () => {
    for (const r of Object.values(RESOURCES)) if (r.write) expect(r.write).toMatch(/\/[a-z]+_doesnotexist$/);
  });
});

describe("stripe{} in /api/ops/health", () => {
  it("reports account, permissions and webhook, probes at most hourly, and never leaks the key or messages", async () => {
    useSecret();
    env.set("STRIPE_SECRET_KEY", KEY);
    env.set("STRIPE_WEBHOOK_SECRET", "whsec_x");
    env.set("STRIPE_ACCOUNT_ID", "acct_1UWpK6CskQrRqrZo");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://api.stripe.com/")) return new Response("{}", { status: 503 });
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u}`);
      const err = (s: number) => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `The provided key 'rk_live_***mnop' does not have access` } }), { status: s });
      if (u.includes("/payouts")) return err(403); // no payouts at all
      if (u.includes("/invoices")) return method === "GET" ? err(403) : err(404); // contradicted
      if (method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return u.includes("/refunds/") ? err(404) : u.includes("/customers/") ? err(404) : err(403);
    }));

    const get = async () => (await (await ops(signed("GET", "/api/ops/health"))).json()) as any;
    const body = await get();
    const s = body.stripe;
    expect(s.account).toBe("acct_1UWpK6CskQrRqrZo");
    expect(s.mode).toBe("live");
    expect(s.key).toMatchObject({ set: true, type: "restricted", assumption: "contradicted", contradictedResources: ["invoices"] });
    expect(s.key.permissions).toMatchObject({ refunds: "write", customers: "write", charges: "read", balance: "read", payouts: "none", invoices: "unknown" });
    expect(s.key.probes.invoices).toEqual({ read: { status: 403, errorType: "invalid_request_error" }, write: { status: 404, errorType: "invalid_request_error" } });
    expect(s.webhook).toEqual({ path: "/api/stripe/webhook", url: "https://burinandco.com/api/stripe/webhook", secretSet: true, lastEventAt: null });
    const text = JSON.stringify(body);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("does not have access");
    expect(text).not.toContain("mnop");
    expect(calls.every((c) => c.startsWith("GET ") || /^POST \S+_doesnotexist$/.test(c))).toBe(true);

    const n = calls.length;
    await get();
    expect(calls.length).toBe(n); // cached: no second probe within the hour
  });
});
