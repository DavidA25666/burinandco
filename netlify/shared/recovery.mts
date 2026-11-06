// Abandoned-checkout recovery.
//
// Normal checkout is unchanged: the card is saved before anything is drawn. Only someone who leaves
// after giving their email gets one email, about an hour later, offering a free proof with no card.
// Two ways to leave:
//   - order: they filled in the form and went to Stripe's card page but didn't save a card. We already
//     have their photo and details, so the email's link starts drawing that order.
//   - lead: they typed their email but never sent the form. The email's link brings them back to the
//     form, where the free proof skips the card page.
// Either way the proof is free to look at; when they approve it they pay on a normal Stripe page, and
// the order carries on as usual. One free proof per email address, one recovery email per address,
// and every recovery email has an unsubscribe link.
import { createHash } from "node:crypto";
import { listOrders, ordersStore, saveOrder, log, type Order } from "./store.mts";
import { sign } from "./sign.mts";
import { sendEmail, button, esc, SITE_DOMAIN } from "./email.mts";
import { SIZES, styleInfo, categoryInfo } from "./catalog.mts";
import { getSettings } from "./ops-store.mts";
import { isTest } from "./ops/economics.mts";

export const WAIT_MS = 60 * 60_000;          // wait an hour after they leave
export const GIVE_UP_MS = 72 * 3_600_000;     // and don't email anyone who left more than 3 days ago
export const LEAD_EMAILS_PER_DAY = 25;        // the lead form takes any address, so cap what it can send

export const normEmail = (e: string) => e.trim().toLowerCase();
const hash = (email: string) => createHash("sha256").update(normEmail(email)).digest("hex").slice(0, 40);

export const recoveryOn = () => (Netlify.env.get("ABANDONED_CHECKOUT_EMAILS") ?? "").toLowerCase() !== "off";
export const siteOrigin = () => (Netlify.env.get("URL") || `https://${SITE_DOMAIN}`).replace(/\/$/, "");

// ---------- links ----------

export const freeOrderToken = (orderId: string) => sign(`free:${orderId}`);
export const freeLeadToken = (email: string) => sign(`freelead:${normEmail(email)}`);
export const unsubToken = (email: string) => sign(`unsub:${normEmail(email)}`);

export const freeOrderLink = (origin: string, orderId: string) => `${origin}/free-proof.html?o=${orderId}&t=${freeOrderToken(orderId)}`;
export const freeLeadLink = (origin: string, email: string) =>
  `${origin}/?free=${freeLeadToken(email)}&e=${encodeURIComponent(normEmail(email))}#commission`;
export const unsubLink = (origin: string, email: string) =>
  `${origin}/api/unsubscribe?e=${encodeURIComponent(normEmail(email))}&t=${unsubToken(email)}`;

// ---------- small records ----------

export interface Lead { email: string; name: string; at: string; updatedAt: string }

export async function saveLead(email: string, name: string) {
  const store = ordersStore();
  const key = `lead/${hash(email)}`;
  const now = new Date().toISOString();
  const old = (await store.get(key, { type: "json" })) as Lead | null;
  // updatedAt moves on each visit, so the hour's wait counts from when they last typed.
  await store.setJSON(key, { email: normEmail(email), name: name || old?.name || "", at: old?.at ?? now, updatedAt: now } satisfies Lead);
}

export async function listLeads(): Promise<Lead[]> {
  const store = ordersStore();
  const { blobs } = await store.list({ prefix: "lead/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Lead | null>))).filter((l): l is Lead => !!l);
}

export async function unsubscribe(email: string) {
  await ordersStore().set(`unsub/${hash(email)}`, new Date().toISOString());
}
export async function isUnsubscribed(email: string) {
  return (await ordersStore().get(`unsub/${hash(email)}`)) != null;
}

/** Claims this address's one free proof. False if it was already used (by another order). */
export async function claimFreeProof(email: string, orderId: string) {
  const store = ordersStore();
  const key = `free/${hash(email)}`;
  const { modified } = await store.set(key, orderId, { onlyIfNew: true });
  return modified || (await store.get(key, { type: "text" })) === orderId;
}
export async function freeProofUsed(email: string) {
  return (await ordersStore().get(`free/${hash(email)}`)) != null;
}

// One recovery email per address, ever.
async function claimRecovery(email: string) {
  const { modified } = await ordersStore().set(`recovery/${hash(email)}`, new Date().toISOString(), { onlyIfNew: true });
  return modified;
}
async function leadQuotaLeft(now: Date) {
  const store = ordersStore();
  const key = `recovery-day/${now.toISOString().slice(0, 10)}`;
  const n = Number((await store.get(key)) ?? 0);
  return { left: LEAD_EMAILS_PER_DAY - n, bump: () => store.set(key, String(n + 1)) };
}

// ---------- the email ----------

function recoveryEmail(origin: string, to: string, name: string, link: string, order: Order | null) {
  const first = esc((name || "").split(" ")[0]) || "Hello";
  const what = order ? `the ${esc(styleInfo(order.style).name)} portrait of your ${categoryInfo(order.category).subject}` : "your portrait";
  const unsub = unsubLink(origin, to);
  return {
    to,
    subject: order ? `We'll draw your ${categoryInfo(order.category).subject} first. No card needed.` : "See your portrait before you pay",
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    html: `<p>${first},</p>
      <p>You started a commission with us but didn't finish. No problem: we'd like to draw ${what} first, free, before you enter a card.</p>
      <p>${order ? "We still have your photograph and details, so it's one click." : "Send us your photograph and we'll do the rest."} Your proof arrives by email within 48 hours (often within 24). If you love it, approve it and pay${order ? ` $${(order.price / 100).toLocaleString("en-US")}` : ""} then. If not, you owe nothing.</p>
      ${button(link, order ? "Draw my free proof" : "Get my free proof")}
      <p>Questions? Just reply.</p><p>Burin &amp; Co.</p>
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:32px">One free proof per customer. This is the only reminder we'll send about this commission. <a href="${unsub}" style="color:#888">Unsubscribe</a></p>`,
  };
}

// ---------- the job ----------

export interface RecoveryRun { sent: number; skipped: number; notes: string[] }

/** Finds unfinished checkouts that are an hour old and sends each address its one email. */
export async function runRecovery(origin = siteOrigin(), now = new Date()): Promise<RecoveryRun> {
  const run: RecoveryRun = { sent: 0, skipped: 0, notes: [] };
  if (!recoveryOn()) { run.notes.push("ABANDONED_CHECKOUT_EMAILS is off"); return run; }
  const settings = await getSettings();
  if (settings.maintenance) { run.notes.push("maintenance mode"); return run; }

  const t = now.getTime();
  const due = (iso: string) => t - Date.parse(iso) >= WAIT_MS && t - Date.parse(iso) <= GIVE_UP_MS;
  const orders = await listOrders();
  const byEmail = new Map<string, Order[]>();
  for (const o of orders) {
    const e = normEmail(o.customer.email);
    byEmail.set(e, [...(byEmail.get(e) ?? []), o]);
  }
  // Anyone who got further than the card page on any order is a customer already: leave them be.
  const finished = (email: string) => (byEmail.get(email) ?? []).some((o) => o.status !== "awaiting_card" && o.status !== "awaiting_payment");

  async function eligible(email: string) {
    if (finished(email)) return false;
    if (await isUnsubscribed(email)) return false;
    if (await freeProofUsed(email)) return false;
    return true;
  }

  // 1. Unfinished card pages. The newest one per address; the rest just wait.
  const seen = new Set<string>();
  for (const o of orders) { // newest first
    if (o.status !== "awaiting_card" || o.recovery || o.freeProof) continue;
    const email = normEmail(o.customer.email);
    if (seen.has(email)) continue;
    seen.add(email);
    if (!due(o.createdAt) || isTest(o, settings) || !(await eligible(email))) { run.skipped++; continue; }
    if (!(await claimRecovery(email))) { run.skipped++; continue; }
    await sendEmail(recoveryEmail(origin, email, o.customer.name, freeOrderLink(origin, o.id), o));
    o.recovery = { sentAt: now.toISOString() };
    log(o, "Abandoned checkout: free-proof email sent");
    await saveOrder(o);
    run.sent++;
  }

  // 2. Emails typed in but the form never sent.
  const quota = await leadQuotaLeft(now);
  let left = quota.left;
  for (const lead of await listLeads()) {
    const email = normEmail(lead.email);
    if (seen.has(email) || byEmail.has(email)) { run.skipped++; continue; } // the order path covers them
    if (!due(lead.updatedAt) || !(await eligible(email))) { run.skipped++; continue; }
    if (left <= 0) { run.notes.push("daily cap on reminders for unsent forms reached"); break; }
    if (!(await claimRecovery(email))) { run.skipped++; continue; }
    await sendEmail(recoveryEmail(origin, email, lead.name, freeLeadLink(origin, email), null));
    left--; await quota.bump();
    run.sent++;
  }
  return run;
}

/** Puts an order on the free-proof path and says so in its history. */
export function markFree(order: Order, via: "order" | "lead") {
  order.freeProof = { startedAt: new Date().toISOString(), via };
  order.status = "rendering";
  log(order, `Free proof started (${via === "order" ? "from the reminder email" : "from the reminder email's form link"}); no card yet, it's taken on approval`);
}

export function freeStartedEmail(order: Order) {
  return {
    to: order.customer.email,
    subject: "We're drawing your free Burin & Co. proof",
    html: `<p>${esc(order.customer.name.split(" ")[0])},</p>
      <p>We've started on the ${esc(styleInfo(order.style).name)} portrait of your ${categoryInfo(order.category).subject} (${SIZES[order.size].name}). Within 48 hours (often within 24) we'll email you a proof.</p>
      <p>There's no card on file and nothing to pay unless you approve it. If you do, you'll pay $${(order.price / 100).toLocaleString("en-US")} on a secure Stripe page and we'll print, frame and ship it.</p>
      <p>Questions? Reply to this email.</p><p>Burin &amp; Co.</p>`,
  };
}
