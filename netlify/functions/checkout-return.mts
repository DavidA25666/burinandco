import type { Config } from "@netlify/functions";
import { getCheckoutSession } from "../shared/stripe.mts";
import { handleCompletedSession } from "../shared/checkout-complete.mts";

// The customer's browser lands here after Stripe Checkout. We fetch the session from
// Stripe ourselves, so the id in the URL is only a pointer, never trusted data.
export default async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const { session_id } = await req.json().catch(() => ({}));
  if (typeof session_id !== "string" || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(session_id)) {
    return Response.json({ error: "Unknown session." }, { status: 400 });
  }
  try {
    await handleCompletedSession(new URL(req.url).origin, await getCheckoutSession(session_id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "We couldn't confirm that yet." }, { status: 500 });
  }
};

export const config: Config = { path: "/api/checkout-return" };
