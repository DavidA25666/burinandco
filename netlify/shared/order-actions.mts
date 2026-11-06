// Order actions shared by the old password dashboard (/admin.html) and Tenfold HQ (/api/ops/actions).
import { saveOrder, log, type Order } from "./store.mts";
import { fileUrl, sign } from "./sign.mts";
import { triggerRender, triggerPrintFile } from "./render-trigger.mts";
import { sendEmail, button, esc } from "./email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "./catalog.mts";
import { cleanCaption } from "./caption.mts";
import { createFinerworksOrder, finerworksCode, codeEnvName, fetchFinerworksStatus } from "./finerworks.mts";
import { refundPayment, paymentFee } from "./stripe.mts";
import { aiSpendThisMonth, getSettings } from "./ops-store.mts";

export class ActionError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const refuse = (message: string, code = "not_allowed", status = 409) => { throw new ActionError(status, code, message); };

// Why the current print file can't go to the lab as it is, or null if it can.
export function printFileProblem(o: Order) {
  const n = o.renders.length;
  if (!n) return "There's no rendering to print.";
  if (o.printStatus === "preparing") return "The print file is still being made.";
  if (!o.printFile) return `Make the print file from v${n} first.`;
  if (o.printFile.version !== n) return `The print file is from v${o.printFile.version}, but the newest version is v${n}. Make the print file again.`;
  if ((o.printFile.caption ?? null) !== (o.caption ?? "")) return "The caption changed (or wasn't recorded) since the print file was made. Make the print file again.";
  return null;
}

// At the monthly AI cap, owner-started AI runs stop when HQ's "AI cap blocks orders" switch is on.
async function aiAllowed() {
  const s = await getSettings();
  if (!s.aiCapBlocksOrders) return;
  const spent = await aiSpendThisMonth();
  if (spent >= s.aiMonthlyCapCents) refuse(`This month's AI budget ($${(s.aiMonthlyCapCents / 100).toFixed(2)}) is used up. Raise it in HQ to continue.`, "ai_cap_reached");
}

export interface ActionParams { note?: string | null; force?: boolean; amountCents?: number | null; reason?: string | null; requestId?: string | null }

export const ORDER_ACTIONS = ["regenerate", "send_proof", "prepare_print", "send_to_finerworks", "mark_sent_to_print", "set_caption", "archive", "retry_order", "refund_order", "resend_email", "mark_test", "refresh_status"] as const;
export type OrderAction = typeof ORDER_ACTIONS[number];

function proofEmail(origin: string, order: Order) {
  const link = `${origin}/proof.html?o=${order.id}&t=${sign(`proof:${order.id}`)}`;
  const first = esc(order.customer.name.split(" ")[0]);
  const subject = categoryInfo(order.category).subject;
  // Versions the studio makes before the customer has seen anything are invisible to them:
  // only say "updated" once they've had a proof, and only mention notes if they sent some.
  const askedForChanges = (order.changeRequests?.length ?? 0) > 0;
  const updated = askedForChanges || !!order.proofSentAt;
  const opening = askedForChanges ? "We've updated your portrait based on your notes."
    : updated ? `We've made an updated version of the portrait of your ${subject}.`
    : `The portrait of your ${subject} is ready for your review.`;
  return {
    to: order.customer.email,
    subject: updated ? "Your updated Burin & Co. proof" : "Your Burin & Co. proof is ready",
    html: `<p>${first},</p><p>${opening} Approve it and we'll print and frame it. If anything is off, tell us what to change.</p>${button(link, "Review your proof")}<p>${order.card ? `Your card is charged $${(order.price / 100).toFixed(2)} only when you approve. Changes cost nothing.` : "Nothing prints until you approve it."}</p><p>Burin &amp; Co.</p>`,
  };
}

function shippingEmail(order: Order) {
  const ship = order.finerworks?.shipments?.find((s) => s.trackingNumber || s.trackingUrl);
  if (!ship) return null;
  const first = esc(order.customer.name.split(" ")[0]);
  const track = ship.trackingUrl ? button(ship.trackingUrl, "Track your package") : "";
  return {
    to: order.customer.email,
    subject: "Your Burin & Co. portrait has shipped",
    html: `<p>${first},</p><p>Your framed portrait is on its way${order.shipping?.name && order.shipping.name !== order.customer.name ? ` to ${esc(order.shipping.name)}` : ""}.${ship.trackingNumber ? ` The tracking number is <strong>${esc(ship.trackingNumber)}</strong>${ship.carrier ? ` (${esc(ship.carrier)})` : ""}.` : ""}</p>${track}<p>If it arrives with any damage, reply with a photo of the piece and the box and we'll make it right.</p><p>Burin &amp; Co.</p>`,
  };
}

/**
 * Pulls what the store doesn't hear about by itself: the real Stripe fee if the webhook missed it,
 * and FinerWorks' status, tracking and what it charged. Emails the customer their tracking the first
 * time it appears (the proof page promises it). Saves the order. Used by HQ's "Refresh status" and
 * by the 6-hourly sync.
 */
export async function refreshOrder(order: Order): Promise<string[]> {
  const notes: string[] = [];
  if (order.paymentIntentId && order.stripeFeeCents == null) {
    try {
      const f = await paymentFee(order.paymentIntentId);
      if (f.feeCents != null) { order.stripeFeeCents = f.feeCents; order.chargeId ??= f.chargeId ?? undefined; notes.push(`Stripe fee $${(f.feeCents / 100).toFixed(2)}`); }
    } catch (e) { notes.push(`Stripe: ${e instanceof Error ? e.message : "lookup failed"}`); }
  }
  const fw = order.finerworks;
  if (fw?.orderId != null && !fw.testMode) {
    try {
      const st = await fetchFinerworksStatus(fw.orderId);
      const hadTracking = !!fw.shipments?.length;
      fw.status = st.status ?? fw.status ?? null;
      if (st.shipments.length) fw.shipments = st.shipments;
      if (st.costCents != null) fw.costCents = st.costCents;
      fw.checkedAt = new Date().toISOString();
      notes.push(`FinerWorks: ${fw.status ?? "no status yet"}${st.costCents != null ? `, charged $${(st.costCents / 100).toFixed(2)}` : ""}`);
      if (!hadTracking && fw.shipments?.length) log(order, `FinerWorks shipped it: ${fw.shipments.map((x) => x.trackingNumber ?? x.trackingUrl).join(", ")}`);
      const mail = shippingEmail(order);
      if (mail && !order.shippingEmailSentAt) {
        if (await sendEmail(mail)) { order.shippingEmailSentAt = new Date().toISOString(); log(order, "Shipping email with tracking sent to customer"); notes.push("tracking emailed to the customer"); }
      }
    } catch (e) { notes.push(`FinerWorks: ${e instanceof Error ? e.message : "lookup failed"}`); }
  } else if (fw?.testMode) notes.push("FinerWorks test order: nothing to track");
  await saveOrder(order);
  return notes;
}

/** Runs one action on an order and returns the order as it is afterwards. */
export async function runOrderAction(origin: string, action: string, order: Order, p: ActionParams = {}): Promise<{ order: Order; message: string }> {
  const { note, force } = p;
  switch (action) {
    case "regenerate": {
      if (order.status === "rendering") refuse("This order is already rendering.");
      if (order.status === "sent_to_print") refuse("This order has already gone to print.");
      await aiAllowed();
      await triggerRender(origin, order.id, String(note ?? "").trim() || null);
      return { order: { ...order, status: "rendering" }, message: "Regenerating. The new version shows up in a few minutes." };
    }

    case "send_proof": {
      const version = order.renders.length;
      if (!version) refuse("There's no rendering to send yet.");
      const sent = await sendEmail(proofEmail(origin, order));
      if (!sent) refuse("The email didn't send. Check RESEND_API_KEY and FROM_EMAIL in Netlify.", "email_failed", 502);
      order.status = "proof_sent";
      order.proofSentAt ??= new Date().toISOString();
      log(order, `Proof v${version} sent to customer`);
      await saveOrder(order);
      return { order, message: `Proof v${version} emailed to the customer.` };
    }

    case "prepare_print": {
      if (!order.renders.length) refuse("There's no rendering to print.");
      if (order.printStatus === "preparing") refuse("The print file is already being made.");
      if (order.status !== "customer_approved" && order.status !== "sent_to_print" && !force) refuse("The customer hasn't approved this proof yet.");
      await aiAllowed();
      await triggerPrintFile(origin, order.id);
      return { order: { ...order, printStatus: "preparing" }, message: "Making the print file (upscale + layout). It takes a few minutes." };
    }

    // Places the order with FinerWorks through its API: a test order until FINERWORKS_LIVE is "true".
    case "send_to_finerworks": {
      if (order.status === "sent_to_print") refuse("This order has already gone to print.");
      if (order.status !== "customer_approved" && !force) refuse("The customer hasn't approved this proof yet.");
      // Never ship unpaid work. Card orders are charged when the customer approves.
      if (!order.paidAt) refuse(order.status === "payment_due" ? "The customer approved, but their card was declined. Wait for them to pay on the payment page." : "This order isn't paid yet. The card is charged when the customer approves the proof.");
      const problem = printFileProblem(order);
      if (problem) refuse(problem);
      const code = finerworksCode(order.size, order.frame);
      if (!code) refuse(`No FinerWorks product code is set for ${SIZES[order.size].name} with a ${FRAMES[order.frame].toLowerCase()} frame. Add ${codeEnvName(order.size, order.frame) ?? "it"} in Netlify, or place this one by hand in FinerWorks and mark it sent.`);
      const file = order.printFile!;
      const title = `Burin & Co. ${styleInfo(order.style).name}, ${SIZES[order.size].name}`;
      let result: Awaited<ReturnType<typeof createFinerworksOrder>>;
      try {
        result = await createFinerworksOrder(order, { url: fileUrl(origin, file.key), width: file.width, height: file.height }, code!, title);
      } catch (e) {
        // Kept on the order so HQ raises it (a declined FinerWorks card is critical).
        const message = e instanceof Error ? e.message : String(e);
        order.finerworksError = { at: new Date().toISOString(), message: message.slice(0, 500) };
        log(order, `FinerWorks refused the order: ${message.slice(0, 200)}`);
        await saveOrder(order);
        throw new ActionError(502, "vendor_error", message);
      }
      order.finerworksError = null;
      const ref = result.confirmationId ?? result.orderId ?? "(no number returned)";
      order.finerworks = { ...result, productCode: code!, printVersion: file.version };
      order.printOrderRef = `FinerWorks${result.testMode ? " TEST" : ""} ${ref}`;
      order.status = "sent_to_print";
      order.sentToPrintAt = new Date().toISOString();
      log(order, result.testMode ? `FinerWorks TEST order ${ref} created from v${file.version} (not billed or printed)` : `FinerWorks order ${ref} placed from v${file.version}`);
      await saveOrder(order);
      return { order, message: result.testMode ? `FinerWorks TEST order ${ref} created (not billed or printed).` : `FinerWorks order ${ref} placed.` };
    }

    // Placed by hand in FinerWorks (or another lab): record it here.
    case "mark_sent_to_print": {
      if (order.status === "sent_to_print") refuse("This order is already marked as sent to print.");
      if (order.status !== "customer_approved" && !force) refuse("The customer hasn't approved this proof yet.");
      if (!order.renders.length) refuse("There's no rendering to print.");
      order.printOrderRef = String(note ?? "").trim().slice(0, 120) || undefined;
      order.status = "sent_to_print";
      order.sentToPrintAt = new Date().toISOString();
      log(order, `Sent to print${order.printOrderRef ? ` (${order.printOrderRef})` : ""}`);
      await saveOrder(order);
      return { order, message: "Marked as sent to print." };
    }

    case "set_caption": {
      if (order.status === "sent_to_print") refuse("This order has already gone to print.");
      const caption = cleanCaption(note);
      if (caption === (order.caption ?? "")) return { order, message: "Caption unchanged." };
      if (caption) order.caption = caption; else delete order.caption;
      log(order, caption ? `Caption set to "${caption}"` : "Caption removed");
      await saveOrder(order);
      return { order, message: caption ? `Caption set to "${caption}". Make the print file again if one exists.` : "Caption removed." };
    }

    case "archive": {
      order.status = "archived";
      log(order, "Archived");
      await saveOrder(order);
      return { order, message: "Archived." };
    }

    // Re-runs the step that failed: the rendering or the print file.
    case "retry_order": {
      if (order.status === "render_failed") {
        await triggerRender(origin, order.id, null);
        return { order: { ...order, status: "rendering" }, message: "Rendering again." };
      }
      if (order.printStatus === "failed") {
        await triggerPrintFile(origin, order.id);
        return { order: { ...order, printStatus: "preparing" }, message: "Making the print file again." };
      }
      refuse("Nothing has failed on this order, so there's nothing to retry.");
      break;
    }

    // Refunds the payment (all of it, or amountCents) and cancels the order if it hasn't gone to print.
    // An order whose card was saved but never charged is simply cancelled.
    case "refund_order": {
      if (order.status === "refunded") refuse("This order has already been refunded.");
      if (!order.paymentIntentId) {
        if (order.paidAt) refuse("This order was paid before payment ids were recorded. Refund it in Stripe.");
        order.status = "archived";
        log(order, `Cancelled from HQ before any charge${p.reason ? `: ${p.reason}` : ""}`);
        await saveOrder(order);
        return { order, message: "Nothing was charged on this order, so it was cancelled with no refund needed." };
      }
      const already = order.refundedCents ?? 0;
      const amount = p.amountCents ?? order.price - already;
      if (amount <= 0 || amount + already > order.price) refuse(`Refund must be between $0.01 and $${((order.price - already) / 100).toFixed(2)}.`, "invalid_params", 400);
      const refund = await refundPayment({ paymentIntent: order.paymentIntentId, amount, reason: p.reason ?? undefined, orderId: order.id, requestId: p.requestId ?? String(Date.now()) });
      order.refundedCents = already + refund.amount;
      order.refundedAt = new Date().toISOString();
      const full = order.refundedCents >= order.price;
      const notPrinted = order.status !== "sent_to_print";
      if (full) order.status = "refunded";
      log(order, `Refunded $${(refund.amount / 100).toFixed(2)} from HQ${p.reason ? ` (${p.reason})` : ""}${full && notPrinted ? "; order cancelled before print" : ""}`);
      await saveOrder(order);
      return { order, message: `Refunded $${(refund.amount / 100).toFixed(2)}.${full && notPrinted ? " The order was cancelled before it went to print." : full ? " It had already gone to FinerWorks: cancel it there if it hasn't shipped." : ""}` };
    }

    // Sends the customer's latest email again: the proof while it waits on them, or the shipping email.
    case "resend_email": {
      const which = String(note ?? "").trim().toLowerCase();
      const ship = shippingEmail(order);
      const wantShip = which === "shipping" || (!which && !!ship);
      if (wantShip) {
        if (!ship) refuse("FinerWorks hasn't reported tracking for this order yet. Use Refresh status first.");
        if (!(await sendEmail(ship!))) refuse("The email didn't send. Check RESEND_API_KEY and FROM_EMAIL in Netlify.", "email_failed", 502);
        order.shippingEmailSentAt = new Date().toISOString();
        log(order, "Shipping email resent from HQ");
        await saveOrder(order);
        return { order, message: "Shipping email with tracking sent again." };
      }
      if (!["proof_sent", "payment_due"].includes(order.status) || !order.renders.length) refuse("There's no email to resend: this order isn't waiting on the customer and hasn't shipped.");
      if (!(await sendEmail(proofEmail(origin, order)))) refuse("The email didn't send. Check RESEND_API_KEY and FROM_EMAIL in Netlify.", "email_failed", 502);
      log(order, `Proof v${order.renders.length} email resent from HQ`);
      await saveOrder(order);
      return { order, message: `Proof v${order.renders.length} email sent again.` };
    }

    // Owners' and partners' own orders: out of every number. "off" makes a flagged order count again.
    case "mark_test": {
      const v = String(note ?? "on").trim().toLowerCase();
      const on = !["off", "false", "no", "0"].includes(v);
      order.testOverride = on;
      log(order, on ? "Marked as a test order in HQ" : "Marked as a real order in HQ");
      await saveOrder(order);
      return { order, message: on ? "Marked as a test order. It's left out of revenue and profit." : "Marked as a real order. It counts again." };
    }

    case "refresh_status": {
      const notes = await refreshOrder(order);
      return { order, message: notes.length ? `Refreshed: ${notes.join("; ")}.` : "Nothing new to refresh." };
    }
  }
  throw new ActionError(400, "unknown_action", `Unknown action "${action}".`);
}
