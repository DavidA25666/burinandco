import type { Config } from "@netlify/functions";
import { verify } from "../shared/sign.mts";
import { normEmail, unsubscribe } from "../shared/recovery.mts";

// The reminder email's unsubscribe link (GET) and mail apps' one-click unsubscribe (POST).
// Proofs and order emails still go out; this only stops reminders.
const page = (msg: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Burin &amp; Co.</title><link rel="stylesheet" href="/ops.css"></head>
<body><header class="site-head"><div class="wrap"><a class="brand" href="/">Burin &amp; Co.</a></div></header><main><section><div class="wrap narrow"><h1>${msg}</h1><p><a class="btn secondary" href="/">Back to home</a></p></div></section></main></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
);

export default async (req: Request) => {
  const url = new URL(req.url);
  const email = normEmail(url.searchParams.get("e") ?? "");
  if (!email || !verify(`unsub:${email}`, url.searchParams.get("t"))) return page("That unsubscribe link isn't valid.", 400);
  await unsubscribe(email);
  return page("You're unsubscribed. We won't send you reminders.");
};

export const config: Config = { path: "/api/unsubscribe" };
