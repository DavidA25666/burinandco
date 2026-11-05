// GET /api/ops/metrics (contract §3, §3b, §3c). Pure: all inputs are passed in.
import type { Order, Utm } from "../store.mts";
import type { AiCall, Settings } from "../ops-store.mts";
import { dateRange, addDays, nyDate } from "../ops-store.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../catalog.mts";
import { unitCostCents, STRIPE_FEES } from "../pricing.mts";
import { finerworksActualCents } from "./economics.mts";
import {
  isTest, isPaid, aiByOrder, orderMoney, paidDate, isCommission, channelOf, median, pct, hoursBetween, ORDER_AI,
} from "./economics.mts";

export interface MetricsInput {
  site: string;
  orders: Order[];
  aiCalls: AiCall[];
  visits: { date: string; source: string }[];
  settings: Settings;
  from: string;
  to: string;
  today?: string;
  fixedCosts?: { name: string; amount: number }[];
}

const d = (cents: number) => Math.round(cents) / 100;
const inRange = (date: string | null, from: string, to: string) => !!date && date >= from && date <= to;
const PROOF_PROMISE_HOURS = 48;

export function buildMetrics(i: MetricsInput) {
  const today = i.today ?? nyDate();
  const real = i.orders.filter((o) => !isTest(o, i.settings));
  const ai = aiByOrder(i.aiCalls);
  const days = dateRange(i.from, i.to);
  const money = new Map(real.map((o) => [o.id, orderMoney(o, i.settings, ai)]));

  // ----- daily -----
  const blank = () => ({ visits: 0, orders: 0, revenue: 0, refunds: 0, fees: 0, fulfillmentCost: 0, aiCost: 0 });
  const byDay = new Map(days.map((day) => [day, blank()]));
  for (const v of i.visits) { const row = byDay.get(v.date); if (row) row.visits++; }
  for (const o of real) {
    const m = money.get(o.id)!;
    const pd = paidDate(o);
    const row = pd ? byDay.get(pd) : undefined;
    if (row) { row.orders++; row.revenue += m.revenue; row.fees += m.fees; row.fulfillmentCost += m.fulfillment; }
    const rd = o.refundedAt ? nyDate(o.refundedAt) : null;
    const rrow = rd ? byDay.get(rd) : undefined;
    if (rrow) rrow.refunds += m.refunds;
  }
  // AI is counted on the day it was spent (renders happen days before the card is charged).
  const realIds = new Set(real.map((o) => o.id));
  for (const c of i.aiCalls) {
    if (!ORDER_AI.includes(c.purpose) || (c.orderId && !realIds.has(c.orderId))) continue;
    const row = byDay.get(c.date);
    if (row) row.aiCost += c.cents;
  }
  const daily = days.map((date) => {
    const r = byDay.get(date)!;
    const profit = r.revenue - r.refunds - r.fees - r.fulfillmentCost - r.aiCost;
    return { date, visits: r.visits, orders: r.orders, revenue: d(r.revenue), refunds: d(r.refunds), fees: d(r.fees), fulfillmentCost: d(r.fulfillmentCost), aiCost: d(r.aiCost), profit: d(profit) };
  });
  const sum = (k: keyof ReturnType<typeof blank>) => days.reduce((s, day) => s + byDay.get(day)![k], 0);
  const T = { visits: sum("visits"), orders: sum("orders"), revenue: sum("revenue"), refunds: sum("refunds"), fees: sum("fees"), fulfillment: sum("fulfillmentCost"), ai: sum("aiCost") };
  const profitC = T.revenue - T.refunds - T.fees - T.fulfillment - T.ai;

  // ----- customers -----
  const paidAll = real.filter(isPaid).sort((a, b) => a.paidAt!.localeCompare(b.paidAt!));
  const byEmail = new Map<string, Order[]>();
  for (const o of paidAll) {
    const e = o.customer.email.toLowerCase();
    byEmail.set(e, [...(byEmail.get(e) ?? []), o]);
  }
  const paidInRange = paidAll.filter((o) => inRange(paidDate(o), i.from, i.to));
  let newCustomers = 0, returningCustomers = 0;
  for (const o of paidInRange) {
    const first = byEmail.get(o.customer.email.toLowerCase())![0];
    if (first.id === o.id) newCustomers++; else returningCustomers++;
  }

  // ----- sources and products -----
  const sources = new Map<string, { visits: number; orders: number; revenue: number }>();
  for (const v of i.visits) if (inRange(v.date, i.from, i.to)) {
    const s = sources.get(v.source) ?? { visits: 0, orders: 0, revenue: 0 };
    s.visits++; sources.set(v.source, s);
  }
  for (const o of paidInRange) {
    const key = channelOf(o.utm?.first);
    const s = sources.get(key) ?? { visits: 0, orders: 0, revenue: 0 };
    s.orders++; s.revenue += o.price; sources.set(key, s);
  }
  const products = new Map<string, { units: number; revenue: number }>();
  for (const o of paidInRange) {
    const name = `${SIZES[o.size]?.name ?? o.size} framed portrait`;
    const p = products.get(name) ?? { units: 0, revenue: 0 };
    p.units++; p.revenue += o.price; products.set(name, p);
  }

  const commissionsInRange = real.filter((o) => isCommission(o) && inRange(nyDate(o.createdAt), i.from, i.to));
  const launch = paidAll[0]?.paidAt ? nyDate(paidAll[0].paidAt) : null;

  const out: Record<string, unknown> = {
    site: i.site,
    from: i.from,
    to: i.to,
    currency: "USD",
    test_orders_excluded: true,
    totals: {
      visits: T.visits, orders: T.orders, revenue: d(T.revenue), refunds: d(T.refunds), fees: d(T.fees),
      fulfillmentCost: d(T.fulfillment), aiCost: d(T.ai), profit: d(profitC),
      aov: T.orders ? d(T.revenue / T.orders) : 0,
      conversion: T.visits ? Math.round((T.orders / T.visits) * 10000) / 10000 : null,
      newCustomers, returningCustomers,
    },
    daily,
    sources: [...sources.entries()].map(([source, s]) => ({ source, visits: s.visits, orders: s.orders, revenue: d(s.revenue) })).sort((a, b) => b.visits + b.orders - (a.visits + a.orders)),
    products: [...products.entries()].map(([name, p]) => ({ name, units: p.units, revenue: d(p.revenue) })),
    // Burin charges when the customer approves the proof, so the funnel runs visit → commission → proof → paid.
    funnel: [
      { flow: "commission", label: "Commission (card saved, charged on approval)", steps: [
        { step: "landing", sessions: T.visits },
        { step: "checkout_started", sessions: real.filter((o) => inRange(nyDate(o.createdAt), i.from, i.to)).length },
        { step: "card_saved", sessions: commissionsInRange.length },
        { step: "proof_sent", sessions: commissionsInRange.filter((o) => o.proofSentAt || o.renders.length).length },
        { step: "paid", sessions: commissionsInRange.filter(isPaid).length },
      ] },
    ],
    ...(launch ? { launch_date: launch } : {}),
    customers: (() => {
      const customers = byEmail.size;
      const repeat = [...byEmail.values()].filter((l) => l.length > 1).length;
      return { window: "all_time", customers, repeat_customers: repeat, repeat_rate: customers ? Math.round((repeat / customers) * 10000) / 10000 : 0, paid_orders: paidAll.length, test_orders_excluded: true, definition: "distinct buyer email with a paid order; one checkout = one order; repeat = 2+ paid orders" };
    })(),
    unit_economics: (() => {
      const fixed = i.fixedCosts ?? [];
      const anyEstimatedFees = paidInRange.some((o) => o.stripeFeeCents == null);
      const anyEstimatedFulfillment = paidInRange.some((o) => finerworksActualCents(o) == null);
      const lines = paidInRange.length * 3;
      const actualLines = paidInRange.reduce((t, o) => t + (o.stripeFeeCents != null ? 1 : 0) + (finerworksActualCents(o) != null ? 1 : 0), 0);
      return {
        money_unit: "cents",
        orders: T.orders, revenue: T.revenue, stripe_fees: T.fees, fulfillment_cost: T.fulfillment, ai_cost: T.ai,
        discounts: 0, refunds: T.refunds,
        contribution: profitC, contribution_per_order: T.orders ? Math.round(profitC / T.orders) : 0,
        fixed_costs: fixed, marketing_spend: 0,
        net_profit: profitC - fixed.reduce((s, f) => s + f.amount, 0),
        sources: { stripe_fees: anyEstimatedFees ? "estimated" : "actual", fulfillment_cost: anyEstimatedFulfillment ? "estimated" : "actual", ai_cost: "estimated", revenue: "actual" },
        cost_source_coverage: lines ? Math.round((actualLines / lines) * 100) / 100 : 0,
        ...(launch ? { launch_date: launch } : {}),
      };
    })(),
    geo: buildGeo(paidInRange),
    cohorts: buildCohorts(byEmail, today),
    attribution: buildChannels(paidAll, byEmail, i, money),
    fulfillment: buildFulfillment(real, i.from, i.to, today),
    mix: buildMix(paidInRange, ai, i.settings),
    seo: { search_console: { configured: false, message: "Search Console isn't connected to the store yet. Add burinandco.com in Search Console and connect it in HQ." } },
  };
  return out;
}

// ----- §3 geo -----
function buildGeo(paid: Order[]) {
  const agg = (rows: { city: string | null; region: string | null; country: string | null; lat?: number | null; lng?: number | null; cents: number }[]) => {
    const m = new Map<string, { city: string | null; region: string | null; country: string | null; lat: number | null; lng: number | null; orders: number; revenue_cents: number }>();
    for (const r of rows) {
      const k = `${r.city}|${r.region}|${r.country}`;
      const e = m.get(k) ?? { city: r.city, region: r.region, country: r.country, lat: r.lat ?? null, lng: r.lng ?? null, orders: 0, revenue_cents: 0 };
      e.orders++; e.revenue_cents += r.cents; m.set(k, e);
    }
    return [...m.values()].map((e) => ({ ...e, ...(e.lat == null ? { lat: undefined, lng: undefined } : {}) }));
  };
  const buyers = agg(paid.filter((o) => o.buyerGeo?.region || o.buyerGeo?.city).map((o) => ({ ...o.buyerGeo!, cents: o.price })));
  const recipients = agg(paid.filter((o) => o.shipping?.address?.state).map((o) => ({ city: o.shipping!.address.city, region: o.shipping!.address.state, country: o.shipping!.address.country || "US", cents: o.price })));
  const states = (list: typeof buyers, kind: string) => {
    const m = new Map<string, { region: string; country: string; orders: number; revenue_cents: number; kind: string }>();
    for (const r of list) if (r.region) {
      const e = m.get(r.region) ?? { region: r.region, country: r.country ?? "US", orders: 0, revenue_cents: 0, kind };
      e.orders += r.orders; e.revenue_cents += r.revenue_cents; m.set(r.region, e);
    }
    return [...m.values()].sort((a, b) => b.orders - a.orders);
  };
  const cities = (list: typeof buyers) => list.filter((r) => r.city).map((r) => ({ city: r.city, region: r.region, orders: r.orders })).sort((a, b) => b.orders - a.orders).slice(0, 10);
  return {
    version: 1, money_unit: "cents",
    buyers, recipients,
    top_states: [...states(buyers, "buyers"), ...states(recipients, "recipients")],
    top_cities: { buyers: cities(buyers), recipients: cities(recipients) },
    coverage: { orders: paid.length, with_buyer: paid.filter((o) => o.buyerGeo?.region || o.buyerGeo?.city).length, with_recipient: paid.filter((o) => o.shipping?.address?.state).length },
  };
}

// ----- §3b cohorts -----
function buildCohorts(byEmail: Map<string, Order[]>, today: string) {
  const windows = [30, 60, 90, 180, 365];
  const stats = (lists: Order[][]) => {
    const customers = lists.length;
    const orders = lists.reduce((s, l) => s + l.length, 0);
    const repeat = lists.filter((l) => l.length > 1).length;
    const seconds = lists.filter((l) => l.length > 1).map((l) => (Date.parse(l[1].paidAt!) - Date.parse(l[0].paidAt!)) / 86_400_000);
    const revenue = lists.reduce((s, l) => s + l.reduce((t, o) => t + o.price - (o.refundedCents ?? 0), 0), 0);
    const retention: Record<string, { eligible: number; ordered_again: number; rate: number | null }> = {};
    const ltv: Record<string, { eligible: number; avg_orders: number | null; avg_revenue_cents: number | null }> = {};
    for (const w of windows) {
      const eligible = lists.filter((l) => addDays(l[0].paidAt!.slice(0, 10), w) <= today);
      const again = eligible.filter((l) => l.length > 1 && Date.parse(l[1].paidAt!) - Date.parse(l[0].paidAt!) <= w * 86_400_000).length;
      retention[`d${w}`] = { eligible: eligible.length, ordered_again: again, rate: eligible.length ? Math.round((again / eligible.length) * 10000) / 10000 : null };
      if (w === 90 || w === 365) {
        const within = eligible.map((l) => l.filter((o) => Date.parse(o.paidAt!) - Date.parse(l[0].paidAt!) <= w * 86_400_000));
        ltv[`d${w}`] = {
          eligible: eligible.length,
          avg_orders: eligible.length ? Math.round((within.reduce((s, l) => s + l.length, 0) / eligible.length) * 100) / 100 : null,
          avg_revenue_cents: eligible.length ? Math.round(within.reduce((s, l) => s + l.reduce((t, o) => t + o.price, 0), 0) / eligible.length) : null,
        };
      }
    }
    return {
      customers, orders, repeat_customers: repeat,
      repeat_rate: customers ? Math.round((repeat / customers) * 10000) / 10000 : 0,
      median_days_to_second_order: median(seconds),
      revenue_per_customer_cents: customers ? Math.round(revenue / customers) : 0,
      retention, ltv,
    };
  };
  const all = [...byEmail.values()];
  const group = (key: (l: Order[]) => string) => {
    const m = new Map<string, Order[][]>();
    for (const l of all) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return m;
  };
  return {
    money_unit: "cents", percent_unit: "fraction", test_orders_excluded: true,
    overall: stats(all),
    months: [...group((l) => l[0].paidAt!.slice(0, 7))].sort(([a], [b]) => a.localeCompare(b)).map(([month, ls]) => ({ month, ...stats(ls) })),
    by_channel: [...group((l) => channelOf(l[0].utm?.first))].map(([channel, ls]) => ({ channel, ...stats(ls) })),
    by_product: [...group((l) => l[0].size)].map(([product, ls]) => ({ product, label: `${SIZES[product as keyof typeof SIZES]?.name ?? product} framed portrait`, ...stats(ls) })),
  };
}

// ----- §3b attribution (channels) -----
function buildChannels(paidAll: Order[], byEmail: Map<string, Order[]>, i: MetricsInput, money: Map<string, ReturnType<typeof orderMoney>>) {
  const inR = paidAll.filter((o) => inRange(paidDate(o), i.from, i.to));
  const visitsBy = new Map<string, number>();
  for (const v of i.visits) if (inRange(v.date, i.from, i.to)) {
    const ch = v.source.split(/[-\s/]/)[0] || "direct";
    visitsBy.set(ch, (visitsBy.get(ch) ?? 0) + 1);
  }
  const touch = (pick: (o: Order) => Utm | null) => {
    const m = new Map<string, { channel: string; label: string; visits: number; orders: number; new_customers: number; returning_customers: number; revenue_cents: number; contribution_cents: number; ad_spend_cents: number; cost_per_new_customer_cents: null; ltv_cents: number | null; ltv_to_cac: null }>();
    const campaigns = new Map<string, any>();
    for (const o of inR) {
      const u = pick(o);
      const ch = channelOf(u);
      const e = m.get(ch) ?? { channel: ch, label: ch === "direct" ? "Direct" : ch, visits: visitsBy.get(ch) ?? 0, orders: 0, new_customers: 0, returning_customers: 0, revenue_cents: 0, contribution_cents: 0, ad_spend_cents: 0, cost_per_new_customer_cents: null, ltv_cents: null, ltv_to_cac: null };
      const first = byEmail.get(o.customer.email.toLowerCase())![0].id === o.id;
      e.orders++; if (first) e.new_customers++; else e.returning_customers++;
      e.revenue_cents += o.price - (o.refundedCents ?? 0);
      e.contribution_cents += money.get(o.id)!.profit;
      m.set(ch, e);
      const ck = `${ch}|${u?.medium ?? ""}|${u?.campaign ?? ""}`;
      const c = campaigns.get(ck) ?? { channel: ch, source: u?.source ?? "", medium: u?.medium ?? "", campaign: u?.campaign ?? "", orders: 0, new_customers: 0, revenue_cents: 0, contribution_cents: 0 };
      c.orders++; if (first) c.new_customers++; c.revenue_cents += o.price - (o.refundedCents ?? 0); c.contribution_cents += money.get(o.id)!.profit;
      campaigns.set(ck, c);
    }
    for (const e of m.values()) e.ltv_cents = e.new_customers ? Math.round(e.contribution_cents / e.new_customers) : null;
    return { channels: [...m.values()], campaigns: [...campaigns.values()] };
  };
  return {
    from: i.from, to: i.to, money_unit: "cents", window_days: 30, test_orders_excluded: true,
    model: "first touch = first landing UTM (kept 30 days); last touch = latest landing UTM before the order",
    first_touch: touch((o) => o.utm?.first ?? null),
    last_touch: touch((o) => o.utm?.last ?? o.utm?.first ?? null),
  };
}

// ----- §3c fulfillment -----
function buildFulfillment(real: Order[], from: string, to: string, today: string) {
  const inR = real.filter((o) => isCommission(o) && inRange(nyDate(o.createdAt), from, to));
  const toProof = inR.filter((o) => o.proofSentAt).map((o) => hoursBetween(o.createdAt, o.proofSentAt!));
  const toPrint = inR.filter((o) => o.paidAt && o.sentToPrintAt).map((o) => hoursBetween(o.paidAt!, o.sentToPrintAt!));
  const nowIso = `${today}T23:59:59Z` > new Date().toISOString() ? new Date().toISOString() : `${today}T23:59:59Z`;
  const waiting = real.filter((o) => ["card_saved", "rendering", "render_failed", "needs_review", "paid"].includes(o.status) && !o.proofSentAt);
  const late = waiting.filter((o) => hoursBetween(o.createdAt, nowIso) > PROOF_PROMISE_HOURS);
  const eligible = inR.filter((o) => o.proofSentAt || hoursBetween(o.createdAt, nowIso) > PROOF_PROMISE_HOURS);
  const onTime = eligible.filter((o) => o.proofSentAt && hoursBetween(o.createdAt, o.proofSentAt) <= PROOF_PROMISE_HOURS).length;
  const byState = new Map<string, number[]>();
  for (const o of inR) if (o.paidAt && o.sentToPrintAt && o.shipping?.address?.state) {
    byState.set(o.shipping.address.state, [...(byState.get(o.shipping.address.state) ?? []), hoursBetween(o.paidAt, o.sentToPrintAt)]);
  }
  const failedRender = inR.filter((o) => o.history.some((h) => h.event.startsWith("Rendering failed"))).length;
  const failedPrint = inR.filter((o) => o.history.some((h) => h.event.startsWith("Print file failed"))).length;
  const revisions = inR.filter((o) => o.changeRequests.length > 0).length;
  const refunded = inR.filter((o) => (o.refundedCents ?? 0) > 0).length;
  const n = inR.length || 1;
  const rate = (x: number) => Math.round((x / n) * 10000) / 10000;
  return {
    orders: inR.length,
    percent_unit: "fraction",
    test_orders_excluded: true,
    promise: { hours: PROOF_PROMISE_HOURS, business_days: false, label: "Proof emailed within 48 hours of the order" },
    turnaround: [
      { stage: "ordered_to_proof", n: toProof.length, median_hours: median(toProof), p90_hours: pct(toProof, 0.9) },
      { stage: "paid_to_submitted", n: toPrint.length, median_hours: median(toPrint), p90_hours: pct(toPrint, 0.9) },
    ],
    on_time: { eligible: eligible.length, on_time: onTime, rate: eligible.length ? Math.round((onTime / eligible.length) * 10000) / 10000 : null, promise_hours: PROOF_PROMISE_HOURS },
    late: { count: late.length, oldest_hours: late.length ? Math.max(...late.map((o) => hoursBetween(o.createdAt, nowIso))) : 0, orders: late.map((o) => ({ id: `BC-${o.id.slice(0, 6).toUpperCase()}`, stage: "ordered_to_proof", late_hours: Math.round(hoursBetween(o.createdAt, nowIso) - PROOF_PROMISE_HOURS) })) },
    by_state: [...byState].map(([state, hrs]) => ({ state, orders: hrs.length, median_hours: median(hrs), p90_hours: pct(hrs, 0.9) })),
    problems: {
      orders: inR.filter((o) => o.changeRequests.length || (o.refundedCents ?? 0) > 0 || o.status === "render_failed").length,
      refund_rate: rate(refunded),
      reprint_rate: 0,
      by_reason: [
        { reason: "render_failed", kind: "problem", count: failedRender, rate: rate(failedRender) },
        { reason: "print_file_failed", kind: "problem", count: failedPrint, rate: rate(failedPrint) },
        { reason: "customer_requested_changes", kind: "revision", count: revisions, rate: rate(revisions) },
        { reason: "refunded", kind: "refund", count: refunded, rate: rate(refunded) },
      ].filter((r) => r.count > 0),
    },
  };
}

// ----- §3c mix -----
function buildMix(paid: Order[], ai: Map<string, number>, s: Settings) {
  const group = <K extends string>(key: (o: Order) => K, label: (k: K) => string) => {
    const m = new Map<K, { orders: number; revenue_cents: number; contribution_cents: number }>();
    for (const o of paid) {
      const k = key(o);
      const e = m.get(k) ?? { orders: 0, revenue_cents: 0, contribution_cents: 0 };
      e.orders++; e.revenue_cents += o.price;
      e.contribution_cents += o.price - unitCostCents(o.size, s) - Math.round(o.price * STRIPE_FEES.percent + STRIPE_FEES.fixedCents) - (ai.get(o.id) ?? 0);
      m.set(k, e);
    }
    return [...m].map(([k, e]) => ({ key: k, label: label(k), items: e.orders, ...e }));
  };
  const aiTotal = paid.reduce((t, o) => t + (ai.get(o.id) ?? 0), 0);
  const regens = paid.map((o) => Math.max(0, o.renders.length - 1));
  return {
    money_unit: "cents", test_orders_excluded: true,
    orders: paid.length, items: paid.length,
    by_product: group((o) => `${o.style}_${o.size}`, (k) => { const [st, sz] = k.split("_"); return `${styleInfo(st).name} · ${SIZES[sz as keyof typeof SIZES]?.name ?? sz}`; }),
    by_occasion: [],
    by_kind: group((o) => o.category, (k) => categoryInfo(k).name),
    by_format: Object.fromEntries(group((o) => o.frame, (k) => FRAMES[k as keyof typeof FRAMES] ?? k).map((g) => [g.key, { orders: g.orders, label: g.label }])),
    by_design_source: group((o) => o.style, (k) => styleInfo(k).name),
    by_add_on: [{ key: "caption", label: "Free caption under the art", orders: paid.filter((o) => o.caption).length }],
    redesign: { orders: regens.filter((r) => r > 0).length, uses: regens.reduce((a, b) => a + b, 0) },
    ai_cost: { per_order_cents: paid.length ? Math.round(aiTotal / paid.length) : 0, total_cents: aiTotal },
    ai_cost_per_order_cents: paid.length ? Math.round(aiTotal / paid.length) : 0,
    items_per_checkout: { avg: paid.length ? 1 : 0, median: paid.length ? 1 : 0 },
    batch_sizes: paid.length ? [{ bucket: "1", checkouts: paid.length, items: paid.length }] : [],
  };
}
