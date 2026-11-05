import { describe, it, expect, beforeEach } from "vitest";
import handler from "../netlify/functions/ops.mts";
import { signed, useSecret, order, seed } from "./helpers.ts";
import { FEATURES, adminSections } from "../netlify/shared/ops/capabilities.mts";

const call = async (req: Request) => {
  const res = await handler(req);
  return { res, json: await res.json() as any };
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() - n * 86_400_000));

beforeEach(() => useSecret());

describe("signed /api/ops/* (contract §1)", () => {
  it("answers 401 to unsigned, stale and tampered requests, with no-store and no CORS", async () => {
    const unsigned = await handler(new Request("https://burinandco.com/api/ops/health"));
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("cache-control")).toBe("no-store");
    expect(unsigned.headers.get("access-control-allow-origin")).toBeNull();
    const stale = await handler(signed("GET", "/api/ops/health", "", { ts: Math.floor(Date.now() / 1000) - 400 }));
    expect(stale.status).toBe(401);
    const req = signed("GET", "/api/ops/health");
    const tampered = new Request("https://burinandco.com/api/ops/health?x=1", { headers: req.headers });
    expect((await handler(tampered)).status).toBe(401);
  });

  it("answers HQ's Save & test probe with 400 unknown_action and changes nothing", async () => {
    const { res, json } = await call(signed("POST", "/api/ops/actions", '{"action":"hq_signature_check","params":{}}'));
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "unknown_action" });
  });
});

describe("GET /api/ops/health", () => {
  it("reports checks, storefront prices with floors, and every capability", async () => {
    const { res, json } = await call(signed("GET", "/api/ops/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(json.site).toBe("burinandco");
    expect(["ok", "warn", "fail"]).toContain(json.status);
    expect(json.checks.map((c: any) => c.category)).toEqual(expect.arrayContaining(["payments", "webhooks", "fulfillment", "email", "ai"]));
    expect(json.checks.find((c: any) => c.id === "inbound-email")).toBeTruthy();
    for (const p of json.storefront.products) expect(p.price).toBeGreaterThanOrEqual(p.minPrice);
    expect(json.capabilities.features).toEqual(FEATURES);
    expect(json.capabilities.admin_sections.map((s: any) => s.id)).toEqual(adminSections().map((s) => s.id));
    for (const s of json.capabilities.admin_sections) {
      expect(s.read_endpoint.startsWith("/api/ops/")).toBe(true);
      for (const a of s.actions) expect(a.params.type).toBe("object");
    }
    // Refunds and FinerWorks orders move money: they must be confirmed in HQ.
    const actions = json.capabilities.admin_sections.flatMap((s: any) => s.actions);
    expect(actions.find((a: any) => a.name === "refund_order").destructive).toBe(true);
    expect(actions.find((a: any) => a.name === "send_to_finerworks").destructive).toBe(true);
    // Not-applicable features carry a reason.
    for (const reason of Object.values(json.capabilities.not_applicable)) expect(String(reason).length).toBeGreaterThan(20);
  });
});

describe("GET /api/ops/metrics", () => {
  it("excludes test orders and contains no customer PII", async () => {
    seed(
      order({ customer: { name: "Maya Rivers", email: "maya@example.com" } }),
      order({ customer: { name: "Test Buyer", email: "test@example.com" }, livemode: false }),
      order({ customer: { name: "David Owner", email: "owner@tenfold.example" } }),
    );
    // The owners' own email is a test order too.
    await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "set_setting", params: { setting: "owner_test_emails", value: "owner@tenfold.example" }, sent_by: "David" })));

    const { res, json } = await call(signed("GET", `/api/ops/metrics?from=${daysAgo(29)}&to=${today()}`));
    expect(res.status).toBe(200);
    expect(json.test_orders_excluded).toBe(true);
    expect(json.totals.orders).toBe(1);
    expect(json.totals.revenue).toBe(395);
    expect(json.daily).toHaveLength(30);
    expect(json.customers.customers).toBe(1);
    expect(json.unit_economics.revenue).toBe(39500);
    expect(json.geo.recipients[0]).toMatchObject({ city: "Boston", region: "MA", orders: 1 });
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/617-555-0100|1 Main St|Rivers/);
    // Profit = revenue − fees − FinerWorks − AI.
    const t = json.totals;
    expect(t.profit).toBeCloseTo(t.revenue - t.refunds - t.fees - t.fulfillmentCost - t.aiCost, 2);
  });

  it("reports cash with the missing Stripe permissions instead of zeros", async () => {
    const { json } = await call(signed("GET", `/api/ops/metrics?from=${today()}&to=${today()}`));
    expect(json.cash.balance).toBeNull();
    expect(json.cash.missing_permissions).toContain("Balance: Read");
  });
});

describe("GET /api/ops/orders", () => {
  it("lists commissions newest first with first name + last initial, is_test and actions", async () => {
    const failed = order({ status: "render_failed", paidAt: undefined, paymentIntentId: undefined, lastError: "timeout", createdAt: new Date(Date.now() - 86_400_000 * 5).toISOString() });
    const testOne = order({ livemode: false });
    seed(order(), failed, testOne, order({ status: "awaiting_card" }));
    const { json } = await call(signed("GET", "/api/ops/orders?limit=100"));
    expect(json.orders).toHaveLength(3); // the unfinished checkout isn't an order
    expect(json.orders[0]).toMatchObject({ order_id: failed.id, status: "failed", actions: expect.arrayContaining(["retry_order"]) });
    expect(json.orders.every((o: any) => o.customer === "Maya R.")).toBe(true);
    expect(json.orders.find((o: any) => o.order_id === testOne.id).is_test).toBe(true);
    expect(json.hasMore).toBe(false);
    const attention = await call(signed("GET", "/api/ops/orders?status=attention"));
    expect(attention.json.orders.map((o: any) => o.order_id)).toEqual([failed.id]);
  });
});

describe("GET /api/ops/alerts", () => {
  it("raises stable ids for orders that need a human", async () => {
    const review = order({ status: "needs_review", paidAt: undefined, sentToPrintAt: undefined });
    seed(review);
    const a = await call(signed("GET", "/api/ops/alerts"));
    const b = await call(signed("GET", "/api/ops/alerts"));
    const ids = a.json.alerts.map((x: any) => x.id);
    expect(ids).toContain(`review-${review.id}-v1`);
    expect(b.json.alerts.map((x: any) => x.id)).toEqual(ids);
    for (const x of a.json.alerts) expect(["critical", "warning", "info"]).toContain(x.severity);
  });
});

describe("prices (§6 set_price, §14 /api/ops/pricing)", () => {
  it("refuses set_price below break-even with below_profit_floor", async () => {
    const { res, json } = await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "set_price", params: { sku: "16x20", price: 100 } })));
    expect(res.status).toBe(422);
    expect(json.code).toBe("below_profit_floor");
  });

  it("sets, schedules and clears a price, bumping the version, and the storefront follows", async () => {
    const before = (await call(signed("GET", "/api/ops/pricing"))).json;
    expect(before.money_unit).toBe("cents");
    const floor = before.cells.base["16x20"].single.floorCents;
    expect(floor).toBeGreaterThan(22400);

    const low = await call(signed("POST", "/api/ops/pricing", JSON.stringify({ op: "set", product: "16x20", line: "base", tier: "single", cents: floor - 1, sent_by: "Justin" })));
    expect(low.res.status).toBe(422);
    expect(low.json).toMatchObject({ code: "below_floor", data: { floorCents: floor } });

    const set = await call(signed("POST", "/api/ops/pricing", JSON.stringify({ op: "set", product: "16x20", line: "base", tier: "single", cents: 42500, sent_by: "Justin" })));
    expect(set.json.ok).toBe(true);
    expect(set.json.data.version).toBe(before.version + 1);

    const catalog = await (await import("../netlify/functions/catalog.mts")).default();
    const sizes = (await catalog.json() as any).sizes;
    expect(sizes.find((s: any) => s.id === "16x20").price).toBe(42500);

    const oneDate = await call(signed("POST", "/api/ops/pricing", JSON.stringify({ op: "set", product: "16x20", cents: 45000, startsOn: "2026-12-01" })));
    expect(oneDate.json.code).toBe("invalid_dates");

    const clear = await call(signed("POST", "/api/ops/pricing", JSON.stringify({ op: "clear", product: "16x20", line: "base", tier: "single", sent_by: "Justin" })));
    expect(clear.json.ok).toBe(true);
    expect((await call(signed("GET", "/api/ops/pricing"))).json.cells.base["16x20"].single.cents).toBe(39500);
  });

  it("requires a request id and replays the first answer for a repeat", async () => {
    const body = JSON.stringify({ op: "set", product: "12x16", cents: 31000, sent_by: "Justin" });
    const first = await call(signed("POST", "/api/ops/pricing", body, { requestId: "req-1" }));
    const again = await call(signed("POST", "/api/ops/pricing", body, { requestId: "req-1" }));
    expect(again.json).toEqual(first.json);
    expect((await call(signed("GET", "/api/ops/pricing"))).json.version).toBe(2);
  });
});

describe("actions", () => {
  it("pauses and resumes checkout, and the storefront refuses new orders while paused", async () => {
    expect((await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "pause_site", params: { reason: "Holiday" } })))).json.ok).toBe(true);
    const create = (await import("../netlify/functions/create-order.mts")).default;
    const form = new FormData();
    const res = await create(new Request("https://burinandco.com/api/orders", { method: "POST", body: form }), {} as any);
    expect(res.status).toBe(503);
    expect((await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "resume_site", params: {} })))).json.ok).toBe(true);
  });

  it("updates the headline as plain text and logs every change", async () => {
    const r = await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "update_homepage_headline", params: { headline: "<b>Your car</b>, engraved" }, sent_by: "David" })));
    expect(r.json.ok).toBe(true);
    const health = (await call(signed("GET", "/api/ops/health"))).json;
    expect(health.storefront.headline).toBe("Your car, engraved");
    const audit = (await call(signed("GET", "/api/ops/admin/audit"))).json;
    expect(audit.items[0]).toMatchObject({ by: "David", action: "update_homepage_headline" });
  });

  it("cancels an uncharged order on refund_order without calling Stripe", async () => {
    const o = order({ status: "proof_sent", paidAt: undefined, paymentIntentId: undefined, sentToPrintAt: undefined });
    seed(o);
    const r = await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "refund_order", params: { orderId: o.id, reason: "Customer changed mind" } })));
    expect(r.json).toMatchObject({ ok: true });
    expect(r.json.message).toMatch(/Nothing was charged/);
  });

  it("refuses actions a section doesn't advertise, and unknown jobs", async () => {
    const r = await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "delete_everything", params: {}, section: "orders" })));
    expect(r.res.status).toBe(400);
    const job = await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "rerun_job", params: { jobId: "x" } })));
    expect(job.json.code).toBe("job_not_found");
  });

  it("keeps the model lab off until HQ turns it on, and sets the AI budget", async () => {
    const lab = (await import("../netlify/functions/lab.mts")).default;
    const req = () => new Request("https://burinandco.com/api/lab", { method: "POST", headers: { "x-admin-password": "pw", "content-type": "application/json" }, body: JSON.stringify({ id: "t", retry: "google/nano-banana-pro" }) });
    const { env } = await import("./setup.ts");
    env.set("ADMIN_PASSWORD", "pw");
    expect((await lab(req())).status).toBe(403);
    expect((await call(signed("POST", "/api/ops/actions", JSON.stringify({ action: "set_ai_cap", params: { dollars: 50 } })))).json.ok).toBe(true);
    const ai = (await call(signed("GET", "/api/ops/admin/ai"))).json;
    expect(ai.summary.monthly_cap_cents).toBe(5000);
    expect(ai.summary.lab_enabled).toBe(0);
  });
});

describe("other endpoints", () => {
  it("serves vendors with ≥ 62 days, development kept apart from cost of goods", async () => {
    seed(order());
    const { json } = await call(signed("GET", "/api/ops/vendors"));
    const byId = Object.fromEntries(json.vendors.map((v: any) => [v.id, v]));
    expect(byId.stripe.category).toBe("cogs");
    expect(byId.finerworks.included_in).toBe("fulfillment");
    expect(byId.replicate.included_in).toBe("ai");
    expect(byId["replicate-lab"].category).toBe("development");
    expect(byId.stripe.daily.length).toBeGreaterThanOrEqual(62);
  });

  it("serves attribution, live, reports and the admin reads", async () => {
    seed(order({ utm: { first: { source: "facebook", medium: "paid_social", campaign: "123", content: "456" }, last: null } }));
    const attr = (await call(signed("GET", `/api/ops/attribution?from=${daysAgo(10)}&to=${today()}`))).json;
    expect(attr.rows[0]).toMatchObject({ utmSource: "facebook", utmCampaign: "123", orders: 1, newCustomers: 1 });
    const live = (await call(signed("GET", "/api/ops/live"))).json;
    expect(live).toMatchObject({ money_unit: "cents", visitors_5m: 0 });
    expect(JSON.stringify(live)).not.toMatch(/Maya|@/);
    const rep = await call(signed("GET", "/api/ops/reports?month=2026-01"));
    expect(rep.res.status).toBe(200);
    expect((await call(signed("GET", "/api/ops/reports?month=2999-01"))).res.status).toBe(404);
    for (const s of adminSections()) {
      const r = await call(signed("GET", s.read_endpoint));
      expect(r.res.status, s.read_endpoint).toBe(200);
      expect(Array.isArray(r.json.items)).toBe(true);
    }
    expect((await call(signed("GET", "/api/ops/nope"))).res.status).toBe(404);
  });
});
