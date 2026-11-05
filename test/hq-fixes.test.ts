// The fixes from the HQ audit (2026-11-05): test-order rules, actual vs estimated costs, alert
// severities, FinerWorks status/tracking, Meta CAPI, the new admin actions and the cost-of-goods section.
import { describe, it, expect, vi } from "vitest";
import handler from "../netlify/functions/ops.mts";
import { signed, useSecret, order, seed, readOrder } from "./helpers.ts";
import { env } from "./setup.ts";
import { DEFAULT_SETTINGS } from "../netlify/shared/ops-store.mts";
import { isTest, orderMoney } from "../netlify/shared/ops/economics.mts";
import { buildAlerts, orderRow, type AlertInput } from "../netlify/shared/ops/views.mts";
import { parseFinerworksStatus } from "../netlify/shared/finerworks.mts";
import { purchaseEvent, adContext, purchaseEventId, sendPurchase } from "../netlify/shared/meta.mts";
import { needsSync } from "../netlify/shared/finerworks-sync.mts";
import { adminSections } from "../netlify/shared/ops/capabilities.mts";

const S = { ...DEFAULT_SETTINGS };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const alertsFor = (over: Partial<AlertInput>) => buildAlerts({
  orders: [], settings: S, aiMonthCents: 0, webhook: { lastOk: null, lastFail: null, failures24h: 0 }, disputes: [], outbox: [],
  production: true, env: {}, finerworksLive: true, ...over,
}).alerts;
const live = (costCents: number | null = null) => ({ orderId: 555, confirmationId: "C1", testMode: false, productCode: "X", printVersion: 1, costCents });

describe("test orders", () => {
  it("counts an order refunded in full within 24 hours of payment as a test", () => {
    expect(isTest(order({ paidAt: hoursAgo(30), refundedAt: hoursAgo(20), refundedCents: 39500 }), S)).toBe(true);
    expect(isTest(order({ paidAt: hoursAgo(60), refundedAt: hoursAgo(20), refundedCents: 39500 }), S)).toBe(false);
    expect(isTest(order({ paidAt: hoursAgo(30), refundedAt: hoursAgo(20), refundedCents: 10000 }), S)).toBe(false); // partial
  });

  it("lets HQ's Mark as test win either way", () => {
    expect(isTest(order({ testOverride: true }), S)).toBe(true);
    expect(isTest(order({ livemode: false, testOverride: false }), S)).toBe(false);
  });
});

describe("costs: actual or estimated", () => {
  it("keeps FinerWorks as an estimate until FinerWorks reports what it charged", () => {
    const est = orderMoney(order({ finerworks: live(null) }), S, new Map());
    expect(est.fulfillmentActual).toBe(false);
    expect(est.fulfillment).toBe(22400);
    const act = orderMoney(order({ finerworks: live(23150) }), S, new Map());
    expect(act.fulfillmentActual).toBe(true);
    expect(act.fulfillment).toBe(23150);
  });

  it("flags each line's source on the order row, with refunds and fulfillment", () => {
    const row = orderRow(order({ stripeFeeCents: 1176, finerworks: { ...live(23150), status: "Shipped", shipments: [{ trackingNumber: "1Z9", trackingUrl: "https://t/1Z9", carrier: "UPS", shippedAt: hoursAgo(5), deliveredAt: null }] } }), S, new Map());
    expect(row.economics).toMatchObject({ fees_source: "actual", fulfillment_source: "actual", estimated: false });
    expect(row.fulfillment).toMatchObject({ state: "shipped", tracking_number: "1Z9", vendor_status: "Shipped" });
    expect(row.refund_status).toBe("none");
    const est = orderRow(order(), S, new Map());
    expect(est.economics).toMatchObject({ fees_source: "estimated", fulfillment_source: "estimated", estimated: true });
  });
});

describe("alerts follow HQ's severity rules", () => {
  it("makes failed renders and slow reviews warnings, not critical", () => {
    const a = alertsFor({ orders: [order({ status: "render_failed" }), order({ status: "needs_review", createdAt: hoursAgo(40), paidAt: undefined })] });
    expect(a.filter((x) => x.severity === "critical")).toEqual([]);
    expect(a.map((x) => x.severity)).toEqual(["warning", "warning"]);
  });

  it("is critical for an order losing $1 or more, info under $1", () => {
    const big = alertsFor({ orders: [order({ price: 20000, paidAt: hoursAgo(5) })] }); // 200 - 224 - fees
    expect(big.find((x) => x.id.startsWith("loss-"))?.severity).toBe("critical");
    const small = alertsFor({ orders: [order({ price: 23050, stripeFeeCents: 700, paidAt: hoursAgo(5) })] }); // loses $0.50
    expect(small.find((x) => x.id.startsWith("loss-small-"))?.severity).toBe("info");
    const old = alertsFor({ orders: [order({ price: 23050, stripeFeeCents: 700, paidAt: hoursAgo(24 * 8) })] });
    expect(old.find((x) => x.id.startsWith("loss-small-"))).toBeUndefined();
  });

  it("is critical for 3 losing orders in 7 days", () => {
    const losing = [1, 2, 3].map(() => order({ price: 23050, stripeFeeCents: 700, paidAt: hoursAgo(10) }));
    expect(alertsFor({ orders: losing }).find((x) => x.id.startsWith("losing-streak"))?.severity).toBe("critical");
  });

  it("is critical when FinerWorks declines the card, warning for other refusals", () => {
    const card = order({ status: "customer_approved", sentToPrintAt: undefined, finerworksError: { at: hoursAgo(1), message: "Payment declined: card expired" } });
    const other = order({ status: "customer_approved", sentToPrintAt: undefined, finerworksError: { at: hoursAgo(1), message: "Invalid product code" } });
    const a = alertsFor({ orders: [card, other] });
    expect(a.find((x) => x.id === `finerworks-failed-${card.id}`)?.severity).toBe("critical");
    expect(a.find((x) => x.id === `finerworks-failed-${other.id}`)?.severity).toBe("warning");
  });

  it("warns on cost variance only above 5% over the model", () => {
    expect(alertsFor({ orders: [order({ finerworks: live(23600) })] }).find((x) => x.id.startsWith("cost-variance"))?.severity).toBe("warning"); // +5.4%
    expect(alertsFor({ orders: [order({ finerworks: live(23400) })] }).find((x) => x.id.startsWith("cost-variance"))).toBeUndefined(); // +4.5%
    expect(alertsFor({ orders: [order({ finerworks: live(20000) })] }).find((x) => x.id.startsWith("cost-variance"))).toBeUndefined(); // cheaper
  });

  it("is critical only for env vars that stop sales", () => {
    const a = alertsFor({ env: { STRIPE_SECRET_KEY: false, FINERWORKS_APP_KEY: false } });
    expect(a.find((x) => x.id === "env-STRIPE_SECRET_KEY")?.severity).toBe("critical");
    expect(a.find((x) => x.id === "env-FINERWORKS_APP_KEY")?.severity).toBe("warning");
  });
});

describe("FinerWorks status and tracking", () => {
  it("reads status, tracking and what FinerWorks charged", () => {
    const st = parseFinerworksStatus(
      { orders: [{ order_id: 555, order_status_label: "Shipped", shipments: [{ tracking_number: "1Z9", tracking_url: "https://t/1Z9", carrier: "UPS", shipment_date: "2026-11-10T10:00:00Z", delivery_date: null }] }] },
      { orders: [{ order_id: 555, total: 231.5, status: "Shipped" }] },
      555,
    );
    expect(st).toEqual({ status: "Shipped", costCents: 23150, shipments: [{ trackingNumber: "1Z9", trackingUrl: "https://t/1Z9", carrier: "UPS", shippedAt: "2026-11-10T10:00:00Z", deliveredAt: null }] });
    expect(parseFinerworksStatus({ orders: [] }, null, 555)).toEqual({ status: null, shipments: [], costCents: null });
  });

  it("syncs live orders until they're delivered and costed", () => {
    expect(needsSync(order({ finerworks: live(null) }))).toBe(true);
    expect(needsSync(order({ finerworks: { ...live(23150), shipments: [{ trackingNumber: "1", trackingUrl: null, carrier: null, shippedAt: null, deliveredAt: hoursAgo(1) }] } }))).toBe(false);
    expect(needsSync(order({ finerworks: { ...live(null), testMode: true } }))).toBe(false);
  });
});

describe("Meta Conversions API", () => {
  it("keeps nothing for CAPI without consent", () => {
    const req = new Request("https://burinandco.com/api/orders", { method: "POST", headers: { cookie: "_fbp=fb.1.1.2" } });
    const f = new FormData();
    expect(adContext(req, f)).toEqual({ consent: false });
    f.set("ad_consent", "granted");
    expect(adContext(req, f)).toMatchObject({ consent: true, fbp: "fb.1.1.2" });
  });

  it("sends a hashed Purchase with the browser event's id, once, only with consent", async () => {
    const o = order({ ads: { consent: true, fbp: "fb.1.1.2", ip: "1.2.3.4", ua: "UA" } });
    const ev = purchaseEvent(o);
    expect(ev.event_id).toBe(purchaseEventId(o));
    expect(ev.custom_data).toMatchObject({ currency: "USD", value: 395 });
    expect(JSON.stringify(ev)).not.toContain("maya@example.com");
    expect((ev.user_data.em as string[])[0]).toMatch(/^[0-9a-f]{64}$/);

    env.set("META_PIXEL_ID", "123");
    env.set("META_CAPI_ACCESS_TOKEN", "tok");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendPurchase(o)).toBe("sent");
    expect(await sendPurchase(o)).toBe("skipped"); // already sent
    expect(await sendPurchase(order({ ads: { consent: false } }))).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("admin: new actions and the cost-of-goods section", () => {
  const act = async (action: string, params: Record<string, unknown>) => {
    const body = JSON.stringify({ action, params });
    return (await handler(signed("POST", "/api/ops/actions", body))).json();
  };

  it("advertises the cost-of-goods section and the new order actions", () => {
    const s = adminSections();
    expect(s.find((x) => x.id === "cogs")?.read_endpoint).toBe("/api/ops/admin/cogs");
    const names = s.find((x) => x.id === "orders")!.actions.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["resend_email", "mark_test", "refresh_status", "refund_order"]));
    expect(s.find((x) => x.id === "orders")!.actions.find((a) => a.name === "refund_order")?.destructive).toBe(true);
  });

  it("marks an order as test and back", async () => {
    useSecret();
    const o = order();
    seed(o);
    expect((await act("mark_test", { order_id: o.id, on: true })).ok).toBe(true);
    expect(readOrder(o.id).testOverride).toBe(true);
    await act("mark_test", { order_id: o.id, on: false });
    expect(readOrder(o.id).testOverride).toBe(false);
  });

  it("refuses to resend when there's nothing to resend", async () => {
    useSecret();
    const o = order({ status: "customer_approved", sentToPrintAt: undefined });
    seed(o);
    const r = await act("resend_email", { order_id: o.id });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_allowed");
  });

  it("lists each paid order's costs with their sources", async () => {
    useSecret();
    const now = new Date().toISOString();
    seed(order({ paidAt: now, stripeFeeCents: 1176, finerworks: live(23150) }), order({ paidAt: now }));
    const res = await handler(signed("GET", "/api/ops/admin/cogs"));
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: any) => i.fulfillment_source).sort()).toEqual(["actual", "estimated"]);
    expect(body.summary.actual_share).toBe(0.5);
  });

  it("reports the FinerWorks sync job in health", async () => {
    useSecret();
    const body = await (await handler(signed("GET", "/api/ops/health"))).json();
    expect(body.jobs[0]).toMatchObject({ id: "finerworks-sync", schedule: "Every 6 hours" });
  });
});

describe("owner test emails from Netlify", () => {
  it("treats orders from OWNER_TEST_EMAILS as test, so metrics leave them out", async () => {
    env.set("OWNER_TEST_EMAILS", " David@Example.com , other@example.com");
    const o = order({ customer: { ...order().customer, email: "david@example.com" }, paidAt: hoursAgo(5) });
    expect(isTest(o, S)).toBe(true);
    expect(isTest(order({ paidAt: hoursAgo(5) }), S)).toBe(false);
    useSecret();
    seed(o);
    const now = new Date().toISOString().slice(0, 10);
    const m = await (await handler(signed("GET", `/api/ops/metrics?from=${now.slice(0, 8)}01&to=${now}`))).json();
    const revenue = (m.daily as any[]).reduce((t, d) => t + (d.revenue ?? 0), 0);
    expect(revenue).toBe(0);
    seed(order({ paidAt: hoursAgo(5) }));
    const m2 = await (await handler(signed("GET", `/api/ops/metrics?from=${now.slice(0, 8)}01&to=${now}`))).json();
    expect((m2.daily as any[]).reduce((t, d) => t + (d.revenue ?? 0), 0)).toBeGreaterThan(0);
  });
});
