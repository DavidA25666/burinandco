import type { Config } from "@netlify/functions";
import { saveLead } from "../shared/recovery.mts";

// The order form sends the email here as soon as it's typed (the notice under the field says so),
// so someone who leaves before sending the form can get one reminder with a free-proof link.
export default async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().slice(0, 200);
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ ok: false }, { status: 400 });
  await saveLead(email, name);
  return Response.json({ ok: true });
};

export const config: Config = { path: "/api/lead" };
