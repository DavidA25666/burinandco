import type { Config } from "@netlify/functions";
import { verifyStripeSignature } from "../shared/stripe.mts";
import { getOrder, saveOrder, log } from "../shared/store.mts";
import { triggerRender } from "../shared/render-trigger.mts";
import { notifyOwner, esc } from "../shared/email.mts";
import { SIZES, styleInfo, categoryInfo } from "../shared/catalog.mts";

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
  if (!order || order.status !== "awaiting_payment") return new Response("ok");

  const ship = s.collected_information?.shipping_details ?? s.shipping_details;
  const cd = s.customer_details ?? {};
  order.shipping = {
    name: ship?.name ?? cd.name ?? order.customer.name,
    phone: cd.phone ?? null,
    address: ship?.address ?? cd.address,
  };
  order.status = "paid";
  log(order, `Paid $${(s.amount_total / 100).toFixed(2)}`);
  await saveOrder(order);

  const origin = new URL(req.url).origin;
  await triggerRender(origin, order.id, null);
  await notifyOwner(
    `New order: ${order.customer.name}`,
    `<p>${esc(order.customer.name)} ordered a ${SIZES[order.size].name} ${esc(styleInfo(order.style).name)} portrait of their ${categoryInfo(order.category).subject}${order.collector ? " (collector edition)" : ""}. It is rendering now, and you'll get another email when it's ready to review.</p>`,
  );
  return new Response("ok");
};

export const config: Config = { path: "/api/stripe-webhook" };
