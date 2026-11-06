import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { env, blobs } from "./setup.ts";
import { useSecret, order, seed, readOrder, signed } from "./helpers.ts";
import { addressedToUs, verifyResendSignature, classify } from "../netlify/shared/inbox.mts";
import inbound from "../netlify/functions/inbound-email.mts";
import webhook from "../netlify/functions/stripe-webhook.mts";
import ops from "../netlify/functions/ops.mts";

const RESEND_SECRET = "whsec_" + Buffer.from("resend-test-signing-key").toString("base64");
function resendRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from("resend-test-signing-key")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("https://burinandco.com/api/inbound/email", { method: "POST", headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body });
}

const STRIPE_SECRET = "whsec_stripe_test";
function stripeRequest(event: unknown) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", STRIPE_SECRET).update(`${t}.${body}`).digest("hex");
  return new Request("https://burinandco.com/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body });
}

beforeEach(() => {
  useSecret();
  env.set("RESEND_INBOUND_WEBHOOK_SECRET", RESEND_SECRET);
  env.set("STRIPE_WEBHOOK_SECRET", STRIPE_SECRET);
});

describe("inbound email", () => {
  it("only accepts mail addressed to burinandco.com", () => {
    expect(addressedToUs(["support@burinandco.com"])).toBe(true);
    expect(addressedToUs(['"Burin" <Support@BurinAndCo.com>'])).toBe(true);
    expect(addressedToUs(["hello@namesakeportraits.com"])).toBe(false);
    expect(addressedToUs(["support@burinandco.com.evil.example"])).toBe(false);
  });

  it("checks Resend's signature", async () => {
    const good = resendRequest({ type: "email.received", data: {} });
    expect(verifyResendSignature(await good.clone().text(), good.headers, RESEND_SECRET)).toBe(true);
    expect(verifyResendSignature("{}", good.headers, RESEND_SECRET)).toBe(false);
    const bad = await inbound(new Request("https://burinandco.com/api/inbound/email", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(401);
  });

  it("quietly ignores other brands' mail and stores ours, matched to the order", async () => {
    const o = order({ customer: { name: "Maya Rivers", email: "maya@example.com" } });
    seed(o);
    const other = await inbound(resendRequest({ type: "email.received", data: { email_id: "e1", from: "a@b.com", to: ["hello@namesakeportraits.com"], subject: "Hi" } }));
    expect(await other.text()).toBe("ignored");
    expect([...(blobs.get("ops")?.keys() ?? [])].some((k) => k.startsWith("conv/"))).toBe(false);

    // Resend's receiving API returns the body.
    vi.mocked(fetch).mockImplementation(async (url: any) => String(url).includes("/emails/receiving/")
      ? Response.json({ text: "Where is my portrait?", message_id: "<abc@mail.example.com>", from: "Maya Rivers <maya@example.com>", subject: "Where is my order?" })
      : new Response("{}", { status: 503 }));
    const ours = await inbound(resendRequest({ type: "email.received", data: { email_id: "e2", from: "Maya Rivers <maya@example.com>", to: ["support@burinandco.com"], subject: "Where is my order?" } }));
    expect(await ours.text()).toBe("stored");

    const res = await ops(signed("GET", "/api/ops/inbox"));
    const box = await res.json() as any;
    expect(box.conversations).toHaveLength(1);
    expect(box.conversations[0]).toMatchObject({ customer: "Maya R.", category: "where_is_my_order", order_id: `BC-${o.id.slice(0, 6).toUpperCase()}` });
    expect(box.drafts[0].message_id).toMatch(/^d_/);
  });

  it("forwards a copy to FORWARD_INBOUND_TO, once, with Reply-To the customer, and still files it", async () => {
    env.set("FORWARD_INBOUND_TO", "david@tenfoldcommerce.com");
    env.set("RESEND_API_KEY", "re_test");
    const sends: any[] = [];
    vi.mocked(fetch).mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/attachments")) return Response.json({ data: [{ filename: "house.jpg", content_type: "image/jpeg", download_url: "https://cdn.example/house.jpg" }] });
      if (u.includes("/emails/receiving/")) return Response.json({ text: "Hello", html: "<p>Hello</p>", from: "Sam Lee <sam@example.com>", to: ["support@burinandco.com"], subject: "Question" });
      if (u === "https://api.resend.com/emails") { sends.push({ headers: init.headers, body: JSON.parse(init.body) }); return Response.json({ id: "sent_1" }); }
      return new Response("{}", { status: 503 });
    });
    const res = await inbound(resendRequest({ type: "email.received", data: { email_id: "e9", from: "sam@example.com", to: ["support@burinandco.com"], subject: "Question" } }));
    expect(await res.text()).toBe("stored");
    expect(sends).toHaveLength(1);
    expect(sends[0].headers["Idempotency-Key"]).toBe("fwd-e9");
    expect(sends[0].body).toMatchObject({ to: ["david@tenfoldcommerce.com"], reply_to: "sam@example.com", subject: "Question", from: "Sam Lee via Burin & Co. <support@burinandco.com>" });
    expect(sends[0].body.attachments[0]).toMatchObject({ filename: "house.jpg", path: "https://cdn.example/house.jpg" });
    expect(sends[0].body.html).toContain("<p>Hello</p>");

    // Other brands' mail is not forwarded.
    await inbound(resendRequest({ type: "email.received", data: { email_id: "e10", from: "a@b.com", to: ["hello@namesakeportraits.com"], subject: "Hi" } }));
    expect(sends).toHaveLength(1);
    env.delete("FORWARD_INBOUND_TO");
  });

  it("sends no copy when FORWARD_INBOUND_TO is not set", async () => {
    const urls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url: any) => { urls.push(String(url)); return Response.json({ text: "Hi", from: "x@example.com", subject: "S" }); });
    await inbound(resendRequest({ type: "email.received", data: { email_id: "e11", from: "x@example.com", to: ["support@burinandco.com"], subject: "S" } }));
    expect(urls.some((u) => u === "https://api.resend.com/emails")).toBe(false);
  });

  it("classifies urgency", () => {
    expect(classify("Chargeback", "").urgency).toBe("urgent");
    expect(classify("Please refund", "").category).toBe("refund_request");
  });
});

describe("Stripe webhook", () => {
  it("rejects a bad signature and records refunds and disputes", async () => {
    expect((await webhook(new Request("https://burinandco.com/api/stripe/webhook", { method: "POST", body: "{}" }))).status).toBe(400);
    const o = order();
    seed(o);
    const refunded = await webhook(stripeRequest({ type: "charge.refunded", livemode: true, data: { object: { id: "ch_1", payment_intent: o.paymentIntentId, amount_refunded: 39500, metadata: {} } } }));
    expect(refunded.status).toBe(200);
    expect(readOrder(o.id)).toMatchObject({ refundedCents: 39500, status: "refunded" });
    await webhook(stripeRequest({ type: "charge.dispute.created", livemode: true, data: { object: { id: "dp_1", payment_intent: o.paymentIntentId, amount: 39500, status: "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } }));
    const alerts = await (await ops(signed("GET", "/api/ops/alerts"))).json() as any;
    expect(alerts.alerts.find((a: any) => a.id === "dispute-dp_1")).toMatchObject({ severity: "critical" });
    const health = await (await ops(signed("GET", "/api/ops/health"))).json() as any;
    expect(health.checks.find((c: any) => c.id === "stripe-webhook").details.lastEventAt).toBeTruthy();
  });

  it("only warns about a missing webhook for orders paid since recording began", async () => {
    const check = async () => ((await (await ops(signed("GET", "/api/ops/health"))).json()) as any).checks.find((c: any) => c.id === "stripe-webhook");
    seed(order({ paidAt: "2026-11-03T12:00:00.000Z" }));
    expect(await check()).toMatchObject({ status: "ok", details: { paidSinceRecording: false } });
    seed(order({ paidAt: new Date().toISOString() }));
    expect(await check()).toMatchObject({ status: "warn", details: { paidSinceRecording: true } });
  });

  it("acknowledges every subscribed event type with 200", async () => {
    for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.succeeded", "charge.updated", "charge.refunded", "charge.dispute.created", "charge.dispute.closed"]) {
      const res = await webhook(stripeRequest({ type, livemode: false, data: { object: { id: "x", metadata: {} } } }));
      expect(res.status, type).toBe(200);
    }
  });
});
