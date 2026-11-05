import type { Config, Context } from "@netlify/functions";
import { recordVisit } from "../shared/ops-store.mts";

// First-party visit counter for Tenfold HQ (visits, conversion, sources, live visitors).
// Stores no IP, name or cookie: a random per-tab session id, the traffic source and the US state.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  try {
    const body = JSON.parse((await req.text()).slice(0, 2000));
    const sid = String(body?.sid ?? "").slice(0, 40);
    if (!sid) return new Response(null, { status: 204 });
    if (/bot|crawl|spider|preview|headless/i.test(req.headers.get("user-agent") ?? "")) return new Response(null, { status: 204 });
    await recordVisit({ sid, source: String(body?.source ?? "direct"), path: String(body?.path ?? "/"), region: context?.geo?.subdivision?.code ?? null });
  } catch { /* ignore bad beacons */ }
  return new Response(null, { status: 204 });
};

export const config: Config = { path: "/api/t" };
