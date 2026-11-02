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

// Product codes aren't secret, so they live here. A Netlify variable with the name above overrides one.
// FinerWorks codes spell out the build: 5M62M8 Photo Rag, S{print}, F{frame id}, S{frame size},
// J1 Snow White mat, S{mat window}, G2 Reflection Control, U1. 16x12 walnut confirmed in FinerWorks ($145).
const CODES: Record<string, string> = {
  FINERWORKS_CODE_16X12_WALNUT: "5M62M8S16X12F295S19X15J1S16X12G2U1",
  FINERWORKS_CODE_16X12_BLACKOAK: "5M62M8S16X12F296S19X15J1S16X12G2U1",
  FINERWORKS_CODE_20X16_WALNUT: "5M62M8S20X16F295S23X19J1S20X16G2U1",
  FINERWORKS_CODE_20X16_BLACKOAK: "5M62M8S20X16F296S23X19J1S20X16G2U1",
};

export function finerworksCode(size: string, frame: string) {
  const name = codeEnvName(size, frame);
  return name ? Netlify.env.get(name)?.trim() || CODES[name] || null : null;
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
    const debug = data?.status?.debug || (data?.ModelState ? JSON.stringify(data.ModelState) : "");
    throw new Error(`FinerWorks ${path}: ${msg}${debug ? ` (${String(debug).slice(0, 300)})` : ""}`);
  }
  return data;
}

// FinerWorks has to be told how each order is paid, or it holds the order with "Cannot determine
// payment method". Live orders pay with the default card saved in the FinerWorks account
// (get_user -> payment_profile_id -> get_payment_tokens). Test orders send "xxxx", FinerWorks'
// documented test token. FINERWORKS_PAYMENT_TOKEN in Netlify overrides the lookup (e.g. "invoice").
function describeMethod(m: any) {
  if (!m) return "default card";
  if (typeof m === "string") return m;
  const brand = m.card_type ?? m.brand ?? m.type ?? "";
  const last4 = m.last4 ?? m.last_four ?? m.card_last_four ?? (typeof m.card_number === "string" ? m.card_number.slice(-4) : "");
  return `${brand || "card"}${last4 ? ` ending ${last4}` : ""}`.trim();
}

export async function savedPaymentToken(): Promise<{ token: string; label: string }> {
  const override = Netlify.env.get("FINERWORKS_PAYMENT_TOKEN")?.trim();
  if (override) return { token: override, label: override === "invoice" ? "invoice (FINERWORKS_PAYMENT_TOKEN)" : "FINERWORKS_PAYMENT_TOKEN" };
  // FinerWorks' route is get_user?account_key=...; without the query parameter it answers 404
  // ("No HTTP resource was found"). An empty key returns the account the API keys belong to.
  const user = await call("get_user?account_key=");
  const profile = user?.user_account?.payment_profile_id;
  if (!profile) throw new Error("FinerWorks has no saved card on this account (no payment profile). Add a card under Billing & Payment in FinerWorks.");
  const data = await call(`get_payment_tokens?payment_profile_id=${encodeURIComponent(profile)}`);
  const tokens: any[] = data?.payment_tokens ?? [];
  const t = tokens.find((x) => x?.is_default && x?.token) ?? tokens.find((x) => x?.token);
  if (!t) throw new Error("FinerWorks returned no saved card for this account. Add a card under Billing & Payment in FinerWorks.");
  return { token: String(t.token), label: describeMethod(t.associated_payment_method) };
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
  // Look the card up before submitting, so a missing card stops here instead of leaving an order on hold.
  const paymentToken = testMode ? "xxxx" : (await savedPaymentToken()).token;
  const po = order.id.replace(/-/g, "").slice(0, 20);
  const data = await call("submit_orders_v2", {
    validate_only: false,
    payment_token: paymentToken,
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

// Dashboard check: are the keys right, and does each product code price out as the right build?
export async function checkFinerworks() {
  const out: { credentials: string; live: boolean; payment: { ok: boolean; detail: string } | null; products: { label: string; env: string; code: string | null; ok: boolean; detail: string }[] } = {
    credentials: "", live: finerworksLive(), payment: null, products: [],
  };
  try {
    await call("test_my_credentials");
    out.credentials = "Connected";
  try {
    const t = await savedPaymentToken();
    out.payment = { ok: true, detail: `Live orders will be paid with: ${t.label}` };
  } catch (e) {
    out.payment = { ok: false, detail: e instanceof Error ? e.message : "Couldn't find a saved card" };
  }
  } catch (e) {
    out.credentials = e instanceof Error ? e.message : "Couldn't connect";
    return out;
  }
  for (const { size, frame, env, label } of codeKeys()) {
    const code = finerworksCode(size, frame);
    if (!code) { out.products.push({ label, env, code, ok: false, detail: `${env} is not set` }); continue; }
    try {
      // get_prices takes product codes as well as inventory SKUs (get_product_details only knows inventory SKUs).
      const data = await call("get_prices", { products: [{ product_qty: 1, product_sku: code }] });
      const p = data?.prices?.[0];
      if (!p) throw new Error("FinerWorks returned no price for this code.");
      const price = p.total_price ?? p.product_price;
      const parts = [p.add_frame_price != null && "frame", p.add_mat_1_price != null && "mat", p.add_glazing_price != null && "glazing"].filter(Boolean);
      out.products.push({ label, env, code, ok: price != null, detail: `${price != null ? `$${Number(price).toFixed(2)} before shipping` : "No price returned"}${parts.length ? ` (print + ${parts.join(", ")})` : ""}${p.info ? ` · ${p.info}` : ""}` });
    } catch (e) {
      out.products.push({ label, env, code, ok: false, detail: e instanceof Error ? e.message : "Lookup failed" });
    }
  }
  return out;
}
