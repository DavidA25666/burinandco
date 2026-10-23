import { createHmac, timingSafeEqual } from "node:crypto";

async function stripe<T>(path: string, params?: Record<string, string>, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new StripeError(data?.error?.message ?? `Stripe error ${res.status}`, data?.error?.code ?? null);
  return data as T;
}

export class StripeError extends Error {
  constructor(message: string, public code: string | null) { super(message); }
}

// Step one: save the customer's card (the shipping address comes from our own order form). Nothing is charged until they approve the proof.
// We create the Stripe customer first so the saved card is attached to it and can be charged later.
export async function createCardSetup(opts: { orderId: string; name: string; email: string; amount: number; productName: string; successUrl: string; cancelUrl: string }) {
  const customer = await stripe<{ id: string }>("customers", { email: opts.email, name: opts.name, "metadata[orderId]": opts.orderId });
  const params = {
    mode: "setup",
    currency: "usd",
    customer: customer.id,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.orderId,
    "metadata[orderId]": opts.orderId,
    "setup_intent_data[metadata][orderId]": opts.orderId,
    "setup_intent_data[description]": opts.productName,
    "custom_text[submit][message]": `You won't be charged now. We charge $${(opts.amount / 100).toLocaleString("en-US")} only when you approve your proof.`,
  };
  return stripe<{ id: string; url: string }>("checkout/sessions", params);
}

export function getSetupIntent(id: string) {
  return stripe<{ customer: string | null; payment_method: string | null }>(`setup_intents/${encodeURIComponent(id)}`);
}

// Step two: charge the saved card when the customer approves.
export function chargeSavedCard(opts: { orderId: string; customer: string; paymentMethod: string; amount: number; description: string; email: string; attempt: number }) {
  return stripe<{ id: string; status: string; amount: number }>("payment_intents", {
    amount: String(opts.amount),
    currency: "usd",
    customer: opts.customer,
    payment_method: opts.paymentMethod,
    off_session: "true",
    confirm: "true",
    description: opts.description,
    receipt_email: opts.email,
    "metadata[orderId]": opts.orderId,
  }, { idempotencyKey: `charge-${opts.orderId}-${opts.attempt}` });
}

// Fallback when the saved card is declined or needs the bank's confirmation: a normal payment page.
export function createPaymentCheckout(opts: { orderId: string; customer?: string; email: string; amount: number; productName: string; successUrl: string; cancelUrl: string }) {
  return stripe<{ id: string; url: string }>("checkout/sessions", {
    mode: "payment",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    ...(opts.customer ? { customer: opts.customer } : { customer_email: opts.email }),
    client_reference_id: opts.orderId,
    "metadata[orderId]": opts.orderId,
    "payment_intent_data[metadata][orderId]": opts.orderId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(opts.amount),
    "line_items[0][price_data][product_data][name]": opts.productName,
  });
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
