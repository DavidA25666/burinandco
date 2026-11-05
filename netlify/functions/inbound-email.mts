import type { Config } from "@netlify/functions";
import { verifyResendSignature, receiveEmail } from "../shared/inbox.mts";
import { opsStore } from "../shared/ops-store.mts";

// Resend inbound mail (email.received). Every Tenfold brand's mail arrives here, because Resend
// sends the event to every webhook on the team; receiveEmail keeps only mail for burinandco.com
// and answers 200 for the rest, so Resend doesn't retry it.
export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  if (!verifyResendSignature(raw, req.headers, Netlify.env.get("RESEND_INBOUND_WEBHOOK_SECRET"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const event = JSON.parse(raw);
  if (event?.type !== "email.received") return new Response("ignored");
  try {
    return new Response(await receiveEmail(event.data));
  } catch (e) {
    console.error("Inbound email failed", e);
    await opsStore().setJSON(`inbox-fail/${new Date().toISOString()}`, { error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return new Response("error", { status: 500 });
  }
};

export const config: Config = { path: "/api/inbound/email" };
