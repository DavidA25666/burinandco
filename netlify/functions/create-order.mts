import type { Config } from "@netlify/functions";
import { STYLES, SIZES, FRAMES, CATEGORIES, type StyleId, type SizeId, type FrameId, type CategoryId, productName } from "../shared/catalog.mts";
import { filesStore, saveOrder, type Order } from "../shared/store.mts";
import { createCardSetup } from "../shared/stripe.mts";
import { cleanCaption } from "../shared/caption.mts";

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
    const ship = (k: string, max = 100) => String(form.get(`ship_${k}`) ?? "").replace(/[\n\r]/g, " ").trim().slice(0, max);
    const shipping = {
      name: ship("name"),
      phone: ship("phone", 30) || null,
      address: { line1: ship("line1"), line2: ship("line2") || null, city: ship("city"), state: ship("state", 2).toUpperCase(), postal_code: ship("zip", 10), country: "US" },
    };
    const notes = String(form.get("notes") ?? "").trim().slice(0, 600);
    const caption = cleanCaption(form.get("caption"));

    if (!(photo instanceof File) || photo.size === 0) return bad("Add a photograph.");
    if (photo.size > 5.5 * 1024 * 1024) return bad("That photo is too large. Use one under 5 MB.");
    if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) return bad("Upload a JPG, PNG or WebP photo.");
    if (!name) return bad("Add your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Check your email address.");
    if (!shipping.name || !shipping.address.line1 || !shipping.address.city) return bad("Add the shipping name and address.");
    if (!/^[A-Z]{2}$/.test(shipping.address.state)) return bad("Use the two-letter state code, like MA.");
    if (!/^\d{5}(-\d{4})?$/.test(shipping.address.postal_code)) return bad("Check the ZIP code.");
    if (!STYLES[style] || !SIZES[size] || SIZES[size].retired || !FRAMES[frame] || frame === "olive" || !CATEGORIES[category]) return bad("Choose a subject, style, size and frame.");

    const id = crypto.randomUUID();
    const photoKey = `photo/${id}`;
    await filesStore().set(photoKey, await photo.arrayBuffer());

    const order: Order = {
      id, createdAt: new Date().toISOString(), status: "awaiting_card",
      customer: { name, email }, category, style, size, frame, collector: false, shipping,
      price: SIZES[size].price, notes, plaque: ["", ""], ...(caption ? { caption } : {}),
      photoKey, renders: [], changeRequests: [], history: [{ at: new Date().toISOString(), event: "Order started" }],
    };

    const origin = new URL(req.url).origin;
    const session = await createCardSetup({
      orderId: id,
      name,
      email,
      amount: order.price,
      productName: productName(order),
      successUrl: `${origin}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
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
