// Sends email through Resend (resend.com). Needs RESEND_API_KEY and FROM_EMAIL.
// Every customer email carries Reply-To support@burinandco.com, so replies land in Tenfold HQ's Inbox.
// A send that fails is kept in the outbox; HQ's "flush email outbox" retries it.
import { queueFailedEmail } from "./ops-store.mts";

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const SITE_DOMAIN = "burinandco.com";
export const supportAddress = () => Netlify.env.get("SUPPORT_EMAIL") || `support@${SITE_DOMAIN}`;

export interface EmailOpts { to: string; subject: string; html: string; replyTo?: string | null; from?: string; headers?: Record<string, string>; raw?: boolean }

export async function deliver(opts: EmailOpts): Promise<{ ok: boolean; id: string | null; error: string | null }> {
  const key = Netlify.env.get("RESEND_API_KEY");
  const from = opts.from || Netlify.env.get("FROM_EMAIL");
  if (!key || !from) return { ok: false, id: null, error: "RESEND_API_KEY or FROM_EMAIL is not set" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [opts.to], subject: opts.subject, html: opts.raw ? opts.html : wrap(opts.html),
        reply_to: opts.replyTo ?? supportAddress(),
        ...(opts.headers ? { headers: opts.headers } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, id: null, error: `Resend ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, id: JSON.parse(text)?.id ?? null, error: null };
  } catch (e) {
    return { ok: false, id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendEmail(opts: EmailOpts) {
  const r = await deliver(opts);
  if (!r.ok) {
    console.error("Email failed:", opts.subject, r.error);
    await queueFailedEmail({ to: opts.to, subject: opts.subject, html: opts.raw ? opts.html : wrap(opts.html), replyTo: opts.replyTo ?? supportAddress(), headers: opts.headers, from: opts.from, lastError: r.error ?? "unknown" }).catch(() => {});
  }
  return r.ok;
}

// Owner emails (new order, ready to review, approved, change request) go to OWNER_EMAIL whenever it's set.
// HQ can't turn them off: to stop them, clear OWNER_EMAIL in Netlify.
export async function notifyOwner(subject: string, html: string) {
  const to = Netlify.env.get("OWNER_EMAIL");
  if (!to) return;
  await sendEmail({ to, subject, html, replyTo: null });
}

export function wrap(body: string) {
  return `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.55;color:#1D1B17;max-width:560px;margin:0 auto;padding:24px">${body}</div>`;
}

export function button(href: string, label: string) {
  return `<p style="margin:24px 0"><a href="${href}" style="background:#1D1B17;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:15px">${label}</a></p>`;
}
