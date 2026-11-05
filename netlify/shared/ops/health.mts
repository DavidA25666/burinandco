// GET /api/ops/health (§2, §15, §16) and the cash block (§3b). These call Stripe, Resend and
// FinerWorks, so the slow reads are cached for a few minutes.
import { cached, webhookStatus, listOutbox, aiSpendThisMonth, type Settings } from "../ops-store.mts";
import { lastSyncRun, syncJobView } from "../finerworks-sync.mts";
import { getBalance, listPayouts, listStripeDisputes, stripeTestMode } from "../stripe.mts";
import { savedPaymentToken, finerworksLive } from "../finerworks.mts";
import { SITE_DOMAIN, supportAddress } from "../email.mts";
import { SIZES } from "../catalog.mts";
import { activeSkus, priceCents, unitCostCents, floorCents, AI_CENTS_PER_ORDER, STRIPE_FEES, marginCents } from "../pricing.mts";
import { inboxStatus } from "../inbox.mts";
import { FEATURES, NOT_APPLICABLE, adminSections } from "./capabilities.mts";
import type { Order } from "../store.mts";

export const DEFAULT_HEADLINE = "Portraits of your car, yacht or aircraft, drawn from your photograph";

type Check = { id: string; category: string; name: string; status: "ok" | "warn" | "fail" | "info"; message: string; details?: Record<string, string | number | boolean | null> };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

async function resendDomain() {
  const key = Netlify.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, status: "missing_key" as const, detail: "RESEND_API_KEY is not set" };
  const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) return { ok: true, status: "sending_only" as const, detail: "The store's Resend key is sending-only, so it can't list domains" };
  if (!res.ok) return { ok: false, status: "error" as const, detail: `Resend ${res.status}` };
  const data = await res.json();
  const dom = (data?.data ?? []).find((x: any) => x?.name === SITE_DOMAIN || String(x?.name ?? "").endsWith(`.${SITE_DOMAIN}`));
  return { ok: dom?.status === "verified", status: (dom?.status ?? "not_found") as string, detail: dom ? `${dom.name} ${dom.status}` : `${SITE_DOMAIN} isn't in the Resend team` };
}

export async function buildHealth(site: string, orders: Order[], settings: Settings) {
  const checks: Check[] = [];
  const production = Netlify.context?.deploy?.context === "production";

  // Payments
  if (!Netlify.env.get("STRIPE_SECRET_KEY")) {
    checks.push({ id: "stripe", category: "payments", name: "Stripe", status: "fail", message: "STRIPE_SECRET_KEY is not set" });
  } else {
    try {
      const bal = await cached("stripe-balance", 5 * 60_000, getBalance);
      const test = stripeTestMode();
      checks.push({ id: "stripe", category: "payments", name: "Stripe", status: test && production ? "warn" : "ok", message: `${bal.livemode ? "Live" : "Test"} mode, Burin & Co. account; cards saved at order and charged on approval`, details: { livemode: bal.livemode } });
    } catch (e) {
      // A key without Balance: Read can still take payments, so this is a warning, not a failure.
      checks.push({ id: "stripe", category: "payments", name: "Stripe", status: "warn", message: `Key set (${stripeTestMode() ? "test" : "live"}), but Stripe said: ${errText(e)}`, details: { missing: "Balance: Read" } });
    }
  }

  // Webhooks
  const wh = await webhookStatus();
  const paidOrders = orders.some((o) => o.paidAt);
  if (!Netlify.env.get("STRIPE_WEBHOOK_SECRET")) {
    checks.push({ id: "stripe-webhook", category: "webhooks", name: "Stripe webhook", status: "fail", message: "STRIPE_WEBHOOK_SECRET is not set: payments can't be confirmed" });
  } else {
    const failing = wh.lastFail && (!wh.lastOk || wh.lastFail.at > wh.lastOk.at);
    checks.push({
      id: "stripe-webhook", category: "webhooks", name: "Stripe webhook", status: failing ? "fail" : wh.failures24h ? "warn" : !wh.lastOk && paidOrders ? "warn" : "ok",
      message: wh.lastOk ? `Last event ${ago(wh.lastOk.at)} (${wh.lastOk.type}), ${wh.failures24h} failure${wh.failures24h === 1 ? "" : "s"} in 24h` : "No events received yet at /api/stripe/webhook",
      details: { endpoint: "/api/stripe/webhook", lastEventAt: wh.lastOk?.at ?? null, failures24h: wh.failures24h },
    });
  }

  // Fulfillment
  if (!Netlify.env.get("FINERWORKS_WEB_API_KEY") || !Netlify.env.get("FINERWORKS_APP_KEY")) {
    checks.push({ id: "finerworks", category: "fulfillment", name: "FinerWorks", status: "fail", message: "FinerWorks keys are not set" });
  } else if (!finerworksLive()) {
    checks.push({ id: "finerworks", category: "fulfillment", name: "FinerWorks", status: production ? "warn" : "info", message: "Test mode: orders sent to FinerWorks aren't printed (FINERWORKS_LIVE isn't true)" });
  } else {
    try {
      const card = await cached("finerworks-card", 60 * 60_000, savedPaymentToken);
      checks.push({ id: "finerworks-card", category: "fulfillment", name: "FinerWorks card on file", status: "ok", message: `Live orders, paid with ${card.label}`, details: { card: card.label } });
    } catch (e) {
      checks.push({ id: "finerworks-card", category: "fulfillment", name: "FinerWorks card on file", status: "fail", message: errText(e) });
    }
  }

  // Email: sending domain, outbox, inbound
  try {
    const dom = await cached("resend-domain", 60 * 60_000, resendDomain);
    checks.push({ id: "resend-domain", category: "email", name: "Resend sending domain", status: dom.status === "sending_only" ? "info" : dom.ok ? "ok" : "fail", message: dom.status === "sending_only" ? `Sending from ${SITE_DOMAIN}; HQ checks its DNS with its own Resend key` : dom.detail, details: { domain: SITE_DOMAIN, from: Netlify.env.get("FROM_EMAIL") ?? null, replyTo: supportAddress() } });
  } catch (e) {
    checks.push({ id: "resend-domain", category: "email", name: "Resend sending domain", status: "warn", message: errText(e) });
  }
  const inbound = await inboxStatus();
  checks.push(inbound);

  // AI
  const spent = await aiSpendThisMonth();
  const cap = settings.aiMonthlyCapCents;
  checks.push({
    id: "ai-replicate", category: "ai", name: "Replicate (AI renders)",
    status: !Netlify.env.get("REPLICATE_API_TOKEN") ? "fail" : spent >= cap ? "fail" : spent >= cap * 0.75 ? "warn" : "ok",
    message: !Netlify.env.get("REPLICATE_API_TOKEN") ? "REPLICATE_API_TOKEN is not set" : `$${(spent / 100).toFixed(2)} of the $${(cap / 100).toFixed(2)} monthly AI budget used. Model lab ${settings.labEnabled ? "on" : "off"}. No scheduled AI jobs.`,
    details: { spentCents: spent, capCents: cap, labEnabled: settings.labEnabled, model: Netlify.env.get("REPLICATE_MODEL") || "openai/gpt-image-2.5-sunburst" },
  });

  const outbox = await listOutbox();
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";

  return {
    site,
    generatedAt: new Date().toISOString(),
    status,
    checks,
    // One scheduled job: the FinerWorks sync. Renders and print files run when an order or an owner action needs them.
    jobs: [syncJobView(await lastSyncRun())],
    storefront: {
      maintenance: settings.maintenance,
      maintenanceReason: settings.maintenanceReason,
      headline: settings.headline ?? DEFAULT_HEADLINE,
      products: activeSkus().map((sku) => {
        const price = priceCents(sku, settings);
        return {
          sku, name: `${SIZES[sku].name} framed portrait`,
          price: price / 100,
          unitCost: (unitCostCents(sku, settings) + AI_CENTS_PER_ORDER) / 100,
          minPrice: floorCents(sku, settings) / 100,
          breakEven: floorCents(sku, settings) / 100,
        };
      }),
      fees: { percent: STRIPE_FEES.percent, fixed: STRIPE_FEES.fixedCents / 100 },
      pricing: {
        floorRule: "break-even after FinerWorks (with shipping), AI and Stripe fees",
        products: activeSkus().map((sku) => ({ sku, floor: floorCents(sku, settings) / 100, breakEven: floorCents(sku, settings) / 100, profitPerOrder: marginCents(sku, priceCents(sku, settings), settings) / 100 })),
      },
    },
    emailOutbox: { queued: outbox.length, failed: outbox.length },
    secretExpiresAt: null,
    capabilities: { version: 1, features: FEATURES, admin_sections: adminSections(), not_applicable: NOT_APPLICABLE },
  };
}

// §3b cash: Stripe balance, payouts, refunds and disputes. Missing key permissions are named, never shown as zeros.
export async function buildCash(orders: Order[]) {
  const errors: Record<string, string> = {};
  const missing: string[] = [];
  const attempt = async <T,>(name: string, perm: string, fn: () => Promise<T>) => {
    try { return await cached(`cash-${name}`, 10 * 60_000, fn); } catch (e) { errors[name] = errText(e); missing.push(perm); return null; }
  };
  const [bal, payouts, disputes] = await Promise.all([
    attempt("balance", "Balance: Read", getBalance),
    attempt("payouts", "Payouts: Read", () => listPayouts(20)),
    attempt("disputes", "Disputes: Read", () => listStripeDisputes(50)),
  ]);
  const usd = (l?: { amount: number; currency: string }[]) => (l ?? []).filter((x) => x.currency === "usd").reduce((t, x) => t + x.amount, 0);
  const since = Date.now() - 30 * 86_400_000;
  const refunded = orders.filter((o) => o.refundedAt && Date.parse(o.refundedAt) > since && o.livemode !== false);
  const open = (disputes?.data ?? []).filter((x) => !["won", "lost", "warning_closed", "charge_refunded"].includes(x.status));
  return {
    configured: true, money_unit: "cents", checked_at: new Date().toISOString(),
    status: missing.length ? (missing.length === 3 ? "error" : "partial") : "ok",
    missing_permissions: missing,
    balance: bal ? { available_cents: usd(bal.available), pending_cents: usd(bal.pending) } : null,
    payouts: payouts ? {
      upcoming: payouts.data.filter((p) => ["pending", "in_transit"].includes(p.status)).map((p) => ({ id: p.id, amount_cents: p.amount, arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10), status: p.status })),
      recent: payouts.data.filter((p) => p.status === "paid").slice(0, 10).map((p) => ({ id: p.id, amount_cents: p.amount, arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10), status: p.status })),
    } : null,
    refunds: { days: 30, count: refunded.length, amount_cents: refunded.reduce((t, o) => t + (o.refundedCents ?? 0), 0) },
    disputes: disputes ? { open: open.length, amount_cents: open.reduce((t, x) => t + x.amount, 0), needs_response: open.filter((x) => x.status.includes("needs_response")).length } : null,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}
