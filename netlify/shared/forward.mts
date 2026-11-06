// Sends a copy of every email that reaches support@burinandco.com to the addresses in
// FORWARD_INBOUND_TO (comma-separated, e.g. david@tenfoldcommerce.com). The mail is still filed in
// HQ's Inbox as before; this is an extra copy for an owner's own mailbox.
//
// The copy goes out from the support address with Reply-To set to the customer, so hitting Reply
// in the owner's mail app answers the customer directly. Attachments are passed through by URL.
// Resend's Idempotency-Key makes a retried webhook send the copy only once.

export const forwardTargets = () =>
  (Netlify.env.get("FORWARD_INBOUND_TO") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));

export interface ReceivedEmail {
  from?: string | null; to?: string[] | null; cc?: string[] | null; subject?: string | null;
  text?: string | null; html?: string | null;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const addr = (raw: string) => (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
const nameOf = (raw: string) => /^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1]?.trim() || addr(raw);

/**
 * Forwards one received email. `brand` is the display name used in the From line, `via` the
 * address it arrived at (and is sent from). Returns what happened; never throws.
 */
export async function forwardReceived(emailId: string, email: ReceivedEmail, opts: { brand: string; via: string; ownDomains: string[] }):
  Promise<"forwarded" | "off" | "skipped" | "failed"> {
  const targets = forwardTargets();
  if (!targets.length) return "off";
  const key = Netlify.env.get("RESEND_API_KEY");
  if (!key || !emailId) return "failed";
  const from = String(email.from ?? "");
  const sender = addr(from);
  // Never forward our own outgoing mail back to ourselves (avoids loops).
  if (!sender || opts.ownDomains.some((d) => sender.endsWith(`@${d}`) || sender.endsWith(`.${d}`))) return "skipped";
  if (targets.some((t) => t.toLowerCase() === sender)) return "skipped";

  try {
    const readKey = Netlify.env.get("RESEND_RECEIVING_API_KEY") || key;
    const att = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { headers: { Authorization: `Bearer ${readKey}` } })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .catch(() => ({ data: [] }));
    const attachments = ((att as any)?.data ?? [])
      .filter((a: any) => a?.download_url)
      .map((a: any) => ({ filename: a.filename || "attachment", path: a.download_url, ...(a.content_type ? { content_type: a.content_type } : {}), ...(a.content_id ? { content_id: String(a.content_id).replace(/[<>]/g, "") } : {}) }));

    const to = [...(email.to ?? []), ...(email.cc ?? [])].join(", ");
    const subject = String(email.subject || "(no subject)");
    const banner = `Forwarded by ${opts.brand}. From: ${from}${to ? ` · To: ${to}` : ""}. Reply goes to the customer; it's also in HQ's Inbox.`;
    const html = `<div style="font:13px Arial,sans-serif;color:#555;border-bottom:1px solid #ddd;padding:0 0 8px;margin:0 0 12px">${escHtml(banner)}</div>`
      + (email.html || `<pre style="white-space:pre-wrap;font:14px Arial,sans-serif">${escHtml(String(email.text ?? ""))}</pre>`);
    const text = `${banner}\n\n${email.text ?? ""}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `fwd-${emailId}` },
      body: JSON.stringify({
        from: `${nameOf(from).replace(/["<>]/g, "")} via ${opts.brand} <${opts.via}>`,
        to: targets, reply_to: sender, subject, html, text,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    if (!res.ok) { console.error("Forward failed", res.status, (await res.text()).slice(0, 300)); return "failed"; }
    return "forwarded";
  } catch (e) {
    console.error("Forward failed", e);
    return "failed";
  }
}
