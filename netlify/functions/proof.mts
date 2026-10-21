import type { Config } from "@netlify/functions";
import { getOrder, saveOrder, log } from "../shared/store.mts";
import { verify, fileUrl } from "../shared/sign.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";
import { SIZES, FRAMES, styleInfo, categoryInfo } from "../shared/catalog.mts";

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
      version: order.renders.length,
      renderUrl: latest ? fileUrl(origin, latest.key) : null,
      awaitingResponse: order.status === "proof_sent",
    });
  }

  if (order.status !== "proof_sent") {
    return Response.json({ error: "We already have your response to this proof. We'll email you if we need anything else." }, { status: 409 });
  }
  const admin = button(`${origin}/admin.html#${order.id}`, "Open dashboard");

  if (body.action === "approve") {
    order.status = "customer_approved";
    log(order, `Customer approved version ${order.renders.length}`);
    await saveOrder(order);
    await notifyOwner(
      `Approved: ${order.customer.name}'s engraving is ready to print`,
      `<p>${esc(order.customer.name)} approved version ${order.renders.length}. Download the print file and order it from the print lab, then mark it sent in your dashboard.</p>${admin}`,
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
