// Sends email through Resend (resend.com). Needs RESEND_API_KEY and FROM_EMAIL.
export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function sendEmail(opts: { to: string; subject: string; html: string; replyTo?: string | null }) {
  const key = Netlify.env.get("RESEND_API_KEY");
  const from = Netlify.env.get("FROM_EMAIL");
  if (!key || !from) {
    console.warn("Email not configured, skipped:", opts.subject);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [opts.to], subject: opts.subject, html: wrap(opts.html),
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });
  if (!res.ok) console.error("Email failed", res.status, await res.text());
  return res.ok;
}

export async function notifyOwner(subject: string, html: string) {
  const to = Netlify.env.get("OWNER_EMAIL");
  if (to) await sendEmail({ to, subject, html });
}

function wrap(body: string) {
  return `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.55;color:#1D1B17;max-width:560px;margin:0 auto;padding:24px">${body}</div>`;
}

export function button(href: string, label: string) {
  return `<p style="margin:24px 0"><a href="${href}" style="background:#1D1B17;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:15px">${label}</a></p>`;
}
