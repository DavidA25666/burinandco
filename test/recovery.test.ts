// Abandoned-checkout recovery: who gets the one reminder, the free proof with no card, and paying on approval.
import { describe, it, expect, vi } from "vitest";
import { order, seed, readOrder, useSecret } from "./helpers.ts";
import { blobs, env } from "./setup.ts";
import { runRecovery, saveLead, freeOrderToken, freeLeadToken, unsubToken, WAIT_MS } from "../netlify/shared/recovery.mts";
import freeProof from "../netlify/functions/free-proof.mts";
import unsubscribe from "../netlify/functions/unsubscribe.mts";
import proof from "../netlify/functions/proof.mts";
import createOrder from "../netlify/functions/create-order.mts";
import { sign } from "../netlify/shared/sign.mts";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ORIGIN = "https://burinandco.com";

// Records Resend sends; Stripe and the render trigger answer like the real services.
function services() {
  const emails: any[] = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls.push(String(url));
    if (String(url).includes("api.resend.com")) { emails.push(JSON.parse(init.body)); return Response.json({ id: "em_1" }); }
    if (String(url).includes("render-background")) return new Response(null, { status: 202 });
    if (String(url).includes("checkout/sessions")) return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/pay/cs_test_1" });
    if (String(url).includes("/v1/customers")) return Response.json({ id: "cus_1" });
    return new Response("{}", { status: 503 });
  }));
  env.set("RESEND_API_KEY", "re_test");
  env.set("STRIPE_SECRET_KEY", "sk_test_1");
  env.set("FROM_EMAIL", "Burin & Co. <hello@burinandco.com>");
  return { emails, calls };
}

const abandoned = (over = {}) => order({
  status: "awaiting_card", createdAt: ago(WAIT_MS + 60_000), card: null, paidAt: undefined, paymentIntentId: undefined,
  renders: [], proofSentAt: undefined, sentToPrintAt: undefined, ...over,
});

describe("the reminder job", () => {
  it("emails someone who left the card page an hour ago, once, with an unsubscribe link", async () => {
    useSecret();
    const { emails } = services();
    const o = abandoned();
    seed(o);
    expect((await runRecovery(ORIGIN)).sent).toBe(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].html).toContain(`/free-proof.html?o=${o.id}&amp;t=`.replace("&amp;", "&"));
    expect(emails[0].html).toContain("/api/unsubscribe?e=");
    expect(emails[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(readOrder(o.id).recovery?.sentAt).toBeTruthy();
    expect((await runRecovery(ORIGIN)).sent).toBe(0); // never twice
  });

  it("waits the hour, gives up after 3 days, and skips customers, test orders and the unsubscribed", async () => {
    useSecret();
    const { emails } = services();
    seed(
      abandoned({ createdAt: ago(10 * 60_000) }),                                     // too soon
      abandoned({ createdAt: ago(4 * 86_400_000), customer: { name: "Old", email: "old@example.com" } }), // too late
      abandoned({ livemode: false, customer: { name: "T", email: "t@example.com" } }), // test keys
      abandoned({ customer: { name: "C", email: "c@example.com" } }),
      order({ customer: { name: "C", email: "C@example.com" } }),                    // already a customer
    );
    await runRecovery(ORIGIN);
    expect(emails).toEqual([]);
  });

  it("emails a typed-in email whose form was never sent, linking back to the form", async () => {
    useSecret();
    const { emails } = services();
    await saveLead("Lead@Example.com", "Lee Ward");
    const key = [...blobs.get("orders")!.keys()].find((k) => k.startsWith("lead/"))!;
    const lead = JSON.parse(blobs.get("orders")!.get(key)!);
    blobs.get("orders")!.set(key, JSON.stringify({ ...lead, updatedAt: ago(WAIT_MS + 1000) }));
    expect((await runRecovery(ORIGIN)).sent).toBe(1);
    expect(emails[0].to).toEqual(["lead@example.com"]);
    expect(emails[0].html).toContain(`/?free=${freeLeadToken("lead@example.com")}`);
  });

  it("can be switched off in Netlify", async () => {
    useSecret();
    const { emails } = services();
    env.set("ABANDONED_CHECKOUT_EMAILS", "off");
    seed(abandoned());
    await runRecovery(ORIGIN);
    expect(emails).toEqual([]);
  });
});

describe("the free proof", () => {
  const post = (body: object) => new Request(`${ORIGIN}/api/free-proof`, { method: "POST", body: JSON.stringify(body) });

  it("opening the link changes nothing; the button starts drawing with no card", async () => {
    useSecret();
    const { emails, calls } = services();
    const o = abandoned();
    seed(o);
    const t = freeOrderToken(o.id);
    const got = await (await freeProof(new Request(`${ORIGIN}/api/free-proof?o=${o.id}&t=${t}`))).json();
    expect(got.started).toBe(false);
    expect(readOrder(o.id).status).toBe("awaiting_card");

    expect((await freeProof(post({ o: o.id, t }))).status).toBe(200);
    const after = readOrder(o.id);
    expect(after.freeProof?.via).toBe("order");
    expect(after.card).toBeNull();
    expect(calls.some((u) => u.includes("render-background"))).toBe(true);
    expect(emails.at(-1).subject).toContain("free");
  });

  it("is one per email address", async () => {
    useSecret();
    services();
    const a = abandoned(), b = abandoned();
    seed(a, b);
    expect((await freeProof(post({ o: a.id, t: freeOrderToken(a.id) }))).status).toBe(200);
    expect((await freeProof(post({ o: b.id, t: freeOrderToken(b.id) }))).status).toBe(409);
  });

  it("rejects a forged link", async () => {
    useSecret();
    services();
    const o = abandoned();
    seed(o);
    expect((await freeProof(post({ o: o.id, t: "nope" }))).status).toBe(404);
  });

  it("goes to a payment page when the customer approves it", async () => {
    useSecret();
    const { calls } = services();
    const o = abandoned({ status: "proof_sent", freeProof: { startedAt: ago(1000), via: "order" }, renders: [{ key: "r", createdAt: ago(1000), note: null }] });
    seed(o);
    const t = sign(`proof:${o.id}`);
    const view = await (await proof(new Request(`${ORIGIN}/api/proof?o=${o.id}&t=${t}`))).json();
    expect(view).toMatchObject({ freeProof: true, prepaid: false });
    const res = await (await proof(new Request(`${ORIGIN}/api/proof`, { method: "POST", body: JSON.stringify({ o: o.id, t, action: "approve" }) }))).json();
    expect(res.checkoutUrl).toContain("checkout.stripe.com");
    expect(readOrder(o.id).status).toBe("payment_due");
    expect(calls.some((u) => u.includes("payment_intents"))).toBe(false); // no saved card to charge
  });
});

describe("the order form", () => {
  function form(email: string, free?: string) {
    const f = new FormData();
    f.set("photo", new File([new Uint8Array(10)], "car.jpg", { type: "image/jpeg" }));
    for (const [k, v] of Object.entries({ name: "Lee Ward", email, style: "studio", size: "16x20", frame: "walnut", category: "automobile",
      ship_name: "Lee Ward", ship_line1: "1 Main St", ship_city: "Boston", ship_state: "MA", ship_zip: "02101" })) f.set(k, v);
    if (free) f.set("free", free);
    return new Request(`${ORIGIN}/api/orders`, { method: "POST", body: f });
  }

  it("skips the card page only with a free link signed for that address", async () => {
    useSecret();
    services();
    const ok = await (await createOrder(form("lee@example.com", freeLeadToken("lee@example.com")), {} as any)).json();
    expect(ok.redirectUrl).toBe("/thanks.html?free=1");
    const bad = await createOrder(form("other@example.com", freeLeadToken("lee@example.com")), {} as any);
    expect(bad.status).toBe(400);
  });

  it("still sends everyone else to the card page", async () => {
    useSecret();
    services();
    const res = await (await createOrder(form("lee@example.com"), {} as any)).json();
    expect(res.checkoutUrl).toContain("checkout.stripe.com");
  });
});

describe("unsubscribe", () => {
  it("stops the reminder", async () => {
    useSecret();
    const { emails } = services();
    const o = abandoned();
    seed(o);
    const e = o.customer.email;
    expect((await unsubscribe(new Request(`${ORIGIN}/api/unsubscribe?e=${e}&t=${unsubToken(e)}`))).status).toBe(200);
    await runRecovery(ORIGIN);
    expect(emails).toEqual([]);
  });
});
