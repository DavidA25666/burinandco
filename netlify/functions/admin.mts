import type { Config } from "@netlify/functions";
import { getOrder, saveOrder, listOrders, log, type Order } from "../shared/store.mts";
import { isAdmin, fileUrl, sign } from "../shared/sign.mts";
import { triggerRender, triggerPrintFile } from "../shared/render-trigger.mts";
import { sendEmail, button, esc } from "../shared/email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../shared/catalog.mts";

function view(o: Order, origin: string) {
  return {
    ...o,
    categoryName: categoryInfo(o.category).name,
    styleName: styleInfo(o.style).name,
    sizeName: SIZES[o.size].name,
    frameName: FRAMES[o.frame],
    photoUrl: fileUrl(origin, o.photoKey),
    renders: o.renders.map((r) => ({ ...r, url: fileUrl(origin, r.key) })),
    printFileUrl: o.printFile ? fileUrl(origin, o.printFile.key) : null,
  };
}

const fail = (error: string, status = 409) => Response.json({ error }, { status });

export default async (req: Request) => {
  if (!isAdmin(req)) return fail("Wrong password.", 401);
  const origin = new URL(req.url).origin;

  try {
    if (req.method === "GET") {
      const showAll = new URL(req.url).searchParams.get("all") === "1";
      const orders = (await listOrders()).filter(
        (o) => showAll || (o.status !== "archived" && o.status !== "awaiting_payment" && o.status !== "awaiting_card"),
      );
      return Response.json({ orders: orders.map((o) => view(o, origin)) });
    }

    const { action, id, note, force } = await req.json();
    const order = await getOrder(id);
    if (!order) return fail("Order not found.", 404);

    switch (action) {
      case "regenerate": {
        if (order.status === "rendering") return fail("This order is already rendering.");
        if (order.status === "sent_to_print") return fail("This order has already gone to print.");
        await triggerRender(origin, order.id, String(note ?? "").trim() || null);
        return Response.json({ order: view({ ...order, status: "rendering" }, origin) });
      }

      case "send_proof": {
        const version = order.renders.length;
        if (!version) return fail("There's no rendering to send yet.");
        const link = `${origin}/proof.html?o=${order.id}&t=${sign(`proof:${order.id}`)}`;
        const first = esc(order.customer.name.split(" ")[0]);
        const subject = categoryInfo(order.category).subject;
        const sent = await sendEmail({
          to: order.customer.email,
          replyTo: Netlify.env.get("OWNER_EMAIL"),
          subject: version > 1 ? "Your updated Burin & Co. proof" : "Your Burin & Co. proof is ready",
          html: `<p>${first},</p><p>${version > 1 ? "We've updated your portrait based on your notes." : `The portrait of your ${subject} is ready for your review.`} Approve it and we'll print and frame it. If anything is off, tell us what to change.</p>${button(link, "Review your proof")}<p>${order.card ? `Your card is charged $${(order.price / 100).toFixed(2)} only when you approve. Changes cost nothing.` : "Nothing prints until you approve it."}</p><p>Burin &amp; Co.</p>`,
        });
        if (!sent) return fail("The email didn't send. Check RESEND_API_KEY and FROM_EMAIL in Netlify.", 502);
        order.status = "proof_sent";
        log(order, `Proof v${version} sent to customer`);
        await saveOrder(order);
        return Response.json({ order: view(order, origin) });
      }

      case "prepare_print": {
        if (!order.renders.length) return fail("There's no rendering to print.");
        if (order.printStatus === "preparing") return fail("The print file is already being made.");
        if (order.status !== "customer_approved" && order.status !== "sent_to_print" && !force) return fail("The customer hasn't approved this proof yet.");
        await triggerPrintFile(origin, order.id);
        return Response.json({ order: view({ ...order, printStatus: "preparing" }, origin) });
      }

      // No print lab is connected yet: download the file, order it from the lab, then record it here.
      case "mark_sent_to_print": {
        if (order.status === "sent_to_print") return fail("This order is already marked as sent to print.");
        if (order.status !== "customer_approved" && !force) return fail("The customer hasn't approved this proof yet.");
        if (!order.renders.length) return fail("There's no rendering to print.");
        order.printOrderRef = String(note ?? "").trim().slice(0, 120) || undefined;
        order.status = "sent_to_print";
        log(order, `Sent to print${order.printOrderRef ? ` (${order.printOrderRef})` : ""}`);
        await saveOrder(order);
        return Response.json({ order: view(order, origin) });
      }

      case "archive": {
        order.status = "archived";
        log(order, "Archived");
        await saveOrder(order);
        return Response.json({ order: view(order, origin) });
      }
    }
    return fail("Unknown action.", 400);
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Something went wrong.", 500);
  }
};

export const config: Config = { path: "/api/admin" };
