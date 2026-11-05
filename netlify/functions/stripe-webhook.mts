import type { Config } from "@netlify/functions";
import { verifyStripeSignature, getBalanceTransaction } from "../shared/stripe.mts";
import { handleCompletedSession } from "../shared/checkout-complete.mts";
import { getOrder, saveOrder, log, listOrders, type Order } from "../shared/store.mts";
import { recordWebhook, saveDispute } from "../shared/ops-store.mts";

// Stripe webhook, signature-checked. Listens at /api/stripe/webhook (the old /api/stripe-webhook
// path keeps working until the endpoint in Stripe is moved). Events:
// checkout.session.completed, checkout.session.async_payment_succeeded, payment_intent.succeeded,
// payment_intent.payment_failed, charge.succeeded, charge.updated, charge.refunded,
// charge.dispute.created, charge.dispute.closed.

async function orderFor(obj: any): Promise<Order | null> {
  const id = obj?.metadata?.orderId;
  if (id) return getOrder(id);
  const pi = typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
  if (!pi) return null;
  return (await listOrders()).find((o) => o.paymentIntentId === pi) ?? null;
}

async function handle(origin: string, event: any) {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCompletedSession(origin, obj);
      return;

    case "payment_intent.succeeded": {
      const order = await orderFor(obj);
      if (!order) return;
      order.livemode = !!event.livemode;
      if (!order.paymentIntentId) order.paymentIntentId = obj.id;
      await saveOrder(order);
      return;
    }

    case "payment_intent.payment_failed": {
      const order = await orderFor(obj);
      if (!order) return;
      log(order, `Stripe: payment failed (${obj.last_payment_error?.decline_code ?? obj.last_payment_error?.code ?? "declined"})`);
      await saveOrder(order);
      return;
    }

    // Record the real Stripe fee once the balance transaction exists (charge.updated carries it if charge.succeeded didn't).
    case "charge.succeeded":
    case "charge.updated": {
      const order = await orderFor(obj);
      if (!order || order.stripeFeeCents != null) return;
      order.chargeId = obj.id;
      order.livemode = !!event.livemode;
      const bt = typeof obj.balance_transaction === "string" ? obj.balance_transaction : obj.balance_transaction?.id;
      if (bt) {
        try { order.stripeFeeCents = (await getBalanceTransaction(bt)).fee; } catch (e) { console.warn("No balance transaction access:", e instanceof Error ? e.message : e); }
      }
      await saveOrder(order);
      return;
    }

    case "charge.refunded": {
      const order = await orderFor(obj);
      if (!order) return;
      const total = Number(obj.amount_refunded ?? 0);
      if (total === (order.refundedCents ?? 0)) return; // already recorded (refund made from HQ)
      order.refundedCents = total;
      order.refundedAt = new Date((obj.refunds?.data?.[0]?.created ?? Date.now() / 1000) * 1000).toISOString();
      if (total >= order.price) order.status = "refunded";
      log(order, `Stripe: refunded $${(total / 100).toFixed(2)} in total`);
      await saveOrder(order);
      return;
    }

    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const order = await orderFor({ payment_intent: obj.payment_intent, metadata: obj.metadata });
      await saveDispute({
        id: obj.id, charge: typeof obj.charge === "string" ? obj.charge : null, orderId: order?.id ?? null, amountCents: obj.amount ?? 0,
        status: obj.status ?? (event.type.endsWith("closed") ? "closed" : "needs_response"), reason: obj.reason ?? null,
        createdAt: new Date((obj.created ?? Date.now() / 1000) * 1000).toISOString(), updatedAt: new Date().toISOString(),
      });
      if (order) { log(order, `Stripe: dispute ${obj.status} (${obj.reason ?? "no reason"})`); await saveOrder(order); }
      return;
    }
  }
}

export default async (req: Request) => {
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const raw = await req.text();
  if (!secret || !verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  const at = new Date().toISOString();
  try {
    await handle(new URL(req.url).origin, event);
    await recordWebhook({ at, type: event.type, ok: true, livemode: !!event.livemode });
    return new Response("ok");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("Stripe webhook failed", event.type, error);
    await recordWebhook({ at, type: event.type, ok: false, error, livemode: !!event.livemode }).catch(() => {});
    return new Response("error", { status: 500 });
  }
};

export const config: Config = { path: ["/api/stripe/webhook", "/api/stripe-webhook"] };
