import type { Order } from "./store.mts";
import { SIZES, FRAMES, type SizeId, type FrameId } from "./catalog.mts";

// FinerWorks print-on-demand API (https://api.finerworks.com/Help), the same integration as Namesake.
// Orders are TEST orders (not billed or produced) until FINERWORKS_LIVE is "true". FinerWorks also
// forces test mode on its side while the app key itself is still in test mode.
const BASE = "https://v2.api.finerworks.com/v3";

export const finerworksLive = () => Netlify.env.get("FINERWORKS_LIVE") === "true";

// One FinerWorks product code per size and frame, copied from FinerWorks' Print Online Setup Tool.
// Every build: Framed giclee on Hahnemühle Photo Rag, Nature Wood 2" frame (Dark Walnut 295 or
// Black Oak 296), Snow White mat, Reflection Control acrylic, frame 3" larger than the print.
// The variable is named after the print size as the site shows it, e.g. FINERWORKS_CODE_16X12_WALNUT.
const FRAME_ENV: Partial<Record<FrameId, string>> = { walnut: "WALNUT", ebony: "BLACKOAK" };

export function codeEnvName(size: string, frame: string) {
  const s = SIZES[size as SizeId];
  const f = FRAME_ENV[frame as FrameId];
  return s && f ? `FINERWORKS_CODE_${s.inches[0]}X${s.inches[1]}_${f}` : null;
}

export function finerworksCode(size: string, frame: string) {
  const name = codeEnvName(size, frame);
  return name ? Netlify.env.get(name)?.trim() || null : null;
}

// The codes the dashboard checks: every size and frame customers can order now.
export function codeKeys() {
  return (Object.keys(SIZES) as SizeId[])
    .filter((size) => !SIZES[size].retired)
    .flatMap((size) => (Object.keys(FRAME_ENV) as FrameId[]).map((frame) => ({
      size, frame, env: codeEnvName(size, frame)!, label: `${SIZES[size].name}, ${FRAMES[frame].toLowerCase()}`,
    })));
}

function headers() {
  const web = Netlify.env.get("FINERWORKS_WEB_API_KEY");
  const app = Netlify.env.get("FINERWORKS_APP_KEY");
  if (!web || !app) throw new Error("FINERWORKS_WEB_API_KEY and FINERWORKS_APP_KEY are not both set in Netlify.");
  return { web_api_key: web, app_key: app, "Content-Type": "application/json", Accept: "application/json" };
}

async function call(path: string, body?: unknown) {
  const res = await fetch(`${BASE}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || data?.status?.success === false) {
    const msg = data?.status?.message || data?.message || data?.Message || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new Error(`FinerWorks ${path}: ${msg}`);
  }
  return data;
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  const first = parts.shift() || full;
  return { first_name: first.slice(0, 50), last_name: (parts.join(" ") || first).slice(0, 50) };
}

export async function createFinerworksOrder(
  order: Order,
  file: { url: string; width: number; height: number },
  productCode: string,
  title: string,
) {
  if (!order.shipping?.address) throw new Error("This order has no shipping address.");
  const a = order.shipping.address;
  const testMode = !finerworksLive();
  const po = order.id.replace(/-/g, "").slice(0, 20);
  const data = await call("submit_orders_v2", {
    validate_only: false,
    orders: [{
      order_po: po,
      recipient: {
        ...splitName(order.shipping.name || order.customer.name),
        address_1: a.line1.slice(0, 100),
        ...(a.line2 ? { address_2: a.line2.slice(0, 100) } : {}),
        city: a.city.slice(0, 50),
        state_code: a.state,
        zip_postal_code: a.postal_code,
        country_code: a.country || "US",
        ...(order.shipping.phone ? { phone: order.shipping.phone } : {}),
      },
      order_items: [{
        product_order_po: po,
        product_qty: 1,
        product_sku: productCode,
        product_title: title.slice(0, 50),
        product_image: {
          pixel_width: file.width,
          pixel_height: file.height,
          product_url_file: file.url,
          product_url_thumbnail: file.url,
        },
      }],
      // Customers get free shipping; FinerWorks bills it to us. Framed pieces go Ground.
      shipping_code: "SD",
      test_mode: testMode,
      source: "burinandco.com",
      custom_data_1: order.id,
    }],
  });
  const placed = data?.orders?.[0] ?? {};
  return {
    orderId: placed.order_id ?? null,
    confirmationId: placed.order_confirmation_id ?? null,
    testMode,
  };
}

// Dashboard check: are the keys right, and does each product code resolve to the right build and price?
export async function checkFinerworks() {
  const out: { credentials: string; live: boolean; products: { label: string; env: string; code: string | null; ok: boolean; detail: string }[] } = {
    credentials: "", live: finerworksLive(), products: [],
  };
  try {
    await call("test_my_credentials");
    out.credentials = "Connected";
  } catch (e) {
    out.credentials = e instanceof Error ? e.message : "Couldn't connect";
    return out;
  }
  for (const { size, frame, env, label } of codeKeys()) {
    const code = finerworksCode(size, frame);
    if (!code) { out.products.push({ label, env, code, ok: false, detail: `${env} is not set` }); continue; }
    try {
      const data = await call("get_product_details", [{ product_order_po: null, product_qty: 1, product_sku: code }]);
      const p = data?.product_list?.[0] ?? data?.products?.[0] ?? data?.[0] ?? data;
      const price = p?.total_price ?? p?.per_item_price ?? p?.price_details?.total_price;
      const name = p?.name || p?.description_short || "";
      out.products.push({ label, env, code, ok: p?.valid !== false, detail: `${name}${price != null ? ` · $${Number(price).toFixed(2)} before shipping` : ""}`.trim() || "Found" });
    } catch (e) {
      out.products.push({ label, env, code, ok: false, detail: e instanceof Error ? e.message : "Lookup failed" });
    }
  }
  return out;
}
