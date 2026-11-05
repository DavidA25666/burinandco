// Per-order money for Tenfold HQ: revenue, Stripe fees, FinerWorks cost, AI cost and profit, in cents.
// Pure functions over orders, the AI ledger and settings, so they can be tested without Netlify.
import type { Order } from "../store.mts";
import type { AiCall, Settings } from "../ops-store.mts";
import { nyDate } from "../ops-store.mts";
import { feeCents, unitCostCents } from "../pricing.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../catalog.mts";

export const ORDER_AI: AiCall["purpose"][] = ["order", "regeneration", "upscale"];

/**
 * Test orders, left out of every number HQ shows: "Mark as test" in HQ (either way) wins; then
 * Stripe test keys, the owners' own emails, and any order refunded in full within 24 hours of payment.
 */
export function isTest(o: Order, s: Settings) {
  if (o.testOverride != null) return o.testOverride;
  if (o.livemode === false) return true;
  const email = o.customer.email.toLowerCase();
  if (s.ownerTestEmails.some((e) => e.toLowerCase() === email)) return true;
  return refundedWithinADay(o);
}

export function refundedWithinADay(o: Order) {
  if (!o.paidAt || !o.refundedAt || (o.refundedCents ?? 0) < o.price) return false;
  return Date.parse(o.refundedAt) - Date.parse(o.paidAt) <= 24 * 3_600_000;
}

export const isPaid = (o: Order) => !!o.paidAt;

export function aiByOrder(calls: AiCall[]) {
  const m = new Map<string, number>();
  for (const c of calls) if (c.orderId && ORDER_AI.includes(c.purpose)) m.set(c.orderId, (m.get(c.orderId) ?? 0) + c.cents);
  return m;
}

export interface OrderMoney { revenue: number; refunds: number; fees: number; feesActual: boolean; fulfillment: number; fulfillmentActual: boolean; ai: number; profit: number }

/** What FinerWorks actually charged, once it reports the order total (live orders only). */
export const finerworksActualCents = (o: Order) => (o.finerworks && !o.finerworks.testMode && o.finerworks.costCents != null ? o.finerworks.costCents : null);

export function orderMoney(o: Order, s: Settings, ai: Map<string, number>): OrderMoney {
  const paid = isPaid(o);
  const revenue = paid ? o.price : 0;
  const refunds = o.refundedCents ?? 0;
  const feesActual = o.stripeFeeCents != null;
  const fees = paid ? o.stripeFeeCents ?? feeCents(o.price) : 0;
  // FinerWorks is only paid for orders that are (or will be) printed: not for ones refunded before print.
  const printed = !!o.sentToPrintAt || o.status === "sent_to_print";
  // The model cost (FinerWorks price with ground shipping, per size) is an estimate until FinerWorks
  // reports what it charged for the order; that real amount then replaces it.
  const actual = finerworksActualCents(o);
  const charged = paid && (printed || o.status !== "refunded") && !(o.finerworks?.testMode && printed);
  const fulfillment = charged ? actual ?? unitCostCents(o.size, s) : 0;
  const aiCents = ai.get(o.id) ?? 0;
  return { revenue, refunds, fees, feesActual, fulfillment, fulfillmentActual: charged && actual != null, ai: aiCents, profit: revenue - refunds - fees - fulfillment - aiCents };
}

export const paidDate = (o: Order) => (o.paidAt ? nyDate(o.paidAt) : null);

export function shortName(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0]?.toUpperCase() : "";
  return last ? `${first} ${last}.` : first || "Customer";
}

export const shortId = (o: Order) => `BC-${o.id.slice(0, 6).toUpperCase()}`;

export const itemName = (o: Order) => `${styleInfo(o.style).name} ${categoryInfo(o.category).subject} portrait · ${SIZES[o.size]?.name ?? o.size}, ${(FRAMES[o.frame] ?? o.frame).toLowerCase()}`;

/** A commission that got as far as a saved card (or an old prepaid order). Unfinished checkouts don't count. */
export const isCommission = (o: Order) => o.status !== "awaiting_card" && o.status !== "awaiting_payment";

export function channelOf(u: { source: string | null; medium?: string | null; referrer?: string | null } | null | undefined) {
  if (!u) return "direct";
  if (u.source) return u.source.toLowerCase();
  if (u.referrer) {
    const r = u.referrer.toLowerCase();
    if (/google\./.test(r)) return "google";
    if (/bing\./.test(r)) return "bing";
    if (/facebook\.|fb\./.test(r)) return "facebook";
    if (/instagram\./.test(r)) return "instagram";
    return r.replace(/^www\./, "");
  }
  return "direct";
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
};

export const hoursBetween = (a: string, b: string) => Math.round(((Date.parse(b) - Date.parse(a)) / 3_600_000) * 10) / 10;
