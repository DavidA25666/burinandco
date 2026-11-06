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
// the order carries on as usual. One free proof per email address, and every recovery email has an
// unsubscribe link.
//
// Two days after that first email, anyone who still hasn't paid gets one last email with 10% off:
// taken off their unfinished order (or their unapproved free proof), and off any new order from that
// address in the next 14 days. Then we stop.
import { createHash } from "node:crypto";
import { listOrders, ordersStore, saveOrder, log, type Order } from "./store.mts";
import { sign } from "./sign.mts";
import { floorCents } from "./pricing.mts";
import { sendEmail, button, esc, SITE_DOMAIN } from "./email.mts";
import { SIZES, styleInfo, categoryInfo } from "./catalog.mts";
import { getSettings } from "./ops-store.mts";
import { isTest } from "./ops/economics.mts";

export const WAIT_MS = 60 * 60_000;          // wait an hour after they leave
export const GIVE_UP_MS = 72 * 3_600_000;     // and don't email anyone who left more than 3 days ago
export const LEAD_EMAILS_PER_DAY = 25;        // the lead form takes any address, so cap what it can send
export const SECOND_AFTER_MS = 48 * 3_600_000; // the 10% email goes 2 days after the first
export const SECOND_GIVE_UP_MS = 7 * 86_400_000;
export const DISCOUNT_PCT = 10;
export const DISCOUNT_DAYS = 14;              // how long the 10% holds for a new order

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

// One first email per address, ever; and one 10% email after it.
interface RecoveryRecord { email: string; at: string }
async function claimRecovery(email: string, step: "recovery" | "recovery2" = "recovery") {
  const { modified } = await ordersStore().set(`${step}/${hash(email)}`, JSON.stringify({ email: normEmail(email), at: new Date().toISOString() }), { onlyIfNew: true });
  return modified;
}
async function listRecoveries(): Promise<RecoveryRecord[]> {
  const store = ordersStore();
  const { blobs } = await store.list({ prefix: "recovery/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null) as Promise<RecoveryRecord | null>)))
    .filter((r): r is RecoveryRecord => !!r && typeof r.email === "string");
}

// ---------- the 10% ----------

interface Discount { pct: number; until: string }
async function grantDiscount(email: string, now: Date) {
  const until = new Date(now.getTime() + DISCOUNT_DAYS * 86_400_000).toISOString();
  await ordersStore().setJSON(`discount/${hash(email)}`, { pct: DISCOUNT_PCT, until } satisfies Discount);
}
/** The reminder's 10% for this address, if it still holds. */
export async function discountFor(email: string, now = new Date()): Promise<number> {
  const d = (await ordersStore().get(`discount/${hash(email)}`, { type: "json" })) as Discount | null;
  return d && Date.parse(d.until) > now.getTime() ? d.pct : 0;
}
/** Takes the discount off the order's price (whole dollars, never below HQ's price floor). Once per order. */
export async function applyDiscount(order: Order, pct: number) {
  if (!pct || order.discount || order.paidAt) return;
  const settings = await getSettings();
  const off = Math.max(Math.floor((order.price * (100 - pct)) / 100 / 100) * 100, floorCents(order.size, settings));
  if (off >= order.price) return;
  order.discount = { pct, fullPriceCents: order.price, at: new Date().toISOString() };
  order.price = off;
  log(order, `${pct}% reminder discount: $${(order.discount.fullPriceCents / 100).toFixed(2)} → $${(off / 100).toFixed(2)}`);
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
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:32px">One free proof per customer. We'll send at most one more note about this commission. <a href="${unsub}" style="color:#888">Unsubscribe</a></p>`,
  };
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;

function discountEmail(origin: string, to: string, name: string, link: string, order: Order | null) {
  const first = esc((name || "").split(" ")[0]) || "Hello";
  const subject = order ? categoryInfo(order.category).subject : "portrait";
  const proofWaiting = !!order?.freeProof && order.renders.length > 0;
  const price = order?.discount ? ` <s style="color:#888">${dollars(order.discount.fullPriceCents)}</s> ${dollars(order.price)}` : "";
  const unsub = unsubLink(origin, to);
  return {
    to,
    subject: proofWaiting ? `${DISCOUNT_PCT}% off your ${subject} portrait` : `${DISCOUNT_PCT}% off your Burin & Co. portrait`,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    html: `<p>${first},</p>
      ${proofWaiting
        ? `<p>Your proof is still waiting for you. If you'd like it, we've taken ${DISCOUNT_PCT}% off: approve it and it's${price}, printed, framed and shipped.</p>`
        : `<p>One last note from us: we've taken ${DISCOUNT_PCT}% off your commission${price ? `, so it's now${price}` : ""}. The free proof still stands. We draw it first, and you pay only if you approve it.</p>`}
      ${button(link, proofWaiting ? "See my proof" : order ? "Draw my free proof" : "Get my free proof")}
      ${order ? "" : `<p>The ${DISCOUNT_PCT}% comes off automatically for this email address for the next ${DISCOUNT_DAYS} days.</p>`}
      <p>Questions? Just reply.</p><p>Burin &amp; Co.</p>
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:32px">This is the last reminder we'll send about this commission. <a href="${unsub}" style="color:#888">Unsubscribe</a></p>`,
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

  // 3. Two days later, one 10% email to anyone who still hasn't paid.
  for (const rec of await listRecoveries()) {
    const email = normEmail(rec.email);
    const age = t - Date.parse(rec.at);
    if (age < SECOND_AFTER_MS || age > SECOND_GIVE_UP_MS) continue;
    const mine = byEmail.get(email) ?? [];
    // Paid, approved, card saved, or anything past the proof stage: they're a customer.
    const free = mine.find((o) => o.freeProof && !o.paidAt);
    const customer = mine.some((o) => o.paidAt || o.card || (o !== free && o.status !== "awaiting_card" && o.status !== "awaiting_payment"));
    if (customer || (await isUnsubscribed(email))) { run.skipped++; continue; }
    let target: Order | null = null, link: string;
    if (free) {
      // Only once their free proof has been in their inbox a day; while it's still being drawn, wait.
      if (free.status !== "proof_sent" || !free.proofSentAt || t - Date.parse(free.proofSentAt) < 24 * 3_600_000) { run.skipped++; continue; }
      target = free;
      link = `${origin}/proof.html?o=${free.id}&t=${sign(`proof:${free.id}`)}`;
    } else {
      target = mine.find((o) => o.status === "awaiting_card") ?? null; // newest first
      link = target ? freeOrderLink(origin, target.id) : freeLeadLink(origin, email);
      if (target && isTest(target, settings)) { run.skipped++; continue; }
    }
    if (!(await claimRecovery(email, "recovery2"))) continue;
    await grantDiscount(email, now);
    if (target) {
      await applyDiscount(target, DISCOUNT_PCT);
      log(target, `Abandoned checkout: ${DISCOUNT_PCT}% reminder sent`);
      await saveOrder(target);
    }
    await sendEmail(discountEmail(origin, email, target?.customer.name ?? "", link, target));
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
