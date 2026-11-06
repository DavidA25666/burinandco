// Tenfold HQ Admin Plug: every /api/ops/* endpoint in docs/SITE_CONTRACT.md, signed with
// PORTFOLIO_OPS_SECRET (HMAC-SHA256, 5-minute window). JSON, cache-control: no-store, no CORS.
import type { Config } from "@netlify/functions";
import { verifyOps, opsUnauthorized, opsJson } from "../shared/ops-auth.mts";
import { listOrders, getOrder, type Order } from "../shared/store.mts";
import {
  getSettings, updateSettings, listAiCalls, listVisits, liveVisitors, aiSpendThisMonth, webhookStatus, listDisputes,
  listOutbox, removeOutbox, saveOutbox, rememberedResult, rememberResult, listAudit, nyDate, addDays, audit, cached, type Settings,
} from "../shared/ops-store.mts";
import { buildMetrics } from "../shared/ops/metrics.mts";
import { searchConsoleBlock } from "../shared/search-console.mts";
import { buildHealth, buildCash } from "../shared/ops/health.mts";
import { ordersView, buildAlerts, attributionView, liveView, reportView, orderIssue, orderActions, fulfillmentInfo } from "../shared/ops/views.mts";
import { vendorsView } from "../shared/ops/vendors.mts";
import { sectionActions, SETTING_KEYS } from "../shared/ops/capabilities.mts";
import { aiByOrder, isTest, orderMoney, shortName, shortId, itemName } from "../shared/ops/economics.mts";
import { runOrderAction, printFileProblem, ActionError, ORDER_ACTIONS } from "../shared/order-actions.mts";
import { pricingView, applyPriceChange, PriceError, isSku, priceCents, unitCostCents, activeSkus } from "../shared/pricing.mts";
import { inboxView, inboxAction, InboxError } from "../shared/inbox.mts";
import { deliver } from "../shared/email.mts";
import { fileUrl } from "../shared/sign.mts";
import { checkFinerworks, finerworksLive } from "../shared/finerworks.mts";
import { runFinerworksSync } from "../shared/finerworks-sync.mts";
import { SIZES, styleInfo, categoryInfo, FRAMES } from "../shared/catalog.mts";

const SITE = Netlify.env.get("HQ_SITE_SLUG") || "burinandco";
const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const reply = (status: number, ok: boolean, message: string, code: string | null = null, data?: unknown) => opsJson({ ok, message, code, ...(data !== undefined ? { data } : {}) }, status);

function range(q: URLSearchParams) {
  const today = nyDate();
  const to = isDay(q.get("to")) ? q.get("to")! : today;
  const from = isDay(q.get("from")) ? q.get("from")! : addDays(to, -29);
  if (from > to) return { from: to, to };
  // Support at least 366 days; cap at 400.
  return { from: from < addDays(to, -400) ? addDays(to, -400) : from, to };
}

// ---------- GET handlers ----------

async function metrics(q: URLSearchParams) {
  const { from, to } = range(q);
  const [orders, settings, aiCalls, visits] = await Promise.all([listOrders(), getSettings(), listAiCalls(), listVisits(from, to)]);
  const out = buildMetrics({ site: SITE, orders, aiCalls, visits, settings, from, to, fixedCosts: [] });
  out.seo = { ...(out.seo as object), search_console: await searchConsoleBlock(from, to) };
  out.cash = await buildCash(orders).catch((e) => ({ configured: true, status: "error", missing_permissions: [], errors: { all: String(e) } }));
  return out;
}

async function alerts() {
  const [orders, settings, aiMonthCents, webhook, disputes, outbox, aiCalls] = await Promise.all([listOrders(), getSettings(), aiSpendThisMonth(), webhookStatus(), listDisputes(), listOutbox(), listAiCalls()]);
  const env = Object.fromEntries(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "FROM_EMAIL", "REPLICATE_API_TOKEN", "SITE_SECRET", "FINERWORKS_WEB_API_KEY", "FINERWORKS_APP_KEY"].map((n) => [n, !!Netlify.env.get(n)]));
  return buildAlerts({ orders, settings, aiMonthCents, webhook, disputes, outbox, production: Netlify.context?.deploy?.context === "production", env, finerworksLive: finerworksLive(), aiCalls });
}

function adminOrderRow(o: Order, settings: Settings, ai: Map<string, number>, origin: string) {
  const issue = orderIssue(o);
  const latest = o.renders.at(-1);
  const m = orderMoney(o, settings, ai);
  const actions = [...orderActions(o)];
  if (o.renders.length && ["needs_review", "changes_requested", "proof_sent"].includes(o.status)) actions.push("send_proof");
  if (["needs_review", "changes_requested", "proof_sent", "render_failed", "card_saved", "paid", "customer_approved"].includes(o.status)) actions.push("regenerate");
  if (o.status !== "sent_to_print" && o.status !== "archived" && o.status !== "refunded") actions.push("set_caption");
  if (o.status === "customer_approved" && o.renders.length && o.printStatus !== "preparing") actions.push("prepare_print");
  if (o.status === "customer_approved" && o.paidAt && !printFileProblem(o)) actions.push("send_to_finerworks", "mark_sent_to_print");
  if (o.status !== "archived") actions.push("archive");
  if (["proof_sent", "payment_due"].includes(o.status) || o.finerworks?.shipments?.length) actions.push("resend_email");
  actions.push("mark_test");
  if (o.paymentIntentId || o.finerworks) actions.push("refresh_status");
  const attention = issue ? (issue.status === "failed" ? "critical" : "high") : o.status === "needs_review" || o.status === "changes_requested" || o.status === "customer_approved" ? "normal" : undefined;
  return {
    id: o.id,
    number: shortId(o),
    status: o.status,
    status_label: issue?.issue ?? o.status.replace(/_/g, " "),
    customer: shortName(o.customer.name),
    subject: categoryInfo(o.category).name,
    style: styleInfo(o.style).name,
    size: SIZES[o.size]?.name ?? o.size,
    frame: FRAMES[o.frame] ?? o.frame,
    caption: o.caption ?? "",
    customer_notes: o.notes || "",
    last_change_request: o.changeRequests.at(-1)?.note ?? null,
    version: o.renders.length,
    amount_cents: o.price,
    profit_cents: o.paidAt ? m.profit : null,
    ai_cents: m.ai,
    created_at: o.createdAt,
    paid_at: o.paidAt ?? null,
    proof_sent_at: o.proofSentAt ?? null,
    photo_url: fileUrl(origin, o.photoKey),
    preview_url: latest ? fileUrl(origin, latest.key) : fileUrl(origin, o.photoKey),
    print_file_url: o.printFile ? fileUrl(origin, o.printFile.key) : null,
    print_file_problem: o.status === "customer_approved" ? printFileProblem(o) : null,
    print_order: o.printOrderRef ?? null,
    payment_intent: o.paymentIntentId ?? null,
    ...(o.paymentIntentId ? { stripe_url: `https://dashboard.stripe.com/${o.livemode === false ? "test/" : ""}payments/${o.paymentIntentId}` } : {}),
    error: o.lastError ?? o.printError ?? null,
    is_test: isTest(o, settings),
    fulfillment: fulfillmentInfo(o),
    history: o.history.slice(-6).map((h) => `${h.at.slice(0, 16).replace("T", " ")} ${h.event}`).join("\n"),
    ...(attention ? { attention, attention_title: issue?.issue ?? o.status.replace(/_/g, " ") } : {}),
    actions: [...new Set(actions)],
  };
}

async function adminRead(section: string, q: URLSearchParams, origin: string) {
  const settings = await getSettings();
  switch (section) {
    case "orders": {
      const [orders, aiCalls] = await Promise.all([listOrders(), listAiCalls()]);
      const ai = aiByOrder(aiCalls);
      const term = (q.get("q") ?? "").trim().toLowerCase();
      const all = q.get("all") === "1";
      let list = orders.filter((o) => o.status !== "awaiting_card" && o.status !== "awaiting_payment");
      if (!all && !term) list = list.filter((o) => o.status !== "archived");
      if (term) list = list.filter((o) => [o.id, shortId(o), o.customer.name, o.customer.email, o.caption ?? "", o.printOrderRef ?? ""].some((f) => f.toLowerCase().includes(term)));
      const items = list.slice(0, 200).map((o) => adminOrderRow(o, settings, ai, origin));
      const count = (s: string) => list.filter((o) => o.status === s).length;
      return { columns: ["number", "customer", "subject", "style", "size", "status_label", "version", "amount_cents", "created_at"], items, summary: { to_review: count("needs_review"), change_requests: count("changes_requested"), waiting_on_customer: count("proof_sent"), to_print: count("customer_approved"), failed: count("render_failed") } };
    }
    case "settings": {
      const row = (id: string, label: string, value: string, help: string) => ({ id, setting: id, label, value, help, status: "ok", actions: ["set_setting"] });
      return {
        items: [
          row("maintenance", "Maintenance mode", settings.maintenance ? "on" : "off", "On closes checkout with a short notice on the site."),
          row("headline", "Homepage headline", settings.headline ?? "(default)", "Plain text, 3 to 140 characters. Send 'default' to restore."),
          row("owner_test_emails", "Owner / test emails", settings.ownerTestEmails.join(", ") || "(none)", "Orders from these emails are test orders and are left out of HQ's numbers."),
          ...[...SETTING_KEYS].filter((k) => k.startsWith("unit_cost_")).map((k) => {
            const sku = k.slice(10);
            return row(k, `FinerWorks cost, ${SIZES[sku as keyof typeof SIZES]?.name ?? sku}`, `$${(unitCostCents(sku, settings) / 100).toFixed(2)}${settings.unitCosts[sku] == null ? " (built-in estimate)" : ""}`, "Print, frame and Ground shipping per order, in dollars. Sets the break-even price floor. Send 'default' for the built-in estimate.");
          }),
        ],
        summary: Object.fromEntries(activeSkus().map((s) => [`price ${SIZES[s].name}`, priceCents(s, settings) / 100])),
        note: "Prices are edited in HQ's price editor (Prices).",
      };
    }
    case "ai": {
      const today = nyDate();
      const calls = (await listAiCalls(addDays(today, -60), today)).sort((a, b) => b.at.localeCompare(a.at));
      const month = calls.filter((c) => c.date.startsWith(today.slice(0, 7)));
      const sum = (xs: typeof calls) => xs.reduce((t, c) => t + c.cents, 0);
      return {
        items: calls.slice(0, 100).map((c, i) => ({ id: `${c.at}-${i}`, status: c.ok ? "ok" : "failed", at: c.at, model: c.model, purpose: c.purpose, order: c.orderId ? `BC-${c.orderId.slice(0, 6).toUpperCase()}` : null, amount_cents: c.cents, seconds: c.seconds })),
        summary: {
          month_spent_cents: sum(month), monthly_cap_cents: settings.aiMonthlyCapCents,
          cap_used_percent: settings.aiMonthlyCapCents ? Math.round((sum(month) / settings.aiMonthlyCapCents) * 100) : 0,
          orders_cents: sum(month.filter((c) => c.purpose !== "lab")), lab_cents: sum(month.filter((c) => c.purpose === "lab")),
          lab_enabled: 1, cap_blocks_regenerations: settings.aiCapBlocksOrders ? 1 : 0,
        },
        note: "No scheduled or background AI jobs. AI runs only for a paid commission (render, regenerate, print upscale) or the model lab. Costs are Replicate list prices per image.",
      };
    }
    case "finerworks": {
      const fresh = q.get("fresh") === "1";
      const r = fresh ? await checkFinerworks() : await cached("finerworks-check", 10 * 60_000, checkFinerworks);
      return {
        items: r.products.map((p) => ({ id: p.env, status: p.ok ? "ok" : "failed", product: p.label, code: p.code, detail: p.detail, ...(p.ok ? {} : { attention: "high" }) })),
        summary: { live: r.live ? 1 : 0 },
        note: `${r.credentials}. ${r.live ? "Live orders." : "Test mode (not printed)."} ${r.payment ? `Payment: ${r.payment.detail}` : ""}`.trim(),
      };
    }
    case "email-outbox": {
      const items = (await listOutbox()).map((m) => ({ id: m.id, email_id: m.id, status: "failed", subject: m.subject, at: m.at, attempts: m.attempts, error: m.lastError, attention: "normal" }));
      return { items, summary: { failed: items.length } };
    }
    case "cogs": {
      const [orders, aiCalls] = await Promise.all([listOrders(), listAiCalls()]);
      const ai = aiByOrder(aiCalls);
      const today = nyDate();
      const from = q.get("from") ?? `${today.slice(0, 7)}-01`;
      const to = q.get("to") ?? today;
      const paid = orders.filter((o) => o.paidAt && nyDate(o.paidAt) >= from && nyDate(o.paidAt) <= to);
      const items = paid.map((o) => {
        const m = orderMoney(o, settings, ai);
        const test = isTest(o, settings);
        const estimated = !(m.feesActual && m.fulfillmentActual);
        return {
          id: o.id, order_id: o.id, number: shortId(o), paid_at: o.paidAt, item: `${SIZES[o.size]?.name ?? o.size}, ${(FRAMES[o.frame] ?? o.frame).toLowerCase()}`,
          status: test ? "test" : estimated ? "estimated" : "ok",
          revenue_cents: m.revenue, refunds_cents: m.refunds,
          stripe_fee_cents: m.fees, stripe_fee_source: m.feesActual ? "actual" : "estimated",
          fulfillment_cents: m.fulfillment, fulfillment_source: m.fulfillmentActual ? "actual" : "estimated",
          model_fulfillment_cents: unitCostCents(o.size, settings),
          ai_cents: m.ai, ai_source: "estimated",
          profit_cents: m.profit, is_test: test,
          finerworks_status: o.finerworks?.status ?? null, checked_at: o.finerworks?.checkedAt ?? null,
          actions: o.paymentIntentId || o.finerworks ? ["refresh_status"] : [],
        };
      });
      const real = items.filter((r) => !r.is_test);
      const sum = (k: "revenue_cents" | "refunds_cents" | "stripe_fee_cents" | "fulfillment_cents" | "ai_cents" | "profit_cents") => real.reduce((t, r) => t + r[k], 0);
      const lines = real.length * 2;
      const actual = real.reduce((t, r) => t + (r.stripe_fee_source === "actual" ? 1 : 0) + (r.fulfillment_source === "actual" ? 1 : 0), 0);
      return {
        columns: ["number", "paid_at", "item", "revenue_cents", "stripe_fee_cents", "stripe_fee_source", "fulfillment_cents", "fulfillment_source", "ai_cents", "profit_cents"],
        items,
        summary: { orders: real.length, revenue_cents: sum("revenue_cents"), refunds_cents: sum("refunds_cents"), stripe_fees_cents: sum("stripe_fee_cents"), fulfillment_cents: sum("fulfillment_cents"), ai_cents: sum("ai_cents"), profit_cents: sum("profit_cents"), actual_share: lines ? Math.round((actual / lines) * 100) / 100 : 0 },
        note: `${from} to ${to}, test orders shown but not totalled. FinerWorks cost is the per-size model (Admin → Store settings) until FinerWorks reports what it charged for the order, then it's actual. The sync asks every 6 hours. Stripe fees are actual once the charge settles. AI is Replicate list prices per run.`,
      };
    }
    case "audit": {
      const items = (await listAudit(150)).map((a, i) => ({ id: `${a.at}-${i}`, status: "ok", at: a.at, by: a.by ?? "unknown", action: a.action, details: JSON.stringify(a.details).slice(0, 400) }));
      return { items };
    }
  }
  return null;
}

// ---------- POST /api/ops/actions ----------

async function flushOutbox() {
  const items = await listOutbox();
  let sent = 0;
  for (const m of items) {
    const r = await deliver({ to: m.to, subject: m.subject, html: m.html, raw: true, replyTo: m.replyTo, headers: m.headers, from: m.from });
    if (r.ok) { await removeOutbox(m.id); sent++; } else await saveOutbox({ ...m, attempts: m.attempts + 1, lastError: r.error ?? "unknown" });
  }
  return { sent, left: items.length - sent };
}

const onOff = (v: unknown) => {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(s)) return true;
  if (["off", "false", "no", "0"].includes(s)) return false;
  return null;
};

type Result = [status: number, ok: boolean, message: string, code: string | null, data?: unknown];

async function runAction(body: any, origin: string, requestId: string | null): Promise<Result> {
  const action = String(body?.action ?? "");
  const params = body?.params && typeof body.params === "object" ? body.params : {};
  const by = String(body?.sent_by ?? params?.sent_by ?? body?.actor ?? "HQ").slice(0, 80);
  const ok = (message: string, data?: unknown): Result => [200, true, message, null, data];
  const no = (status: number, code: string, message: string, data?: unknown): Result => [status, false, message, code, data];

  // Order actions (contract §6 and the Orders admin section).
  if ((ORDER_ACTIONS as readonly string[]).includes(action)) {
    const id = String(params.order_id ?? params.orderId ?? params.id ?? "");
    const order = (await getOrder(id)) ?? (await listOrders()).find((o) => shortId(o) === id.toUpperCase()) ?? null;
    if (!order) return no(404, "order_not_found", `No order "${id}".`);
    const amount = params.amount != null && params.amount !== "" ? Math.round(Number(params.amount) * 100) : null;
    if (amount != null && !(amount > 0)) return no(400, "invalid_params", "Amount must be a positive number of dollars.");
    try {
      const note = params.note ?? params.caption ?? params.which ?? (params.on != null ? String(params.on) : null);
      const r = await runOrderAction(origin, action, order, { note, amountCents: amount, reason: params.reason ?? null, requestId, force: false });
      await audit(by, `order:${action}`, { orderId: order.id, params });
      return ok(r.message, { order_id: order.id, status: r.order.status });
    } catch (e) {
      if (e instanceof ActionError) { await audit(by, `order:${action}:refused`, { orderId: order.id, reason: e.message }); return no(e.status, e.code, e.message); }
      throw e;
    }
  }

  switch (action) {
    case "rerun_job": {
      const job = String(params.job_id ?? params.jobId ?? params.id ?? "finerworks-sync");
      if (job !== "finerworks-sync") return no(404, "job_not_found", `No job "${job}". Burin & Co. has one job: finerworks-sync.`);
      const run = await runFinerworksSync();
      await audit(by, "rerun_job", { job, result: run });
      return run.status === "ok" ? ok(`FinerWorks sync ran: ${run.message}.`, run) : no(502, "job_failed", `FinerWorks sync: ${run.message}.`, run);
    }

    case "pause_site":
      await updateSettings(by, "pause_site", (s) => { s.maintenance = true; s.maintenanceReason = params.reason ? String(params.reason).slice(0, 200) : null; });
      return ok("Checkout is closed and the site shows a short notice. Proofs, approvals and print orders keep running.");

    case "resume_site":
      await updateSettings(by, "resume_site", (s) => { s.maintenance = false; s.maintenanceReason = null; });
      return ok("Checkout is open again.");

    case "set_price": {
      const sku = String(params.sku ?? "");
      if (!isSku(sku)) return no(404, "sku_not_found", `Unknown sku "${sku}".`);
      const price = Number(params.price);
      if (!(price > 0)) return no(400, "invalid_params", "price must be a positive number of dollars.");
      const settings = await getSettings();
      try {
        const msg = applyPriceChange(settings, { op: "set", product: sku, price }, by);
        await updateSettings(by, "set_price", (s) => { s.priceOverrides = settings.priceOverrides; s.pricingVersion = settings.pricingVersion; });
        return ok(msg);
      } catch (e) {
        if (e instanceof PriceError) return no(e.code === "below_floor" ? 422 : e.status, e.code === "below_floor" ? "below_profit_floor" : e.code, e.message, e.data);
        throw e;
      }
    }

    case "flush_email_outbox": {
      const r = await flushOutbox();
      await audit(by, "flush_email_outbox", r);
      return ok(`${r.sent} email${r.sent === 1 ? "" : "s"} sent${r.left ? `, ${r.left} still failing` : ""}.`, r);
    }

    case "discard_email": {
      const id = String(params.email_id ?? "");
      if (!(await listOutbox()).some((m) => m.id === id)) return no(404, "not_found", "That email isn't in the outbox.");
      await removeOutbox(id);
      await audit(by, "discard_email", { id });
      return ok("Discarded.");
    }

    case "update_homepage_headline": {
      const headline = String(params.headline ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (headline.length < 3 || headline.length > 140) return no(400, "invalid_params", "The headline must be 3 to 140 characters of plain text.");
      await updateSettings(by, "update_homepage_headline", (s) => { s.headline = headline; });
      return ok(`Headline is now "${headline}".`);
    }

    case "set_setting": {
      const key = String(params.setting ?? "");
      const value = String(params.value ?? "").trim();
      if (!(SETTING_KEYS as readonly string[]).includes(key)) return no(400, "invalid_params", `Unknown setting "${key}".`);
      if (key === "maintenance") {
        const v = onOff(value);
        if (v == null) return no(400, "invalid_params", "Use on or off.");
        await updateSettings(by, "set_setting:maintenance", (s) => { s.maintenance = v; });
        return ok(`Maintenance mode ${v ? "on" : "off"}.`);
      }
      if (key === "headline") {
        if (value.toLowerCase() === "default") { await updateSettings(by, "set_setting:headline", (s) => { s.headline = null; }); return ok("Headline restored to the default."); }
        return runAction({ action: "update_homepage_headline", params: { headline: value }, sent_by: by }, origin, requestId);
      }
      if (key === "owner_test_emails") {
        const list = value.toLowerCase() === "none" ? [] : value.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
        if (list.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) return no(400, "invalid_params", "Send email addresses separated by commas.");
        await updateSettings(by, "set_setting:owner_test_emails", (s) => { s.ownerTestEmails = list; });
        return ok(`${list.length} test email${list.length === 1 ? "" : "s"} saved.`);
      }
      const sku = key.slice(10);
      if (value.toLowerCase() === "default") { await updateSettings(by, `set_setting:${key}`, (s) => { delete s.unitCosts[sku]; }); return ok("Back to the built-in cost estimate."); }
      const dollars = Number(value.replace(/[$,]/g, ""));
      if (!(dollars > 0 && dollars < 5000)) return no(400, "invalid_params", "Send the cost in dollars, like 172.50.");
      await updateSettings(by, `set_setting:${key}`, (s) => { s.unitCosts[sku] = Math.round(dollars * 100); });
      return ok(`FinerWorks cost for ${SIZES[sku as keyof typeof SIZES]?.name ?? sku} set to $${dollars.toFixed(2)}. Prices below the new break-even are raised to it.`);
    }

    case "set_ai_cap": {
      const dollars = Number(params.dollars);
      if (!(dollars >= 1 && dollars <= 5000)) return no(400, "invalid_params", "The budget must be between $1 and $5,000.");
      await updateSettings(by, "set_ai_cap", (s) => { s.aiMonthlyCapCents = Math.round(dollars * 100); });
      return ok(`Monthly AI budget set to $${dollars.toFixed(2)}. HQ is alerted at 75%.`);
    }

    case "set_ai_cap_blocks_orders": {
      const v = onOff(params.on);
      if (v == null) return no(400, "invalid_params", "on must be true or false.");
      await updateSettings(by, "set_ai_cap_blocks_orders", (s) => { s.aiCapBlocksOrders = v; });
      return ok(v ? "At the cap, regenerations and print upscales stop too." : "At the cap, HQ alerts but nothing stops.");
    }

    case "check_finerworks": {
      const r = await checkFinerworks();
      const bad = r.products.filter((p) => !p.ok);
      return ok(`${r.credentials}. ${r.live ? "Live" : "Test mode"}. ${bad.length ? `${bad.length} product code problem(s).` : "All product codes price correctly."}`, r);
    }
  }

  // Inbox and experiment fallbacks (§7b, §10) arrive here as inbox_<action> / experiment_<action>.
  if (action.startsWith("inbox_")) {
    try { const r = await inboxAction(action.slice(6), params, by); await audit(by, action, params); return ok(r.message); }
    catch (e) { if (e instanceof InboxError) return no(e.status, e.code, e.message); throw e; }
  }

  // Includes HQ's "Save & test" probe, hq_signature_check: nothing changes.
  return no(400, "unknown_action", `Unknown action "${action}"`);
}

// ---------- Router ----------

export default async (req: Request) => {
  const v = await verifyOps(req, Netlify.env.get("PORTFOLIO_OPS_SECRET"));
  if (!v.ok) return opsUnauthorized(v.reason);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;
  const origin = url.origin;

  try {
    if (req.method === "GET") {
      switch (path) {
        case "/api/ops/health": {
          const [orders, settings] = await Promise.all([listOrders(), getSettings()]);
          return opsJson(await buildHealth(SITE, orders, settings));
        }
        case "/api/ops/capabilities": {
          const [orders, settings] = await Promise.all([listOrders(), getSettings()]);
          return opsJson({ capabilities: (await buildHealth(SITE, orders, settings)).capabilities });
        }
        case "/api/ops/metrics": return opsJson(await metrics(q));
        case "/api/ops/alerts": return opsJson(await alerts());
        case "/api/ops/orders": {
          const [orders, settings, aiCalls] = await Promise.all([listOrders(), getSettings(), listAiCalls()]);
          return opsJson(ordersView(orders, settings, aiCalls, q));
        }
        case "/api/ops/attribution": {
          const { from, to } = range(q);
          const [orders, settings, aiCalls] = await Promise.all([listOrders(), getSettings(), listAiCalls()]);
          return opsJson(attributionView(SITE, orders, settings, aiCalls, from, to));
        }
        case "/api/ops/inbox": return opsJson(await inboxView());
        case "/api/ops/live": {
          const [orders, settings, visitors] = await Promise.all([listOrders(), getSettings(), liveVisitors(5)]);
          return opsJson(liveView(orders, settings, visitors));
        }
        case "/api/ops/report":
        case "/api/ops/reports": {
          const month = q.get("month");
          const [orders, settings, aiCalls] = await Promise.all([listOrders(), getSettings(), listAiCalls()]);
          const current = nyDate().slice(0, 7);
          if (month) {
            if (!/^\d{4}-\d{2}$/.test(month)) return opsJson({ ok: false, code: "invalid_params", message: "month must be YYYY-MM" }, 400);
            if (month >= current) return opsJson({ ok: false, ready: false, code: "not_found", message: "No report for that month yet" }, 404);
            return opsJson(reportView(orders, settings, aiCalls, month));
          }
          const first = orders.filter((o) => o.paidAt).map((o) => o.paidAt!.slice(0, 7)).sort()[0];
          const months: string[] = [];
          if (first) for (let m = first; m < current; ) { months.push(m); const [y, mm] = m.split("-").map(Number); m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; }
          return opsJson({ reports: months.map((m) => reportView(orders, settings, aiCalls, m)) });
        }
        case "/api/ops/pricing": return opsJson(pricingView(await getSettings()));
        case "/api/ops/vendors": {
          const [orders, settings, aiCalls] = await Promise.all([listOrders(), getSettings(), listAiCalls()]);
          return opsJson(vendorsView(orders, settings, aiCalls));
        }
      }
      if (path.startsWith("/api/ops/admin/")) {
        const data = await adminRead(path.slice("/api/ops/admin/".length), q, origin);
        if (data) return opsJson({ section: path.split("/").pop(), generatedAt: new Date().toISOString(), ...data });
      }
      return opsJson({ ok: false, code: "not_found", message: `No endpoint ${path}` }, 404);
    }

    if (req.method === "POST") {
      let body: any;
      try { body = JSON.parse(v.body || "{}"); } catch { return reply(400, false, "Body must be JSON.", "invalid_params"); }
      const requestId = req.headers.get("x-portfolio-request-id");

      if (path === "/api/ops/actions") {
        const seen = await rememberedResult(requestId);
        if (seen) return opsJson(seen.body, seen.status);
        // Section actions must be advertised; contract actions and inbox_ fallbacks are always accepted.
        const known = sectionActions();
        if (body?.section && !known.has(String(body.action))) {
          return reply(400, false, `"${body.action}" isn't an action of section "${body.section}".`, "unknown_action");
        }
        const [status, ok, message, code, data] = await runAction(body, origin, requestId);
        const out = { ok, message, code, ...(data !== undefined ? { data } : {}) };
        if (body?.action !== "hq_signature_check") await rememberResult(requestId, status, out);
        return opsJson(out, status);
      }

      if (path === "/api/ops/pricing") {
        if (!requestId) return reply(400, false, "X-Portfolio-Request-Id is required.", "invalid_params");
        const seen = await rememberedResult(requestId);
        if (seen) return opsJson(seen.body, seen.status);
        const by = String(body?.sent_by ?? "HQ").slice(0, 80);
        const settings = await getSettings();
        try {
          const message = applyPriceChange(settings, body, by);
          await updateSettings(by, `pricing:${body.op}`, (s) => { s.priceOverrides = settings.priceOverrides; s.priceSchedules = settings.priceSchedules; s.pricingVersion = settings.pricingVersion; });
          const view = pricingView(settings);
          const sku = String(body.product ?? body.sku);
          const out = { ok: true, message, data: { version: view.version, cell: view.cells.base[sku]?.single ?? null, schedules: view.schedules } };
          await rememberResult(requestId, 200, out);
          return opsJson(out);
        } catch (e) {
          if (e instanceof PriceError) {
            await audit(by, `pricing:${body?.op}:refused`, { body, reason: e.message });
            return opsJson({ ok: false, code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) }, e.status);
          }
          throw e;
        }
      }

      if (path === "/api/ops/inbox") {
        const seen = await rememberedResult(requestId);
        if (seen) return opsJson(seen.body, seen.status);
        const by = String(body?.sent_by ?? body?.params?.sent_by ?? "HQ").slice(0, 80);
        try {
          const r = await inboxAction(String(body?.action ?? ""), body?.params ?? {}, by);
          await audit(by, `inbox:${body.action}`, body.params ?? {});
          await rememberResult(requestId, 200, r);
          return opsJson(r);
        } catch (e) {
          if (e instanceof InboxError) return opsJson({ ok: false, code: e.code, message: e.message }, e.status);
          throw e;
        }
      }
      return opsJson({ ok: false, code: "not_found", message: `No endpoint ${path}` }, 404);
    }
    return opsJson({ ok: false, code: "method_not_allowed", message: "Use GET or POST" }, 405);
  } catch (e) {
    console.error("ops error", path, e);
    return opsJson({ ok: false, code: "server_error", message: e instanceof Error ? e.message.slice(0, 300) : "Something went wrong" }, 500);
  }
};

export const config: Config = { path: ["/api/ops/*"], preferStatic: false };
