// Background function: up to 15 minutes to render. Invoked by the webhook or the dashboard.
import { getOrder, saveOrder, log, filesStore } from "../shared/store.mts";
import { verify, fileUrl } from "../shared/sign.mts";
import { renderIllustration } from "../shared/replicate.mts";
import { buildPrompt, aspectFor } from "../shared/catalog.mts";
import { notifyOwner, button, esc } from "../shared/email.mts";

export default async (req: Request) => {
  const { orderId, adjustment } = await req.json();
  if (!verify(`render:${orderId}`, req.headers.get("x-internal-sig"))) return;
  const order = await getOrder(orderId);
  if (!order) return;

  const origin = new URL(req.url).origin;
  order.status = "rendering";
  log(order, adjustment ? `Regenerating with note: ${adjustment}` : "Rendering started");
  await saveOrder(order);

  try {
    const prompt = buildPrompt(order.style, order.category, order.notes, adjustment);
    const outputUrl = await renderIllustration(fileUrl(origin, order.photoKey), prompt, aspectFor(order.size, order.category));

    // Replicate's links expire, so keep our own copy.
    const img = await fetch(outputUrl);
    if (!img.ok) throw new Error("Couldn't download the finished image.");
    const version = order.renders.length + 1;
    const key = `render/${order.id}/${version}`;
    await filesStore().set(key, await img.arrayBuffer());

    order.renders.push({ key, createdAt: new Date().toISOString(), note: adjustment ?? null });
    order.status = "needs_review";
    delete order.lastError;
    log(order, `Version ${version} ready for review`);
    await saveOrder(order);
    await notifyOwner(
      `Ready to review: ${order.customer.name}'s portrait (v${version})`,
      `<p>Version ${version} of ${esc(order.customer.name)}'s portrait is ready. Check it against the original photo, then send the proof or regenerate.</p>${button(`${origin}/admin.html#${order.id}`, "Review in dashboard")}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    order.status = "render_failed";
    order.lastError = message;
    log(order, `Rendering failed: ${message}`);
    await saveOrder(order);
    await notifyOwner(
      `Rendering failed: ${order.customer.name}`,
      `<p>${esc(message)}</p>${button(`${origin}/admin.html#${order.id}`, "Open dashboard")}`,
    );
  }
};
