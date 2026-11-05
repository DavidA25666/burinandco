// Everything Tenfold HQ controls or reads that isn't an order: settings (with an audit log),
// the AI cost ledger, visits, Stripe webhook health, disputes, the email outbox and
// the request-id memory for signed actions. Kept in its own Blobs store ("ops").
import { getStore } from "@netlify/blobs";

const production = () => Netlify.context?.deploy?.context === "production";
export const opsStore = () => getStore({ name: production() ? "ops" : "ops-preview", consistency: "strong" });

const rand = () => crypto.randomUUID().slice(0, 8);

// ---------- Dates (America/New_York, the contract's reporting timezone) ----------

const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const nyDate = (d: Date | string | number = new Date()) => nyFmt.format(new Date(d));

export function dateRange(from: string, to: string) {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 800) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Settings ----------

export interface PriceSchedule { id: string; sku: string; cents: number; startsOn: string; endsOn: string; createdBy: string | null; createdAt: string }

export interface Settings {
  maintenance: boolean;
  maintenanceReason: string | null;
  headline: string | null;           // null = the headline written in index.html
  ownerEmails: boolean;              // owner notification emails (off: HQ action items instead)
  labEnabled: boolean;               // the model-compare page spends AI money: off until switched on in HQ
  aiMonthlyCapCents: number;         // monthly AI budget; alert at 75%, lab blocked at 100%
  aiCapBlocksOrders: boolean;        // at the cap, also block regenerations and print upscales
  autoReply: boolean;                // reserved for inbox auto replies (none are sent today)
  priceOverrides: Record<string, number>;   // sku -> cents
  priceSchedules: PriceSchedule[];
  unitCosts: Record<string, number>;        // sku -> cents, fulfillment incl. shipping (overrides the built-in estimate)
  ownerTestEmails: string[];                // orders from these emails are test orders
  pricingVersion: number;
}

export const DEFAULT_SETTINGS: Settings = {
  maintenance: false,
  maintenanceReason: null,
  headline: null,
  ownerEmails: false,
  labEnabled: false,
  aiMonthlyCapCents: 10000,
  aiCapBlocksOrders: false,
  autoReply: false,
  priceOverrides: {},
  priceSchedules: [],
  unitCosts: {},
  ownerTestEmails: [],
  pricingVersion: 1,
};

export async function getSettings(): Promise<Settings> {
  const saved = (await opsStore().get("settings", { type: "json" }).catch(() => null)) as Partial<Settings> | null;
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function updateSettings(by: string | null, action: string, change: (s: Settings) => void) {
  const before = await getSettings();
  const after: Settings = JSON.parse(JSON.stringify(before));
  change(after);
  await opsStore().setJSON("settings", after);
  await audit(by, action, diff(before, after));
  return after;
}

function diff(a: Settings, b: Settings) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(b) as (keyof Settings)[]) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = { from: a[k], to: b[k] };
  }
  return out;
}

// ---------- Audit log ----------

export interface AuditEntry { at: string; by: string | null; action: string; details: unknown }

export async function audit(by: string | null, action: string, details: unknown) {
  const at = new Date().toISOString();
  await opsStore().setJSON(`audit/${at}-${rand()}`, { at, by, action, details } satisfies AuditEntry);
}

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "audit/" });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  return (await Promise.all(keys.map((k) => store.get(k, { type: "json" }) as Promise<AuditEntry | null>))).filter((x): x is AuditEntry => !!x);
}

// ---------- AI cost ledger ----------

export type AiPurpose = "order" | "regeneration" | "upscale" | "lab";
export interface AiCall { at: string; date: string; model: string; purpose: AiPurpose; orderId: string | null; cents: number; seconds: number | null; ok: boolean }

// Estimated Replicate price per run, in cents. Replicate bills these models per image (or per
// second of GPU time); the numbers are kept here so a price change is a one-line edit.
export const AI_RATES_CENTS: Record<string, number> = {
  "openai/gpt-image-2.5-sunburst": 30,
  "google/nano-banana-pro": 24,
  "google/nano-banana-2.1": 15,
  "black-forest-labs/flux-kontext-max": 8,
  "topazlabs/image-upscale": 10,
};
export const aiRate = (model: string) => AI_RATES_CENTS[model] ?? 30;

export async function recordAiCall(call: Omit<AiCall, "at" | "date" | "cents"> & { cents?: number }) {
  const at = new Date().toISOString();
  const entry: AiCall = { ...call, at, date: nyDate(at), cents: call.cents ?? aiRate(call.model) };
  await opsStore().setJSON(`ai/${entry.date}/${at}-${rand()}`, entry);
  return entry;
}

export async function listAiCalls(from?: string, to?: string): Promise<AiCall[]> {
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "ai/" });
  const keys = blobs.map((b) => b.key).filter((k) => {
    const d = k.slice(3, 13);
    return (!from || d >= from) && (!to || d <= to);
  });
  return (await Promise.all(keys.map((k) => store.get(k, { type: "json" }) as Promise<AiCall | null>))).filter((x): x is AiCall => !!x);
}

export async function aiSpendThisMonth() {
  const today = nyDate();
  const calls = await listAiCalls(`${today.slice(0, 7)}-01`, today);
  return calls.reduce((s, c) => s + c.cents, 0);
}

// ---------- Visits (a tiny first-party counter: one key per visitor session per day) ----------

const token = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "direct";

export async function recordVisit(v: { sid: string; source: string; path: string; region: string | null }) {
  const now = new Date();
  const date = nyDate(now);
  const sid = token(v.sid);
  const minute = now.toISOString().slice(0, 16);
  const store = opsStore();
  // visit/<date>/<source>/<sid>: listing the prefix counts visits per day and source without reading bodies.
  await Promise.all([
    store.set(`visit/${date}/${token(v.source)}/${sid}`, "1"),
    store.set(`live/${minute}/${sid}`, JSON.stringify({ path: v.path.slice(0, 80), region: v.region })),
  ]);
}

export async function listVisits(from: string, to: string) {
  const { blobs } = await opsStore().list({ prefix: "visit/" });
  const out: { date: string; source: string }[] = [];
  for (const b of blobs) {
    const [, date, source] = b.key.split("/");
    if (date >= from && date <= to) out.push({ date, source });
  }
  return out;
}

export async function liveVisitors(minutes = 5) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16);
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "live/" });
  const sids = new Set<string>();
  const stale: string[] = [];
  for (const b of blobs) {
    const [, minute, sid] = b.key.split("/");
    if (minute >= since) sids.add(sid);
    else if (minute < hourAgo) stale.push(b.key);
  }
  // Live keys are only needed for the last few minutes: tidy up a batch each time.
  await Promise.all(stale.slice(0, 50).map((k) => store.delete(k)));
  return sids.size;
}

// ---------- Stripe webhook health and disputes ----------

export interface WebhookEvent { at: string; type: string; ok: boolean; error?: string; livemode: boolean }

export async function recordWebhook(e: WebhookEvent) {
  const store = opsStore();
  await store.setJSON(e.ok ? "webhook/last-ok" : "webhook/last-fail", e);
  if (!e.ok) await store.setJSON(`webhook-fail/${e.at}-${rand()}`, e);
}

export async function webhookStatus() {
  const store = opsStore();
  const [lastOk, lastFail] = await Promise.all([
    store.get("webhook/last-ok", { type: "json" }) as Promise<WebhookEvent | null>,
    store.get("webhook/last-fail", { type: "json" }) as Promise<WebhookEvent | null>,
  ]);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { blobs } = await store.list({ prefix: "webhook-fail/" });
  const failures24h = blobs.filter((b) => b.key.slice(13) >= since).length;
  return { lastOk, lastFail, failures24h };
}

export interface Dispute { id: string; charge: string | null; orderId: string | null; amountCents: number; status: string; reason: string | null; createdAt: string; updatedAt: string }

export async function saveDispute(d: Dispute) {
  await opsStore().setJSON(`dispute/${d.id}`, d);
}

export async function listDisputes(): Promise<Dispute[]> {
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "dispute/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Dispute | null>))).filter((x): x is Dispute => !!x);
}

// ---------- Email outbox (failed sends kept for flush_email_outbox) ----------

export interface OutboxItem { id: string; at: string; to: string; subject: string; html: string; replyTo: string | null; headers?: Record<string, string>; from?: string; attempts: number; lastError: string }

export async function queueFailedEmail(item: Omit<OutboxItem, "id" | "at" | "attempts">) {
  const at = new Date().toISOString();
  const id = `${at}-${rand()}`;
  await opsStore().setJSON(`outbox/${id}`, { ...item, id, at, attempts: 1 } satisfies OutboxItem);
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "outbox/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<OutboxItem | null>))).filter((x): x is OutboxItem => !!x);
}

export const removeOutbox = (id: string) => opsStore().delete(`outbox/${id}`);
export const saveOutbox = (item: OutboxItem) => opsStore().setJSON(`outbox/${item.id}`, item);

// ---------- Signed-action idempotency (X-Portfolio-Request-Id, 10 minutes) ----------

export async function rememberedResult(requestId: string | null) {
  if (!requestId) return null;
  const hit = (await opsStore().get(`reqid/${token(requestId)}`, { type: "json" })) as { at: number; status: number; body: unknown } | null;
  return hit && Date.now() - hit.at < 10 * 60_000 ? hit : null;
}

export async function rememberResult(requestId: string | null, status: number, body: unknown) {
  if (!requestId) return;
  await opsStore().setJSON(`reqid/${token(requestId)}`, { at: Date.now(), status, body });
}

// ---------- Small cache for slow upstream reads (Stripe balance etc.) ----------

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const store = opsStore();
  const hit = (await store.get(`cache/${key}`, { type: "json" }).catch(() => null)) as { at: number; value: T } | null;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  await store.setJSON(`cache/${key}`, { at: Date.now(), value });
  return value;
}
