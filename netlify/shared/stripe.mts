import { createHmac, timingSafeEqual } from "node:crypto";

export async function createCheckout(opts: {
  orderId: string; email: string; amount: number; productName: string; successUrl: string; cancelUrl: string;
}) {
  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const p = new URLSearchParams({
    mode: "payment",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.email,
    client_reference_id: opts.orderId,
    "metadata[orderId]": opts.orderId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(opts.amount),
    "line_items[0][price_data][product_data][name]": opts.productName,
    "shipping_address_collection[allowed_countries][0]": "US",
    "phone_number_collection[enabled]": "true",
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: p,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Stripe error ${res.status}`);
  return data as { id: string; url: string };
}

export function verifyStripeSignature(payload: string, header: string | null, secret: string) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}
