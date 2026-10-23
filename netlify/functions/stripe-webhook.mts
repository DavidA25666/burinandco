import type { Config } from "@netlify/functions";
import { verifyStripeSignature, getSetupIntent } from "../shared/stripe.mts";
import { getOrder, saveOrder, log, type Order } from "../shared/store.mts";
import { triggerRender } from "../shared/render-trigger.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";
import { SIZES, styleInfo, categoryInfo } from "../shared/catalog.mts";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function saveShipping(order: Order, s: any) {
  const ship = s.collected_information?.shipping_details ?? s.shipping_details;
  const cd = s.customer_details ?? {};
  order.shipping = {
    name: ship?.name ?? cd.name ?? order.customer.name,
    phone: cd.phone ?? null,
    address: ship?.address ?? cd.address,
  };
}

export default async (req: Request) => {
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const raw = await req.text();
  if (!secret || !verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed") return new Response("ignored");

  const s = event.data.object;
  const order = await getOrder(s.metadata?.orderId ?? "");
  if (!order) return new Response("ok");
  const origin = new URL(req.url).origin;
  const description = `a ${SIZES[order.size].name} ${esc(styleInfo(order.style).name)} portrait of their ${categoryInfo(order.category).subject}${order.collector ? " (collector edition)" : ""}`;

  // New order: card saved, nothing charged yet. Start the render.
  if (s.mode === "setup" && order.status === "awaiting_card") {
    const si = await getSetupIntent(s.setup_intent);
    if (!si.customer || !si.payment_method) throw new Error(`Setup ${s.setup_intent} has no customer or card`);
    order.card = { customer: si.customer, paymentMethod: si.payment_method };
    saveShipping(order, s);
    order.status = "card_saved";
    log(order, `Card saved; ${money(order.price)} is due on approval`);
    await saveOrder(order);
    await triggerRender(origin, order.id, null);
    await notifyOwner(
      `New order: ${order.customer.name}`,
      `<p>${esc(order.customer.name)} ordered ${description}. Their card is saved and will be charged ${money(order.price)} when they approve the proof. It is rendering now, and you'll get another email when it's ready to review.</p>`,
    );
    return new Response("ok");
  }

  // The saved card didn't go through at approval, and they paid on the fallback page.
  if (s.mode === "payment" && order.status === "payment_due") {
    order.status = "customer_approved";
    order.paymentIntentId = s.payment_intent;
    order.paidAt = new Date().toISOString();
    log(order, `Paid ${money(s.amount_total)} on approval (payment page)`);
    await saveOrder(order);
    await notifyOwner(
      `Approved and paid: ${order.customer.name}'s portrait is ready to print`,
      `<p>${esc(order.customer.name)} approved version ${order.renders.length} and paid ${money(s.amount_total)}. Download the print file and order it from the print lab, then mark it sent in your dashboard.</p>${button(`${origin}/admin.html#${order.id}`, "Open dashboard")}`,
    );
    return new Response("ok");
  }

  // Orders placed before proof-first payment were paid up front.
  if (s.mode === "payment" && order.status === "awaiting_payment") {
    saveShipping(order, s);
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    log(order, `Paid ${money(s.amount_total)}`);
    await saveOrder(order);
    await triggerRender(origin, order.id, null);
    await notifyOwner(`New order: ${order.customer.name}`, `<p>${esc(order.customer.name)} ordered ${description}. It is rendering now.</p>`);
  }
  return new Response("ok");
};

export const config: Config = { path: "/api/stripe-webhook" };
