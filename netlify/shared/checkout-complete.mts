// Acts on a completed Stripe Checkout session. Called by the webhook and by the page the
// customer lands on afterwards (which also makes deploy previews work, since Stripe's
// webhook only reaches production). Each step runs once, whichever arrives first.
import { getSetupIntent } from "./stripe.mts";
import { getOrder, saveOrder, log, ordersStore, type Order } from "./store.mts";
import { triggerRender } from "./render-trigger.mts";
import { notifyOwner, sendEmail, button, esc } from "./email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "./catalog.mts";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function claim(step: string, orderId: string) {
  const { modified } = await ordersStore().set(`lock/${step}/${orderId}`, new Date().toISOString(), { onlyIfNew: true });
  return modified;
}

function saveShipping(order: Order, s: any) {
  const ship = s.collected_information?.shipping_details ?? s.shipping_details;
  const cd = s.customer_details ?? {};
  order.shipping = {
    name: ship?.name ?? cd.name ?? order.customer.name,
    phone: cd.phone ?? null,
    address: ship?.address ?? cd.address,
  };
}

export async function handleCompletedSession(origin: string, s: any) {
  if (s.status && s.status !== "complete") return;
  const order = await getOrder(s.metadata?.orderId ?? "");
  if (!order) return;
  const description = `a ${SIZES[order.size].name} ${esc(styleInfo(order.style).name)} portrait of their ${categoryInfo(order.category).subject}`;

  // New order: card saved, nothing charged yet. Start the render.
  if (s.mode === "setup" && order.status === "awaiting_card" && (await claim("setup", order.id))) {
    const si = await getSetupIntent(s.setup_intent);
    if (!si.customer || !si.payment_method) throw new Error(`Setup ${s.setup_intent} has no customer or card`);
    order.card = { customer: si.customer, paymentMethod: si.payment_method };
    order.status = "card_saved";
    log(order, `Card saved; ${money(order.price)} is due on approval`);
    await saveOrder(order);
    await triggerRender(origin, order.id, null);
    const a = order.shipping?.address;
    await sendEmail({
      to: order.customer.email,
      replyTo: Netlify.env.get("OWNER_EMAIL"),
      subject: "We've received your Burin & Co. commission",
      html: `<p>${esc(order.customer.name.split(" ")[0])},</p>
        <p>Thank you. We've received your photograph and started on the ${esc(styleInfo(order.style).name)} portrait of your ${categoryInfo(order.category).subject}.</p>
        <p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#555">
          ${SIZES[order.size].name}, ${esc(FRAMES[order.frame].toLowerCase())} frame<br>
          Total: ${money(order.price)}${a ? `<br>Ships to: ${esc(order.shipping!.name)}, ${esc(a.line1)}${a.line2 ? ", " + esc(a.line2) : ""}, ${esc(a.city)}, ${esc(a.state)} ${esc(a.postal_code)}` : ""}
        </p>
        <p>Within 48 hours we'll email you a proof. Your card has been saved but not charged; we charge it only when you approve the proof. If anything needs changing, just tell us.</p>
        <p>Questions? Reply to this email.</p><p>Burin &amp; Co.</p>`,
    });
    await notifyOwner(
      `New order: ${order.customer.name}`,
      `<p>${esc(order.customer.name)} ordered ${description}. Their card is saved and will be charged ${money(order.price)} when they approve the proof. It is rendering now, and you'll get another email when it's ready to review.</p>`,
    );
    return;
  }

  // The saved card didn't go through at approval, and they paid on the fallback page.
  if (s.mode === "payment" && order.status === "payment_due" && (await claim(`paid-${order.chargeAttempts ?? 0}`, order.id))) {
    order.status = "customer_approved";
    order.paymentIntentId = s.payment_intent;
    order.paidAt = new Date().toISOString();
    log(order, `Paid ${money(s.amount_total)} on approval (payment page)`);
    await saveOrder(order);
    await notifyOwner(
      `Approved and paid: ${order.customer.name}'s portrait is ready to print`,
      `<p>${esc(order.customer.name)} approved version ${order.renders.length} and paid ${money(s.amount_total)}. Download the print file and order it from the print lab, then mark it sent in your dashboard.</p>${button(`${origin}/admin.html#${order.id}`, "Open dashboard")}`,
    );
    return;
  }

  // Orders placed before proof-first payment were paid up front.
  if (s.mode === "payment" && order.status === "awaiting_payment" && (await claim("prepaid", order.id))) {
    saveShipping(order, s);
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    log(order, `Paid ${money(s.amount_total)}`);
    await saveOrder(order);
    await triggerRender(origin, order.id, null);
    await notifyOwner(`New order: ${order.customer.name}`, `<p>${esc(order.customer.name)} ordered ${description}. It is rendering now.</p>`);
  }
}
