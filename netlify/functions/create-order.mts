import type { Config } from "@netlify/functions";
import { STYLES, SIZES, FRAMES, CATEGORIES, COLLECTOR_PRICE, type StyleId, type SizeId, type FrameId, type CategoryId, styleInfo, categoryInfo } from "../shared/catalog.mts";
import { filesStore, saveOrder, type Order } from "../shared/store.mts";
import { createCheckout } from "../shared/stripe.mts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export default async (req: Request) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  try {
    const form = await req.formData();
    const photo = form.get("photo");
    const name = String(form.get("name") ?? "").trim().slice(0, 120);
    const email = String(form.get("email") ?? "").trim().slice(0, 200);
    const style = String(form.get("style")) as StyleId;
    const size = String(form.get("size")) as SizeId;
    const frame = String(form.get("frame")) as FrameId;
    const category = String(form.get("category")) as CategoryId;
    const collector = form.get("collector") === "on" || form.get("collector") === "true";
    const notes = String(form.get("notes") ?? "").trim().slice(0, 600);
    const line = (k: string) => String(form.get(k) ?? "").replace(/[\n\r]/g, " ").trim().slice(0, 38);
    const plaque: [string, string] = [line("line1"), line("line2")];

    if (!(photo instanceof File) || photo.size === 0) return bad("Add a photograph.");
    if (photo.size > 5.5 * 1024 * 1024) return bad("That photo is too large. Use one under 5 MB.");
    if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) return bad("Upload a JPG, PNG or WebP photo.");
    if (!name) return bad("Add your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Check your email address.");
    if (!STYLES[style] || !SIZES[size] || !FRAMES[frame] || !CATEGORIES[category]) return bad("Choose a subject, style, size and frame.");
    if (!plaque[0]) return bad("Add the first line of the plaque.");

    const id = crypto.randomUUID();
    const photoKey = `photo/${id}`;
    await filesStore().set(photoKey, await photo.arrayBuffer());

    const order: Order = {
      id, createdAt: new Date().toISOString(), status: "awaiting_payment",
      customer: { name, email }, category, style, size, frame, collector,
      price: SIZES[size].price + (collector ? COLLECTOR_PRICE : 0), notes, plaque,
      photoKey, renders: [], changeRequests: [], history: [{ at: new Date().toISOString(), event: "Order started" }],
    };

    const origin = new URL(req.url).origin;
    const session = await createCheckout({
      orderId: id,
      email,
      amount: order.price,
      productName: `Burin & Co. ${styleInfo(style).name} engraving of your ${categoryInfo(category).subject}: ${SIZES[size].name}, ${FRAMES[frame].toLowerCase()} frame${collector ? ", collector edition" : ""}`,
      successUrl: `${origin}/thanks.html`,
      cancelUrl: `${origin}/#commission`,
    });
    order.stripeSessionId = session.id;
    await saveOrder(order);
    return Response.json({ checkoutUrl: session.url });
  } catch (e) {
    console.error(e);
    return bad("Checkout couldn't start. Try again in a moment.", 500);
  }
};

export const config: Config = { path: "/api/orders" };
