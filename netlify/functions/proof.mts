import type { Config } from "@netlify/functions";
import { getOrder, saveOrder, log } from "../shared/store.mts";
import { verify } from "../shared/sign.mts";
import { chargeSavedCard, createPaymentCheckout, StripeError } from "../shared/stripe.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo, productName } from "../shared/catalog.mts";

export default async (req: Request) => {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const id = req.method === "POST" ? body.o : url.searchParams.get("o");
  const token = req.method === "POST" ? body.t : url.searchParams.get("t");

  const order = id && verify(`proof:${id}`, token) ? await getOrder(id) : null;
  if (!order) return Response.json({ error: "This proof link isn't valid. Use the link from your email." }, { status: 404 });

  const origin = url.origin;
  const latest = order.renders.at(-1);

  if (req.method === "GET") {
    return Response.json({
      firstName: order.customer.name.split(" ")[0],
      style: styleInfo(order.style).name,
      size: SIZES[order.size].name,
      frame: FRAMES[order.frame],
      subject: categoryInfo(order.category).subject,
      plaque: order.plaque,
      caption: order.caption ?? "",
      version: order.renders.length,
      renderUrl: latest ? `${origin}/api/proof-image?o=${order.id}&t=${encodeURIComponent(token)}&v=${order.renders.length}&c=${encodeURIComponent(order.caption ?? "")}` : null,
      price: order.price,
      // Orders from before proof-first payment were paid at checkout.
      prepaid: !order.card,
      awaitingResponse: order.status === "proof_sent" || order.status === "payment_due",
      paymentDue: order.status === "payment_due",
    });
  }

  const awaiting = order.status === "proof_sent" || (order.status === "payment_due" && body.action === "approve");
  if (!awaiting) {
    return Response.json({ error: "We already have your response to this proof. We'll email you if we need anything else." }, { status: 409 });
  }
  const admin = button(`${origin}/admin.html#${order.id}`, "Open dashboard");
  const amount = `$${(order.price / 100).toFixed(2)}`;

  if (body.action === "approve") {
    const v = order.renders.length;
    if (order.card && order.status === "proof_sent") {
      order.chargeAttempts = (order.chargeAttempts ?? 0) + 1;
      try {
        const pi = await chargeSavedCard({
          orderId: order.id, customer: order.card.customer, paymentMethod: order.card.paymentMethod,
          amount: order.price, description: productName(order), email: order.customer.email, attempt: order.chargeAttempts,
        });
        if (pi.status !== "succeeded") throw new StripeError(`Payment ${pi.status}`, pi.status);
        order.paymentIntentId = pi.id;
        order.paidAt = new Date().toISOString();
        log(order, `Customer approved version ${v}; charged ${amount}`);
      } catch (e) {
        if (!(e instanceof StripeError)) throw e;
        // Declined, or the bank wants the customer to confirm: send them to a normal payment page.
        order.status = "payment_due";
        log(order, `Customer approved version ${v}; saved card not charged (${e.message})`);
      }
    } else if (!order.card) {
      log(order, `Customer approved version ${v}`);
    }

    if (order.status === "payment_due") {
      const session = await createPaymentCheckout({
        orderId: order.id, customer: order.card?.customer, email: order.customer.email, amount: order.price,
        productName: productName(order),
        successUrl: `${origin}/proof.html?o=${order.id}&t=${encodeURIComponent(token)}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/proof.html?o=${order.id}&t=${encodeURIComponent(token)}`,
      });
      await saveOrder(order);
      return Response.json({ status: order.status, checkoutUrl: session.url });
    }

    order.status = "customer_approved";
    await saveOrder(order);
    await notifyOwner(
      `Approved: ${order.customer.name}'s portrait is ready to print`,
      `<p>${esc(order.customer.name)} approved version ${v}${order.card ? ` and their card was charged ${amount}` : ""}. Download the print file and order it from the print lab, then mark it sent in your dashboard.</p>${admin}`,
    );
    return Response.json({ status: order.status });
  }

  if (body.action === "changes") {
    const note = String(body.note ?? "").trim().slice(0, 1000);
    if (!note) return Response.json({ error: "Tell us what you'd like changed." }, { status: 400 });
    order.changeRequests.push({ at: new Date().toISOString(), note, version: order.renders.length });
    order.status = "changes_requested";
    log(order, "Customer requested changes");
    await saveOrder(order);
    await notifyOwner(
      `Change request: ${order.customer.name}`,
      `<p>${esc(order.customer.name)} asked for changes to version ${order.renders.length}:</p><blockquote style="border-left:3px solid #A47B2C;margin:0;padding-left:12px">${esc(note)}</blockquote>${admin}`,
    );
    return Response.json({ status: order.status });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
};

export const config: Config = { path: "/api/proof" };
