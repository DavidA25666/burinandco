// Meta Conversions API (CAPI): the server-side copy of the Pixel's Purchase event, so Meta still
// counts the sale when the browser blocks the Pixel. Sent only for orders whose buyer accepted
// cookies, with the same event_id as the browser event so Meta counts it once.
// Needs META_PIXEL_ID and META_CAPI_TOKEN in Netlify; without them it does nothing.
// META_TEST_EVENT_CODE (optional) sends events to Events Manager → Test events instead.
import { createHash } from "node:crypto";
import type { Order } from "./store.mts";

const GRAPH = "https://graph.facebook.com/v21.0";

export const purchaseEventId = (o: Order) => `purchase-${o.id}`;

const sha256 = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

/** What create-order keeps for CAPI: the consent choice, Meta's cookies and the request's IP and browser. */
export function adContext(req: Request, form: FormData): NonNullable<Order["ads"]> {
  const consent = String(form.get("ad_consent") ?? "") === "granted";
  if (!consent) return { consent: false };
  const cookies = Object.fromEntries((req.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
  return {
    consent: true,
    fbp: cookies._fbp?.slice(0, 200) || null,
    fbc: cookies._fbc?.slice(0, 300) || null,
    ip: req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    ua: req.headers.get("user-agent")?.slice(0, 400) || null,
    url: req.headers.get("referer")?.slice(0, 400) || null,
  };
}

export function purchaseEvent(o: Order, nowMs = Date.now()) {
  const a = o.ads!;
  const ship = o.shipping?.address;
  const user_data: Record<string, unknown> = { em: [sha256(o.customer.email)] };
  if (a.fbp) user_data.fbp = a.fbp;
  if (a.fbc) user_data.fbc = a.fbc;
  if (a.ip) user_data.client_ip_address = a.ip;
  if (a.ua) user_data.client_user_agent = a.ua;
  if (ship?.postal_code) user_data.zp = [sha256(ship.postal_code.slice(0, 5))];
  if (ship?.state) user_data.st = [sha256(ship.state)];
  if (ship?.country) user_data.country = [sha256(ship.country)];
  return {
    event_name: "Purchase",
    event_time: Math.floor((o.paidAt ? Date.parse(o.paidAt) : nowMs) / 1000),
    event_id: purchaseEventId(o),
    action_source: "website",
    event_source_url: a.url || "https://burinandco.com/",
    user_data,
    custom_data: { currency: "USD", value: o.price / 100, content_type: "product", content_ids: [o.size], num_items: 1, order_id: o.id },
  };
}

/** Sends the Purchase event once. Never throws: a Meta outage must not break an approval. */
export async function sendPurchase(o: Order): Promise<"sent" | "skipped" | "failed"> {
  const pixel = Netlify.env.get("META_PIXEL_ID")?.trim();
  const token = Netlify.env.get("META_CAPI_TOKEN")?.trim();
  if (!pixel || !token || !o.ads?.consent || o.livemode === false || o.ads.purchaseSentAt) return "skipped";
  try {
    const test = Netlify.env.get("META_TEST_EVENT_CODE")?.trim();
    const res = await fetch(`${GRAPH}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [purchaseEvent(o)], ...(test ? { test_event_code: test } : {}) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    o.ads.purchaseSentAt = new Date().toISOString();
    return "sent";
  } catch (e) {
    console.warn("Meta CAPI Purchase failed:", e instanceof Error ? e.message : e);
    return "failed";
  }
}
