import type { Config, Context } from "@netlify/functions";
import { STYLES, SIZES, FRAMES, CATEGORIES, type StyleId, type SizeId, type FrameId, type CategoryId, productName } from "../shared/catalog.mts";
import { filesStore, saveOrder, type Order, type Utm } from "../shared/store.mts";
import { createCardSetup, stripeTestMode } from "../shared/stripe.mts";
import { getSettings } from "../shared/ops-store.mts";
import { priceCents } from "../shared/pricing.mts";

// UTM parameters the storefront kept from the visitor's landing (first and latest), for HQ's ads reports.
function readUtm(raw: FormDataEntryValue | null): Utm | null {
  try {
    const u = JSON.parse(String(raw ?? ""));
    if (!u || typeof u !== "object") return null;
    const f = (k: string) => (typeof u[k] === "string" && u[k] ? u[k].trim().slice(0, 120) : null);
    const utm: Utm = { source: f("source")?.toLowerCase() ?? null, medium: f("medium"), campaign: f("campaign"), content: f("content"), referrer: f("referrer"), landedAt: f("landedAt") };
    return utm.source || utm.referrer || utm.campaign ? utm : null;
  } catch {
    return null;
  }
}
import { cleanCaption } from "../shared/caption.mts";
import { adContext } from "../shared/meta.mts";
import { verify } from "../shared/sign.mts";
import { triggerRender } from "../shared/render-trigger.mts";
import { sendEmail } from "../shared/email.mts";
import { normEmail, claimFreeProof, markFree, freeStartedEmail } from "../shared/recovery.mts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  try {
    const settings = await getSettings();
    if (settings.maintenance) return bad("We're not taking new commissions for a short while. Please try again soon.", 503);
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

    // A free proof (no card) only comes from the link in a reminder email, signed for that address.
    const freeToken = String(form.get("free") ?? "");
    if (freeToken && !verify(`freelead:${normEmail(email)}`, freeToken)) {
      return bad("Your free-proof link is for a different email address. Use the address we emailed, or remove the free proof to check out as usual.");
    }

    const id = crypto.randomUUID();
    const photoKey = `photo/${id}`;
    await filesStore().set(photoKey, await photo.arrayBuffer());

    const order: Order = {
      id, createdAt: new Date().toISOString(), status: "awaiting_card",
      customer: { name, email }, category, style, size, frame, collector: false, shipping,
      price: priceCents(size, settings), notes, plaque: ["", ""], ...(caption ? { caption } : {}),
      photoKey, renders: [], changeRequests: [], history: [{ at: new Date().toISOString(), event: "Order started" }],
      livemode: !stripeTestMode(),
      ads: adContext(req, form),
      utm: { first: readUtm(form.get("utm_first")), last: readUtm(form.get("utm_last")) },
      buyerGeo: context?.geo ? {
        city: context.geo.city ?? null,
        region: context.geo.subdivision?.code ?? null,
        country: context.geo.country?.code ?? null,
        lat: typeof context.geo.latitude === "number" ? Math.round(context.geo.latitude * 100) / 100 : null,
        lng: typeof context.geo.longitude === "number" ? Math.round(context.geo.longitude * 100) / 100 : null,
      } : null,
    };

    const origin = new URL(req.url).origin;
    if (freeToken) {
      if (!(await claimFreeProof(email, id))) return bad("This email address has already had its free proof. Remove it to check out as usual.", 409);
      markFree(order, "lead");
      await saveOrder(order);
      try {
        await triggerRender(origin, id, null);
      } catch (e) {
        order.status = "render_failed";
        order.lastError = e instanceof Error ? e.message : String(e);
        await saveOrder(order);
      }
      await sendEmail(freeStartedEmail(order));
      return Response.json({ redirectUrl: "/thanks.html?free=1" });
    }
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
