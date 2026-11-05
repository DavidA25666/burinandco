import { describe, it, expect } from "vitest";
import { verifyOps } from "../netlify/shared/ops-auth.mts";

// The worked example from the HQ starter kit, signed by Tenfold HQ's own signer.
const SECRET = "tenfold-example-secret-not-for-production-0123456789";
const NOW = 1760000000000;
const base = "https://burinandco.com";

const getReq = (headers: Record<string, string>, path = "/api/ops/metrics?from=2025-09-10&to=2025-10-09") =>
  new Request(base + path, { method: "GET", headers });
const postReq = (headers: Record<string, string>, body = '{"action":"hq_signature_check","params":{}}') =>
  new Request(base + "/api/ops/actions", { method: "POST", headers, body });

const GET_SIG = "v1=e4f9de9a7331e07489fe787dc1dddc19e3b0988160d76c8d85f1f250ecd35733";
const POST_SIG = "v1=568a48468384fa68c9510dbc00a05002a6dec89d6675d4c9a2be2541bcbce34c";

describe("verifyOps (contract §1)", () => {
  it("accepts HQ's signed GET with a query", async () => {
    const r = await verifyOps(getReq({ "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": GET_SIG }), SECRET, NOW);
    expect(r).toEqual({ ok: true, body: "" });
  });

  it("accepts HQ's signed POST, byte for byte", async () => {
    const r = await verifyOps(postReq({ "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": POST_SIG }), SECRET, NOW);
    expect(r).toEqual({ ok: true, body: '{"action":"hq_signature_check","params":{}}' });
  });

  it("rejects a changed byte in the body", async () => {
    const r = await verifyOps(postReq({ "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": POST_SIG }, '{"action":"hq_signature_check","params":{ }}'), SECRET, NOW);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a changed byte in the query", async () => {
    const r = await verifyOps(getReq({ "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": GET_SIG }, "/api/ops/metrics?from=2025-09-11&to=2025-10-09"), SECRET, NOW);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp (more than 300 s either way)", async () => {
    const h = { "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": GET_SIG };
    expect(await verifyOps(getReq(h), SECRET, NOW + 301_000)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyOps(getReq(h), SECRET, NOW - 301_000)).toEqual({ ok: false, reason: "expired" });
    expect((await verifyOps(getReq(h), SECRET, NOW + 299_000)).ok).toBe(true);
  });

  it("rejects missing headers and a missing secret", async () => {
    expect(await verifyOps(getReq({ "X-Portfolio-Timestamp": "1760000000" }), SECRET, NOW)).toEqual({ ok: false, reason: "missing_headers" });
    expect(await verifyOps(getReq({ "X-Portfolio-Signature": GET_SIG }), SECRET, NOW)).toEqual({ ok: false, reason: "missing_headers" });
    expect(await verifyOps(getReq({ "X-Portfolio-Timestamp": "1760000000", "X-Portfolio-Signature": GET_SIG }), undefined, NOW)).toEqual({ ok: false, reason: "missing_secret" });
  });
});
