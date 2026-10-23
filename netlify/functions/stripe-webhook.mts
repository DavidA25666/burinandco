import type { Config } from "@netlify/functions";
import { verifyStripeSignature } from "../shared/stripe.mts";
import { handleCompletedSession } from "../shared/checkout-complete.mts";

export default async (req: Request) => {
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const raw = await req.text();
  if (!secret || !verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed") return new Response("ignored");
  await handleCompletedSession(new URL(req.url).origin, event.data.object);
  return new Response("ok");
};

export const config: Config = { path: "/api/stripe-webhook" };
