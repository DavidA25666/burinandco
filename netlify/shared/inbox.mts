// Support inbox for Tenfold HQ (§7b). Resend receives mail for burinandco.com and posts
// email.received to /api/inbound/email; we keep the conversation, match it to an order, and
// let HQ read, reply (threaded, from support@burinandco.com) and mark it done.
//
// Resend sends email.received for EVERY domain in the shared Tenfold team to every webhook,
// so mail that isn't addressed to burinandco.com is dropped without a trace.
import { createHmac, timingSafeEqual } from "node:crypto";
import { opsStore } from "./ops-store.mts";
import { deliver, esc, SITE_DOMAIN, supportAddress } from "./email.mts";
import { listOrders, type Order } from "./store.mts";
import { shortName, shortId, itemName } from "./ops/economics.mts";
import { forwardReceived } from "./forward.mts";

export interface InboxMessage { id: string; dir: "in" | "out"; at: string; from: string; to: string; subject: string; text: string; messageId: string | null; sentBy?: string | null }
export interface Conversation {
  id: string; email: string; name: string | null; subject: string;
  category: string; urgency: "urgent" | "high" | "normal" | "low";
  status: "open" | "done"; orderId: string | null;
  kind: "conversation" | "notice"; source: string | null;
  messages: InboxMessage[];
  draft: { id: string; text: string; editedBy: string | null } | null;
  updatedAt: string;
}

// ---------- Resend (Svix) webhook signature ----------

/** Verifies Resend's webhook signature: HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<body>" with the base64 secret after "whsec_". */
export function verifyResendSignature(body: string, headers: Headers, secret: string | undefined, nowMs = Date.now()) {
  if (!secret) return false;
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sig = headers.get("svix-signature");
  if (!id || !ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64"));
  return sig.split(" ").some((part) => {
    const [, value] = part.split(",");
    const given = Buffer.from(value ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------- Addresses ----------

export function parseAddress(raw: string) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  const email = (m ? m[2] : raw).trim().toLowerCase();
  return { name: m && m[1].trim() ? m[1].trim() : null, email };
}

/** True when one of the recipients is this store's own domain (or a subdomain of it). */
export function addressedToUs(recipients: unknown[]) {
  return recipients.some((r) => {
    const { email } = parseAddress(String(r ?? ""));
    const domain = email.split("@")[1] ?? "";
    return domain === SITE_DOMAIN || domain.endsWith(`.${SITE_DOMAIN}`);
  });
}

const VENDORS: Record<string, string> = { "finerworks.com": "FinerWorks", "stripe.com": "Stripe", "replicate.com": "Replicate", "resend.com": "Resend", "resend.dev": "Resend", "netlify.com": "Netlify", "google.com": "Google" };
const vendorOf = (email: string) => {
  const domain = email.split("@")[1] ?? "";
  return Object.entries(VENDORS).find(([d]) => domain === d || domain.endsWith(`.${d}`))?.[1] ?? null;
};

export function classify(subject: string, text: string) {
  const t = `${subject} ${text}`.toLowerCase();
  if (/chargeback|dispute|fraud|unauthori[sz]ed/.test(t)) return { category: "payment_problem", urgency: "urgent" as const };
  if (/refund|cancel|money back/.test(t)) return { category: "refund_request", urgency: "high" as const };
  if (/where is|tracking|shipp|deliver|arriv|when will/.test(t)) return { category: "where_is_my_order", urgency: "high" as const };
  if (/proof|change|edit|revis|caption|approve/.test(t)) return { category: "proof_question", urgency: "normal" as const };
  if (/price|cost|size|frame|how much|quote/.test(t)) return { category: "pre_sale_question", urgency: "normal" as const };
  return { category: "general", urgency: "normal" as const };
}

const normSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, "").trim().toLowerCase();
const convId = (email: string, subject: string) => `c_${createHmac("sha256", "burin-inbox").update(`${email}|${normSubject(subject)}`).digest("hex").slice(0, 12)}`;

function matchOrder(orders: Order[], email: string, subject: string, text: string): Order | null {
  const ref = /BC-([0-9A-F]{6})/i.exec(`${subject} ${text}`)?.[1]?.toLowerCase();
  if (ref) { const o = orders.find((x) => x.id.startsWith(ref)); if (o) return o; }
  return orders.filter((o) => o.customer.email.toLowerCase() === email && o.status !== "awaiting_card").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function templateDraft(c: Conversation, order: Order | null) {
  const first = c.name?.split(/\s+/)[0] ?? "there";
  const about = order ? ` about your ${itemName(order).split(" · ")[0].toLowerCase()} (${shortId(order)})` : "";
  return `Hi ${first},\n\nThank you for writing${about}. \n\nBest,\nBurin & Co.`;
}

// ---------- Receiving ----------

async function fetchBody(emailId: string) {
  const key = Netlify.env.get("RESEND_RECEIVING_API_KEY") || Netlify.env.get("RESEND_API_KEY");
  if (!key) return null;
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Resend receiving ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ text?: string | null; html?: string | null; headers?: Record<string, string> | { name: string; value: string }[]; message_id?: string | null; subject?: string; from?: string; to?: string[] }>;
}

const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
const headerValue = (h: unknown, name: string) => {
  if (Array.isArray(h)) return h.find((x) => String(x?.name).toLowerCase() === name)?.value ?? null;
  if (h && typeof h === "object") { const k = Object.keys(h).find((x) => x.toLowerCase() === name); return k ? (h as any)[k] : null; }
  return null;
};

/** Handles one email.received event. Returns what happened, for the webhook's log. */
export async function receiveEmail(data: any): Promise<"stored" | "ignored" | "duplicate"> {
  const to = [...(data?.to ?? []), ...(data?.cc ?? [])];
  if (!addressedToUs(to)) return "ignored";
  const emailId = String(data?.email_id ?? data?.id ?? "");
  const store = opsStore();
  if (emailId && (await store.get(`inbox-seen/${emailId}`))) return "duplicate";

  const full = emailId ? await fetchBody(emailId).catch((e) => { console.error(e); return null; }) : null;
  // A copy for the owner's own mailbox (FORWARD_INBOUND_TO). Never blocks filing the mail for HQ.
  if (emailId) {
    const fwd = await forwardReceived(emailId, { from: full?.from ?? data?.from, to: full?.to ?? data?.to, cc: data?.cc, subject: full?.subject ?? data?.subject, text: full?.text ?? data?.text, html: full?.html }, { brand: "Burin & Co.", via: supportAddress(), ownDomains: [SITE_DOMAIN] });
    if (fwd === "failed") await store.setJSON(`forward-fail/${emailId}`, { at: new Date().toISOString() }).catch(() => {});
  }
  const { name, email } = parseAddress(String(full?.from ?? data?.from ?? ""));
  const subject = String(full?.subject ?? data?.subject ?? "(no subject)").slice(0, 300);
  const text = (full?.text || (full?.html ? stripHtml(full.html) : "") || String(data?.text ?? "")).slice(0, 20_000);
  const messageId = full?.message_id ?? headerValue(full?.headers, "message-id") ?? data?.message_id ?? null;
  const at = String(data?.created_at ?? new Date().toISOString());

  const vendor = vendorOf(email);
  const id = convId(email, subject);
  const existing = (await store.get(`conv/${id}`, { type: "json" })) as Conversation | null;
  const orders = vendor ? [] : await listOrders();
  const order = existing?.orderId ? orders.find((o) => o.id === existing.orderId) ?? null : matchOrder(orders, email, subject, text);
  const { category, urgency } = vendor ? { category: "vendor_notice", urgency: "normal" as const } : classify(subject, text);

  const conv: Conversation = existing ?? {
    id, email, name, subject, category, urgency, status: "open", orderId: order?.id ?? null,
    kind: vendor ? "notice" : "conversation", source: vendor, messages: [], draft: null, updatedAt: at,
  };
  conv.messages.push({ id: emailId || `m_${Date.now()}`, dir: "in", at, from: email, to: to.map(String).join(", "), subject, text, messageId });
  conv.status = "open";
  conv.updatedAt = at;
  if (!vendor && (!conv.draft || !conv.draft.editedBy)) conv.draft = { id: `d_${id.slice(2)}`, text: templateDraft(conv, order), editedBy: null };
  await store.setJSON(`conv/${id}`, conv);
  if (emailId) await store.set(`inbox-seen/${emailId}`, at);
  await store.setJSON("inbox/last", { at, failed: false });
  return "stored";
}

export async function listConversations(): Promise<Conversation[]> {
  const store = opsStore();
  const { blobs } = await store.list({ prefix: "conv/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Conversation | null>))).filter((c): c is Conversation => !!c).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- §7b GET /api/ops/inbox ----------

export async function inboxView() {
  const convs = await listConversations();
  const orders = await listOrders();
  const byId = new Map(orders.map((o) => [o.id, o]));
  const open = convs.filter((c) => c.status === "open");
  const conversations = open.filter((c) => c.kind === "conversation").map((c) => {
    const last = [...c.messages].reverse().find((m) => m.dir === "in") ?? c.messages.at(-1)!;
    const o = c.orderId ? byId.get(c.orderId) : undefined;
    return {
      id: c.id, customer: c.name ? shortName(c.name) : c.email.split("@")[0], email: c.email, subject: c.subject,
      category: c.category, urgency: c.urgency, last_message: last.text.slice(0, 280), received_at: last.at,
      order_id: o ? shortId(o) : null, order_label: o ? itemName(o) : null,
      order: o ? { id: shortId(o), item: itemName(o), status: o.status } : null,
      messages: c.messages.slice(-10).map((m) => ({ id: m.id, direction: m.dir, at: m.at, text: m.text.slice(0, 4000) })),
      draft: c.draft ? { id: c.draft.id, message_id: c.draft.id, body: c.draft.text } : null,
      actions: ["send", "edit", "mark_done"],
    };
  });
  const notices = open.filter((c) => c.kind === "notice").map((c) => ({
    id: c.id, email_id: c.id, kind: "notice", source: c.source ?? c.email, title: c.subject, detail: c.messages.at(-1)?.text.slice(0, 400) ?? "",
    status: "needs_action", urgency: c.urgency === "urgent" ? "urgent" : "normal", received_at: c.updatedAt,
  }));
  return {
    contractVersion: 2,
    address: supportAddress(),
    counts: { needs_reply: conversations.length, drafts: conversations.filter((c) => c.draft).length, urgent: conversations.filter((c) => c.urgency === "urgent").length, notices_action: notices.length, invoice_failures: 0 },
    conversations,
    drafts: conversations.filter((c) => c.draft).map((c) => ({ conversation_id: c.id, message_id: c.draft!.id, text: c.draft!.body, body: c.draft!.body })),
    notices,
    invoices: [],
  };
}

// ---------- §7b POST /api/ops/inbox ----------

export class InboxError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

async function findConversation(params: any): Promise<Conversation> {
  const store = opsStore();
  const cid = params?.conversation_id ?? params?.email_id;
  const did = params?.message_id;
  if (cid) {
    const c = (await store.get(`conv/${String(cid)}`, { type: "json" })) as Conversation | null;
    if (c) return c;
  }
  if (did) {
    const c = (await store.get(`conv/c_${String(did).replace(/^d_/, "")}`, { type: "json" })) as Conversation | null;
    if (c) return c;
  }
  throw new InboxError(400, "invalid_params", "Pick a conversation (conversation_id) or a draft (message_id).");
}

export async function inboxAction(action: string, params: any, sentBy: string | null) {
  const store = opsStore();
  const save = (c: Conversation) => store.setJSON(`conv/${c.id}`, { ...c, updatedAt: new Date().toISOString() });
  switch (action) {
    case "edit": {
      const c = await findConversation(params);
      const text = String(params?.text ?? "");
      if (!text.trim() || text.length > 20_000) throw new InboxError(400, "invalid_params", "Write the reply (up to 20,000 characters).");
      c.draft = { id: c.draft?.id ?? `d_${c.id.slice(2)}`, text, editedBy: sentBy };
      await save(c);
      return { ok: true, message: "Draft saved" };
    }
    case "send":
    case "approve": {
      const c = await findConversation(params);
      if (c.kind !== "conversation") throw new InboxError(409, "not_done", "Notices can't be replied to from here.");
      const text = String(params?.text ?? c.draft?.text ?? "");
      if (!text.trim() || text.length > 20_000) throw new InboxError(400, "invalid_params", "Write the reply first.");
      const lastIn = [...c.messages].reverse().find((m) => m.dir === "in");
      const refs = c.messages.map((m) => m.messageId).filter(Boolean).join(" ");
      const fromName = /^(.*?)\s*</.exec(Netlify.env.get("FROM_EMAIL") ?? "")?.[1]?.replace(/"/g, "") || "Burin & Co.";
      const subject = /^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`;
      const sent = await deliver({
        from: `${fromName} <${supportAddress()}>`,
        to: c.email,
        subject,
        html: `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.55;color:#1D1B17">${esc(text).replace(/\n/g, "<br>")}</div>`,
        raw: true,
        replyTo: supportAddress(),
        headers: lastIn?.messageId ? { "In-Reply-To": lastIn.messageId, References: refs || lastIn.messageId } : undefined,
      });
      if (!sent.ok) throw new InboxError(409, "not_done", `The reply didn't send: ${sent.error}`);
      c.messages.push({ id: sent.id ?? `out_${Date.now()}`, dir: "out", at: new Date().toISOString(), from: supportAddress(), to: c.email, subject, text, messageId: sent.id ? `<${sent.id}@resend.dev>` : null, sentBy });
      c.draft = null;
      c.status = "done";
      await save(c);
      return { ok: true, message: `Reply sent to ${c.email} from ${supportAddress()}` };
    }
    case "mark_done":
    case "notice_done": {
      const c = await findConversation(params);
      c.status = "done";
      await save(c);
      return { ok: true, message: "Marked done" };
    }
    case "reopen": {
      const c = await findConversation(params);
      c.status = "open";
      await save(c);
      return { ok: true, message: "Reopened" };
    }
    case "set_auto_reply":
      throw new InboxError(409, "not_done", "Burin & Co. doesn't send automatic replies; every reply is sent from HQ by an owner.");
  }
  throw new InboxError(400, "unknown_action", `Unknown inbox action "${action}".`);
}

// ---------- Health check (SHAPES §2) ----------

export async function inboxStatus() {
  const last = (await opsStore().get("inbox/last", { type: "json" }).catch(() => null)) as { at: string } | null;
  const configured = !!Netlify.env.get("RESEND_INBOUND_WEBHOOK_SECRET");
  const details = { domains: SITE_DOMAIN, provider: "Resend inbound", mx: "the MX record Resend shows under Domains → burinandco.com → Receiving", addresses: supportAddress().split("@")[0] + "@", lastReceivedAt: last?.at ?? null, failed24h: 0 };
  if (!configured) {
    return { id: "inbound-email", category: "email", name: "Inbound email (this store's domains)", status: "warn" as const, message: `Not set up yet: RESEND_INBOUND_WEBHOOK_SECRET isn't set, so mail to ${supportAddress()} doesn't reach HQ`, details };
  }
  return { id: "inbound-email", category: "email", name: "Inbound email (this store's domains)", status: "ok" as const, message: `${supportAddress()} receives via Resend inbound${last ? `; last message ${last.at}` : "; no mail yet"}`, details };
}
