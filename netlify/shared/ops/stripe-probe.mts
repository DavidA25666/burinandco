// §2a: the stripe{} block in /api/ops/health. Reports which Stripe account this store uses, the key's
// mode and type, and what the key may do per resource, found by probing:
//   read:  GET /v1/<resource>?limit=1 (balance: GET /v1/balance)
//   write: POST /v1/<resource>/<prefix>_doesnotexist with no parameters (never a create call)
// Probes run at most once an hour. Only HTTP status codes and Stripe's error *type* are kept: never
// Stripe's error message (it quotes the masked key) and never the key itself.
import { opsStore } from "../ops-store.mts";

export type Perm = "write" | "read" | "none" | "unknown";
export interface Probe { status: number | null; errorType: string | null }
export interface ResourceProbe { read: Probe; write: Probe | null }

const PROBE_TTL_MS = 60 * 60_000;
const PROBE_KEY = "stripe/key-probe";

// Resources the store uses or HQ shows. write is null where Stripe has no write on that resource.
export const RESOURCES: Record<string, { read: string; write: string | null }> = {
  charges: { read: "charges?limit=1", write: "charges/ch_doesnotexist" },
  customers: { read: "customers?limit=1", write: "customers/cus_doesnotexist" },
  payment_intents: { read: "payment_intents?limit=1", write: "payment_intents/pi_doesnotexist" },
  payment_methods: { read: "payment_methods?limit=1&type=card", write: "payment_methods/pm_doesnotexist" },
  balance: { read: "balance", write: null },
  payouts: { read: "payouts?limit=1", write: "payouts/po_doesnotexist" },
  refunds: { read: "refunds?limit=1", write: "refunds/re_doesnotexist" },
  disputes: { read: "disputes?limit=1", write: "disputes/dp_doesnotexist" },
  invoices: { read: "invoices?limit=1", write: "invoices/in_doesnotexist" },
};

export function keyInfo(key: string | undefined) {
  const k = key ?? "";
  return {
    mode: /^(sk|rk)_live_/.test(k) ? "live" : /^(sk|rk)_test_/.test(k) ? "test" : "unknown",
    type: k.startsWith("rk_") ? "restricted" : k.startsWith("sk_") ? "secret" : "unknown",
  } as const;
}

async function call(key: string, method: "GET" | "POST", path: string): Promise<Probe> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) { await res.body?.cancel(); return { status: res.status, errorType: null }; }
    const data = await res.json().catch(() => null);
    return { status: res.status, errorType: typeof data?.error?.type === "string" ? data.error.type : null };
  } catch {
    return { status: null, errorType: "network_error" };
  }
}

const denied = (p: Probe) => p.status === 401 || p.status === 403;

/** Turns one resource's probe results into a permission. A write probe's 404 only counts as write when the key can read. */
export function interpret(p: ResourceProbe): { permission: Perm; contradicted: boolean } {
  const canRead = p.read.status === 200;
  const readDenied = denied(p.read);
  if (!p.write) return { permission: canRead ? "read" : readDenied ? "none" : "unknown", contradicted: false };
  if (p.write.status === 404) {
    if (canRead) return { permission: "write", contradicted: false };
    if (readDenied) return { permission: "unknown", contradicted: true }; // can't read, yet "not found" on write
    return { permission: "unknown", contradicted: false };
  }
  if (denied(p.write)) return { permission: canRead ? "read" : readDenied ? "none" : "unknown", contradicted: false };
  return { permission: canRead ? "read" : "unknown", contradicted: false };
}

export async function runProbes(key: string): Promise<Record<string, ResourceProbe>> {
  const out: Record<string, ResourceProbe> = {};
  for (const [name, r] of Object.entries(RESOURCES)) {
    out[name] = { read: await call(key, "GET", r.read), write: r.write ? await call(key, "POST", r.write) : null };
  }
  return out;
}

/** Last probe, rerun when older than an hour. The cache is keyed by a short fingerprint so a new key is probed fresh. */
async function probesFor(key: string) {
  const store = opsStore();
  const fp = `${key.slice(0, 8)}…${key.length}`; // prefix + length only; never stored in full
  const hit = (await store.get(PROBE_KEY, { type: "json" }).catch(() => null)) as { at: string; fp: string; probes: Record<string, ResourceProbe> } | null;
  if (hit && hit.fp === fp && Date.now() - Date.parse(hit.at) < PROBE_TTL_MS) return hit;
  const fresh = { at: new Date().toISOString(), fp, probes: await runProbes(key) };
  await store.setJSON(PROBE_KEY, fresh);
  return fresh;
}

export async function stripeBlock(origin: string, webhook: { lastOk: { at: string } | null }) {
  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  const info = keyInfo(key);
  const webhookBlock = {
    path: "/api/stripe/webhook",
    url: `${origin}/api/stripe/webhook`,
    secretSet: !!Netlify.env.get("STRIPE_WEBHOOK_SECRET"),
    lastEventAt: webhook.lastOk?.at ?? null,
  };
  const account = Netlify.env.get("STRIPE_ACCOUNT_ID")?.trim() || null;
  if (!key) return { account, mode: info.mode, key: { set: false, type: info.type, permissions: null, probedAt: null, assumption: null, probes: null }, webhook: webhookBlock };

  const { at, probes } = await probesFor(key);
  const permissions: Record<string, Perm> = {};
  const contradicted: string[] = [];
  for (const [name, p] of Object.entries(probes)) {
    const r = interpret(p);
    permissions[name] = r.permission;
    if (r.contradicted) contradicted.push(name);
  }
  return {
    account,
    mode: info.mode,
    key: {
      set: true,
      type: info.type,
      permissions,
      probedAt: at,
      // "not_found_means_allowed" holds only while no resource the key can't read answers 404 to a write probe.
      assumption: contradicted.length ? "contradicted" : "not_found_means_allowed",
      ...(contradicted.length ? { contradictedResources: contradicted } : {}),
      probes, // raw status codes and error types only
    },
    webhook: webhookBlock,
  };
}
