import type { Config } from "@netlify/functions";
import { getOrder, saveOrder, log } from "../shared/store.mts";
import { verify } from "../shared/sign.mts";
import { triggerRender } from "../shared/render-trigger.mts";
import { sendEmail, notifyOwner, button, esc } from "../shared/email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../shared/catalog.mts";
import { getSettings } from "../shared/ops-store.mts";
import { claimFreeProof, markFree, freeStartedEmail } from "../shared/recovery.mts";

// The reminder email's "Draw my free proof" link, for someone who left Stripe's card page.
// GET only describes the order (mail scanners open links); the page's button POSTs to start drawing.
export default async (req: Request) => {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const id = String((req.method === "POST" ? body.o : url.searchParams.get("o")) ?? "");
  const token = req.method === "POST" ? body.t : url.searchParams.get("t");
  const order = id && verify(`free:${id}`, token) ? await getOrder(id) : null;
  if (!order) return Response.json({ error: "This link isn't valid. Use the link from your email." }, { status: 404 });

  const started = !!order.freeProof || order.status !== "awaiting_card";
  if (req.method === "GET") {
    return Response.json({
      firstName: order.customer.name.split(" ")[0],
      subject: categoryInfo(order.category).subject,
      style: styleInfo(order.style).name,
      size: SIZES[order.size].name,
      frame: FRAMES[order.frame],
      price: order.price,
      started,
    });
  }
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (started) return Response.json({ status: "started" });
  if ((await getSettings()).maintenance) return Response.json({ error: "We're not taking new commissions for a short while. Please try again soon." }, { status: 503 });
  if (!(await claimFreeProof(order.customer.email, order.id))) {
    return Response.json({ error: "This email address has already had its free proof. You can still order as usual from our home page." }, { status: 409 });
  }

  markFree(order, "order");
  await saveOrder(order);
  const origin = url.origin;
  try {
    await triggerRender(origin, order.id, null);
  } catch (e) {
    order.status = "render_failed";
    order.lastError = e instanceof Error ? e.message : String(e);
    log(order, `Rendering failed to start: ${order.lastError}`);
    await saveOrder(order);
  }
  await sendEmail(freeStartedEmail(order));
  await notifyOwner(
    `Free proof: ${order.customer.name}`,
    `<p>${esc(order.customer.name)} came back from the reminder email and asked for a free proof. No card is on file; they pay when they approve.</p>${button(`${origin}/admin.html#${order.id}`, "Open dashboard")}`,
  );
  return Response.json({ status: "started" });
};

export const config: Config = { path: "/api/free-proof" };
