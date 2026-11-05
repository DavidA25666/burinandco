// Orders (§5), alerts (§4), ads attribution (§7), live now (§11) and the monthly report (§12).
// Pure functions: the endpoint passes in the data.
import type { Order } from "../store.mts";
import type { AiCall, Settings, Dispute, OutboxItem, WebhookEvent } from "../ops-store.mts";
import { nyDate, dateRange } from "../ops-store.mts";
import { SIZES, styleInfo } from "../catalog.mts";
import { isTest, isPaid, aiByOrder, orderMoney, shortName, shortId, itemName, isCommission, channelOf, paidDate, hoursBetween, finerworksActualCents } from "./economics.mts";
import { unitCostCents } from "../pricing.mts";

const d = (c: number) => Math.round(c) / 100;

// ---------- §5 orders ----------

const STATUS: Record<string, string> = {
  card_saved: "processing", paid: "processing", rendering: "processing", needs_review: "processing",
  proof_sent: "processing", changes_requested: "processing", customer_approved: "processing",
  render_failed: "failed", payment_due: "pending", sent_to_print: "fulfilled", refunded: "refunded",
};

const LABEL: Record<string, string> = {
  card_saved: "Card saved, rendering soon", paid: "Paid, rendering soon", rendering: "Rendering", render_failed: "Rendering failed",
  needs_review: "Ready for you to review", proof_sent: "Proof sent, waiting on customer", changes_requested: "Customer asked for changes",
  payment_due: "Approved, card declined: waiting on payment", customer_approved: "Approved and paid: send to print",
  sent_to_print: "Sent to FinerWorks", archived: "Archived", refunded: "Refunded",
};

/** Why an order needs a human right now, or null. */
export function orderIssue(o: Order, now = new Date().toISOString()): { status: "stuck" | "failed"; issue: string } | null {
  if (o.status === "render_failed") return { status: "failed", issue: `Rendering failed: ${o.lastError ?? "unknown error"}` };
  if (o.printStatus === "failed") return { status: "failed", issue: `Print file failed: ${o.printError ?? "unknown error"}` };
  const age = hoursBetween(o.updatedAt ?? o.createdAt, now);
  if (o.status === "needs_review" && age > 12) return { status: "stuck", issue: `New version waiting for review for ${Math.round(age)} h (proof promised within 48 h)` };
  if (o.status === "changes_requested" && age > 12) return { status: "stuck", issue: `Customer's change request waiting ${Math.round(age)} h` };
  if (o.status === "customer_approved" && age > 24) return { status: "stuck", issue: `Approved and paid ${Math.round(age)} h ago, not sent to FinerWorks yet` };
  if (o.status === "rendering" && age > 1) return { status: "stuck", issue: "Rendering has run for over an hour; retry it" };
  return null;
}

/** Where the print is: FinerWorks' own status and tracking once it reports them. */
export function fulfillmentInfo(o: Order) {
  const fw = o.finerworks;
  const ship = fw?.shipments?.find((s) => s.trackingNumber || s.trackingUrl) ?? null;
  const state = o.status === "sent_to_print" || (o.status === "archived" && o.sentToPrintAt)
    ? ship?.deliveredAt ? "delivered" : ship ? "shipped" : "in_production"
    : o.status === "customer_approved" ? "awaiting_print" : o.paidAt ? "awaiting_print" : "not_started";
  return {
    state, vendor: fw ? "FinerWorks" : o.printOrderRef ? "manual" : null, vendor_ref: o.printOrderRef ?? null,
    vendor_status: fw?.status ?? null, test: fw?.testMode ?? false, checked_at: fw?.checkedAt ?? null,
    tracking_number: ship?.trackingNumber ?? null, tracking_url: ship?.trackingUrl ?? null, carrier: ship?.carrier ?? null,
    shipped_at: ship?.shippedAt ?? null, delivered_at: ship?.deliveredAt ?? null,
  };
}

export function orderActions(o: Order) {
  const a: string[] = [];
  if (o.status === "render_failed" || o.printStatus === "failed") a.push("retry_order");
  if (o.status !== "refunded" && o.status !== "archived" && (o.paymentIntentId || !o.paidAt) && isCommission(o)) a.push("refund_order");
  return a;
}

export function orderRow(o: Order, s: Settings, ai: Map<string, number>, now?: string) {
  const issue = orderIssue(o, now);
  const m = orderMoney(o, s, ai);
  return {
    id: shortId(o),
    order_id: o.id,
    customer: shortName(o.customer.name),
    email: o.customer.email,
    item: itemName(o),
    amount: d(o.price),
    status: issue?.status ?? (o.status === "archived" ? (o.sentToPrintAt ? "fulfilled" : o.paidAt ? "fulfilled" : "refunded") : STATUS[o.status] ?? "pending"),
    orderStatus: o.status,
    status_label: LABEL[o.status] ?? o.status,
    issue: issue?.issue ?? null,
    createdAt: o.createdAt,
    created_at: o.createdAt,
    paidAt: o.paidAt ?? null,
    paid_at: o.paidAt ?? null,
    updatedAt: o.updatedAt ?? o.createdAt,
    scheduledFor: null,
    is_test: isTest(o, s),
    livemode: o.livemode !== false,
    actions: orderActions(o),
    refunded_cents: o.refundedCents ?? 0,
    refunded_at: o.refundedAt ?? null,
    refund_status: !o.refundedCents ? "none" : o.refundedCents >= o.price ? "full" : "partial",
    fulfillment: fulfillmentInfo(o),
    economics: {
      money_unit: "cents", fees_cents: m.fees, fulfillment_cents: m.fulfillment, ai_cents: m.ai, discount_cents: 0, refunds_cents: m.refunds,
      profit_cents: isPaid(o) ? m.profit : null,
      fees_source: m.feesActual ? "actual" : "estimated",
      fulfillment_source: m.fulfillmentActual ? "actual" : "estimated",
      ai_source: "estimated",
      estimated: !(m.feesActual && m.fulfillmentActual),
    },
  };
}

export function ordersView(orders: Order[], s: Settings, aiCalls: AiCall[], q: URLSearchParams) {
  const ai = aiByOrder(aiCalls);
  const now = new Date().toISOString();
  let rows = orders.filter(isCommission).map((o) => orderRow(o, s, ai, now));
  const status = q.get("status");
  if (status) {
    const want = new Set(status.split(",").flatMap((x) => (x === "attention" ? ["stuck", "failed"] : [x.trim()])));
    rows = rows.filter((r) => want.has(r.status));
  }
  // Stuck and failed first, then newest first.
  rows.sort((a, b) => Number(b.status === "stuck" || b.status === "failed") - Number(a.status === "stuck" || a.status === "failed") || b.createdAt.localeCompare(a.createdAt));
  const limit = Math.min(Math.max(Number(q.get("limit")) || (status ? 500 : 50), 1), 500);
  const start = Math.max(Number(q.get("cursor") ?? q.get("starting_after_index") ?? 0) || 0, 0);
  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return { orders: page, hasMore, nextCursor: hasMore ? String(start + limit) : null, total: rows.length };
}

// ---------- §4 alerts ----------

export interface AlertInput {
  orders: Order[];
  settings: Settings;
  aiMonthCents: number;
  webhook: { lastOk: WebhookEvent | null; lastFail: WebhookEvent | null; failures24h: number };
  disputes: Dispute[];
  outbox: OutboxItem[];
  production: boolean;
  env: Record<string, boolean>;
  finerworksLive: boolean;
  aiCalls?: AiCall[];
}

// Severity follows HQ's rules. critical: only what stops sales or loses real money (checkout or
// payments down, an order losing $1 or more, 3+ losing orders in 7 days, a vendor declining the card,
// a chargeback). warning: needs action soon. info: everything else, including things off on purpose.
// One-off losses under $1 are info and drop off after 7 days. Cost variance alerts only when the real
// cost is more than 5% above the model.
const SALES_CRITICAL_ENV = new Set(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SITE_SECRET"]);
const DAY = 86_400_000;

export function buildAlerts(i: AlertInput) {
  const alerts: { id: string; severity: "critical" | "warning" | "info"; source: string; title: string; detail: string; createdAt: string }[] = [];
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const ai = aiByOrder(i.aiCalls ?? []);
  const losing: Order[] = [];
  for (const o of i.orders) {
    if (isTest(o, i.settings) && i.production) continue;
    const who = `${shortName(o.customer.name)} (${shortId(o)})`;
    const at = o.updatedAt ?? o.createdAt;
    if (o.status === "render_failed") alerts.push({ id: `render-failed-${o.id}`, severity: "warning", source: "Replicate", title: `Rendering failed for ${who}`, detail: `${o.lastError ?? "Unknown error"}. Use Retry on the order in HQ.`, createdAt: at });
    if (o.printStatus === "failed") alerts.push({ id: `print-failed-${o.id}`, severity: "warning", source: "Print file", title: `Print file failed for ${who}`, detail: `${o.printError ?? "Unknown error"}. Use Retry on the order in HQ.`, createdAt: at });
    if (o.status === "needs_review") alerts.push({ id: `review-${o.id}-v${o.renders.length}`, severity: "warning", source: "Orders", title: `Review v${o.renders.length} for ${who}`, detail: `Compare it with the photo, then Send proof or Regenerate in HQ (Admin → Orders). Proofs are promised within 48 hours${hoursBetween(o.createdAt, now) > 36 ? "; this one is past 36 hours" : ""}.`, createdAt: at });
    if (o.status === "changes_requested") alerts.push({ id: `changes-${o.id}-${o.changeRequests.length}`, severity: "warning", source: "Customer", title: `${who} asked for changes`, detail: `"${(o.changeRequests.at(-1)?.note ?? "").slice(0, 160)}". Regenerate with a note in HQ.`, createdAt: o.changeRequests.at(-1)?.at ?? at });
    if (o.status === "customer_approved" && !o.finerworksError) alerts.push({ id: `approved-${o.id}`, severity: "warning", source: "Orders", title: `${who} approved and paid: send to print`, detail: "Make the print file, then Send to FinerWorks in HQ.", createdAt: at });
    if (o.status === "payment_due") alerts.push({ id: `payment-due-${o.id}`, severity: hoursBetween(at, now) > 72 ? "warning" : "info", source: "Stripe", title: `${who} approved, but the saved card was declined`, detail: "They were sent to a payment page. Nothing ships until they pay.", createdAt: at });
    if (o.status === "rendering" && hoursBetween(at, now) > 1) alerts.push({ id: `render-stuck-${o.id}`, severity: "warning", source: "Replicate", title: `Rendering stuck for ${who}`, detail: "It has run for over an hour. Use Retry or Regenerate in HQ.", createdAt: at });

    // FinerWorks refused the order. A declined card stops every print, so it's critical.
    if (o.finerworksError && o.status === "customer_approved") {
      const card = /card|payment|declin|insufficient|billing|credit/i.test(o.finerworksError.message);
      alerts.push({ id: `finerworks-failed-${o.id}`, severity: card ? "critical" : "warning", source: "FinerWorks", title: card ? `FinerWorks declined the card for ${who}` : `FinerWorks didn't take the order for ${who}`, detail: `${o.finerworksError.message.slice(0, 220)}. ${card ? "Check the card under Billing & Payment in FinerWorks, then" : "Fix it, then"} use Send to FinerWorks again.`, createdAt: o.finerworksError.at });
    }

    if (o.paidAt) {
      const m = orderMoney(o, i.settings, ai);
      const fullyRefunded = (o.refundedCents ?? 0) >= o.price;
      const paidMs = Date.parse(o.paidAt);
      if (m.profit < 0 && !fullyRefunded) {
        if (nowMs - paidMs <= 7 * DAY) losing.push(o);
        const loss = -m.profit;
        if (loss >= 100) alerts.push({ id: `loss-${o.id}`, severity: "critical", source: "Unit economics", title: `${who} lost $${d(loss).toFixed(2)}`, detail: `Revenue $${d(m.revenue - m.refunds).toFixed(2)}; Stripe $${d(m.fees).toFixed(2)}${m.feesActual ? "" : " (est.)"}, FinerWorks $${d(m.fulfillment).toFixed(2)}${m.fulfillmentActual ? "" : " (est.)"}, AI $${d(m.ai).toFixed(2)}. Check the price and any partial refund.`, createdAt: o.paidAt });
        else if (nowMs - paidMs <= 7 * DAY) alerts.push({ id: `loss-small-${o.id}`, severity: "info", source: "Unit economics", title: `${who} lost $${d(loss).toFixed(2)}`, detail: "Under $1. This clears by itself after 7 days.", createdAt: o.paidAt });
      }
      // Real FinerWorks cost more than 5% above the model for that size.
      const actual = finerworksActualCents(o);
      const model = unitCostCents(o.size, i.settings);
      if (actual != null && actual > model * 1.05) alerts.push({ id: `cost-variance-${o.id}`, severity: "warning", source: "FinerWorks", title: `FinerWorks charged $${d(actual).toFixed(2)} for ${who}, ${Math.round((actual / model - 1) * 100)}% over the model`, detail: `The model for ${SIZES[o.size]?.name ?? o.size} is $${d(model).toFixed(2)}. Update the FinerWorks cost in HQ (Admin → Store settings) if prices went up.`, createdAt: o.finerworks?.checkedAt ?? at });
    }
  }
  if (losing.length >= 3) alerts.push({ id: `losing-streak-${nyDate()}`, severity: "critical", source: "Unit economics", title: `${losing.length} orders lost money in the last 7 days`, detail: `${losing.map((o) => shortId(o)).join(", ")}. Check prices against FinerWorks costs.`, createdAt: now });

  const cap = i.settings.aiMonthlyCapCents;
  if (cap > 0 && i.aiMonthCents >= cap) alerts.push({ id: `ai-cap-100-${nyDate().slice(0, 7)}`, severity: i.settings.aiCapBlocksOrders ? "critical" : "warning", source: "AI spend", title: "Monthly AI budget used up", detail: `$${d(i.aiMonthCents).toFixed(2)} of $${d(cap).toFixed(2)} this month. The model lab is blocked${i.settings.aiCapBlocksOrders ? ", and so are regenerations and print upscales" : "; customer renders still run"}. Raise the cap in HQ (Admin → AI spend).`, createdAt: now });
  else if (cap > 0 && i.aiMonthCents >= cap * 0.75) alerts.push({ id: `ai-cap-75-${nyDate().slice(0, 7)}`, severity: "warning", source: "AI spend", title: "AI spend passed 75% of this month's budget", detail: `$${d(i.aiMonthCents).toFixed(2)} of $${d(cap).toFixed(2)}.`, createdAt: now });
  const wf = i.webhook;
  if (wf.lastFail && (!wf.lastOk || wf.lastFail.at > wf.lastOk.at)) alerts.push({ id: "stripe-webhook-failing", severity: "critical", source: "Stripe", title: "Stripe webhook is failing", detail: `Last failure ${wf.lastFail.at} on ${wf.lastFail.type}: ${wf.lastFail.error ?? "error"}.`, createdAt: wf.lastFail.at });
  for (const dsp of i.disputes) if (!["won", "lost", "warning_closed", "charge_refunded"].includes(dsp.status)) {
    alerts.push({ id: `dispute-${dsp.id}`, severity: "critical", source: "Stripe", title: `Chargeback opened: $${d(dsp.amountCents).toFixed(2)}`, detail: `Reason: ${dsp.reason ?? "unknown"}. Respond in Stripe before the deadline.`, createdAt: dsp.createdAt });
  }
  if (i.outbox.length) alerts.push({ id: "email-outbox", severity: "warning", source: "Resend", title: `${i.outbox.length} email${i.outbox.length > 1 ? "s" : ""} failed to send`, detail: `Latest: "${i.outbox.at(-1)!.subject}" (${i.outbox.at(-1)!.lastError.slice(0, 120)}). Use Flush email outbox in HQ.`, createdAt: i.outbox.at(-1)!.at });
  if (i.production) {
    for (const [name, ok] of Object.entries(i.env)) if (!ok) alerts.push({ id: `env-${name}`, severity: SALES_CRITICAL_ENV.has(name) ? "critical" : "warning", source: "Netlify", title: `${name} is not set`, detail: `Set ${name} in Netlify → Project configuration → Environment variables (Production), then redeploy.`, createdAt: now });
    if (!i.finerworksLive) alerts.push({ id: "finerworks-test-mode", severity: "warning", source: "FinerWorks", title: "FinerWorks is in test mode", detail: "Orders sent to FinerWorks are not printed. Set FINERWORKS_LIVE=true in Netlify.", createdAt: now });
  }
  return { alerts };
}

// ---------- §7 attribution ----------

export function attributionView(site: string, orders: Order[], s: Settings, aiCalls: AiCall[], from: string, to: string) {
  const ai = aiByOrder(aiCalls);
  const paid = orders.filter((o) => !isTest(o, s) && isPaid(o)).sort((a, b) => a.paidAt!.localeCompare(b.paidAt!));
  const seen = new Set<string>();
  const rows = new Map<string, any>();
  for (const o of paid) {
    const email = o.customer.email.toLowerCase();
    const first = !seen.has(email);
    seen.add(email);
    const pd = paidDate(o)!;
    if (pd < from || pd > to) continue;
    const u = o.utm?.last ?? o.utm?.first ?? null;
    const src = u?.source ? u.source.toLowerCase() : u?.referrer ? channelOf(u) : "(direct)";
    const key = `${src}|${u?.campaign ?? ""}|${u?.content ?? ""}`;
    const r = rows.get(key) ?? { utmSource: src, utmMedium: u?.medium ?? null, utmCampaign: u?.campaign ?? null, utmContent: u?.content ?? null, orders: 0, newCustomers: 0, cards: 0, revenue: 0, profit: 0, avgCards: 0, repeatOrders: 0 };
    const m = orderMoney(o, s, ai);
    r.orders++; r.cards++; if (first) r.newCustomers++; else r.repeatOrders++;
    r.revenue += m.revenue - m.refunds; r.profit += m.profit;
    rows.set(key, r);
  }
  return {
    site, from, to, currency: "USD", test_orders_excluded: true,
    model: "last landing UTM before the order (first landing kept 30 days as a fallback); cards = framed prints",
    rows: [...rows.values()].map((r) => ({ ...r, revenue: d(r.revenue), profit: d(r.profit), avgCards: r.orders ? r.cards / r.orders : 0, utm_source: r.utmSource, utm_medium: r.utmMedium, utm_campaign: r.utmCampaign, utm_content: r.utmContent, new_customers: r.newCustomers, repeat_orders: r.repeatOrders })),
  };
}

// ---------- §11 live ----------

export function liveView(orders: Order[], s: Settings, visitors5m: number) {
  const today = nyDate();
  const real = orders.filter((o) => !isTest(o, s));
  const hourAgo = Date.now() - 3_600_000;
  const paidToday = real.filter((o) => o.paidAt && nyDate(o.paidAt) === today);
  const events: { at: string; type: string; label: string; region: string | null }[] = [];
  for (const o of real) {
    const region = o.shipping?.address?.state ?? o.buyerGeo?.region ?? null;
    const what = `${styleInfo(o.style).name} · ${SIZES[o.size]?.name ?? o.size}`;
    if (isCommission(o)) events.push({ at: o.createdAt, type: "checkout", label: `Commission placed · ${what}`, region });
    else if (Date.parse(o.createdAt) > hourAgo) events.push({ at: o.createdAt, type: "cart", label: `Checkout started · ${what}`, region });
    if (o.paidAt) events.push({ at: o.paidAt, type: "order", label: `Proof approved and paid · ${what}`, region });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return {
    as_of: new Date().toISOString(), money_unit: "cents",
    visitors_5m: visitors5m,
    active_checkouts: real.filter((o) => o.status === "awaiting_card" && Date.parse(o.createdAt) > hourAgo).length,
    orders_today: paidToday.length,
    commissions_today: real.filter((o) => isCommission(o) && nyDate(o.createdAt) === today).length,
    revenue_today_cents: paidToday.reduce((t, o) => t + o.price, 0),
    events: events.slice(0, 20),
  };
}

// ---------- §12 monthly report ----------

export function reportView(orders: Order[], s: Settings, aiCalls: AiCall[], month: string) {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const ai = aiByOrder(aiCalls);
  const real = orders.filter((o) => !isTest(o, s));
  const paid = real.filter((o) => { const pd = paidDate(o); return pd && pd >= from && pd <= to; });
  const refunds = real.filter((o) => o.refundedAt && nyDate(o.refundedAt) >= from && nyDate(o.refundedAt) <= to).reduce((t, o) => t + (o.refundedCents ?? 0), 0);
  const revenue = paid.reduce((t, o) => t + o.price, 0);
  const fees = paid.reduce((t, o) => t + orderMoney(o, s, ai).fees, 0);
  const fulfillment = paid.reduce((t, o) => t + orderMoney(o, s, ai).fulfillment, 0);
  const days = new Set(dateRange(from, to));
  const aiCents = aiCalls.filter((c) => days.has(c.date) && c.purpose !== "lab").reduce((t, c) => t + c.cents, 0);
  const labCents = aiCalls.filter((c) => days.has(c.date) && c.purpose === "lab").reduce((t, c) => t + c.cents, 0);
  const byState = new Map<string, { state: string; orders: number; revenue_cents: number; tax_cents: number; shipping_cents: number }>();
  for (const o of paid) {
    const st = o.shipping?.address?.state ?? "unknown";
    const e = byState.get(st) ?? { state: st, orders: 0, revenue_cents: 0, tax_cents: 0, shipping_cents: 0 };
    e.orders++; e.revenue_cents += o.price; byState.set(st, e);
  }
  const net = revenue - refunds - fees - fulfillment - aiCents;
  return {
    month, money_unit: "cents", generated_at: new Date().toISOString(), test_orders_excluded: true,
    revenue_cents: revenue,
    summary: { revenue_cents: revenue, orders: paid.length, refunds_cents: refunds, fees_cents: fees, fulfillment_cents: fulfillment, ai_cents: aiCents, net_cents: net },
    lines: [
      { account: "Sales", amount_cents: revenue },
      { account: "Refunds", amount_cents: -refunds },
      { account: "Merchant fees (Stripe)", amount_cents: -fees },
      { account: "Cost of goods: printing and framing (FinerWorks, estimated)", amount_cents: -fulfillment },
      { account: "Cost of goods: AI renders (Replicate, estimated)", amount_cents: -aiCents },
      ...(labCents ? [{ account: "Development: AI model tests (Replicate)", amount_cents: -labCents }] : []),
    ],
    sales_by_state: [...byState.values()].sort((a, b) => b.revenue_cents - a.revenue_cents),
    quickbooks: { lines: [
      { date: to, account: "Sales", description: "Framed portrait sales (Stripe)", amount_cents: revenue },
      { date: to, account: "Refunds", description: "Customer refunds", amount_cents: -refunds },
      { date: to, account: "Merchant fees", description: "Stripe fees", amount_cents: -fees },
      { date: to, account: "Cost of goods sold", description: "FinerWorks printing, framing and shipping (estimated)", amount_cents: -fulfillment },
      { date: to, account: "Cost of goods sold", description: "Replicate AI renders (estimated)", amount_cents: -aiCents },
      ...(labCents ? [{ date: to, account: "Software development", description: "Replicate model tests", amount_cents: -labCents }] : []),
    ] },
    note: "Sales tax is not collected at checkout; tax_cents is 0. Shipping is included in the price.",
  };
}
