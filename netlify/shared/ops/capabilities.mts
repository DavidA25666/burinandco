// What Burin & Co. supports in Tenfold HQ (§15), what doesn't apply and why, and the store
// admin screens HQ runs (§16).
export const FEATURES = [
  "health", "metrics", "unit_economics", "orders", "alerts", "actions", "prices", "price_matrix",
  "attribution", "inbox", "geo", "cohorts", "channels", "cash", "fulfillment", "mix", "seo",
  "live", "report", "admin", "vendors",
];

// HQ ignores unknown keys; this list is for owners reading the capabilities and for the PR checklist.
export const NOT_APPLICABLE: Record<string, string> = {
  recurring: "No subscriptions or scheduled orders: every portrait is a one-off commission.",
  addon_prices: "No paid add-ons: the caption under the art is free and the collector edition is retired. Every price is a size, edited under Prices.",
  demand: "No saved dates or reminders to forecast from: customers order when they have a photo.",
  plans_goals: "FinerWorks has no plan tiers to compare, and no monthly goals have been set for Burin yet.",
  feedback: "The store doesn't ask for ratings yet; change requests and refunds are reported under Fulfillment quality.",
  experiments: "No A/B testing yet. At current traffic a test wouldn't reach a result; prices can still be changed and scheduled.",
  campaigns: "No promo codes, referral codes or mailers yet. Ads are judged under Ads attribution from UTMs.",
  business: "No business accounts, API or triggered sends: consumer orders only.",
};

type Prop = { type: "string" | "number" | "integer" | "boolean"; title?: string; description?: string; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number; format?: string; default?: unknown };
const schema = (properties: Record<string, Prop>, required: string[] = []) => ({ type: "object", properties, required });
const orderId: Prop = { type: "string", title: "Order" };

export const SETTING_KEYS = ["maintenance", "headline", "owner_test_emails", "unit_cost_12x16", "unit_cost_16x20"] as const;

export function adminSections() {
  return [
    {
      id: "orders",
      title: "Orders",
      description: "Every commission: compare the render with the photo, send proofs, make print files and send them to FinerWorks.",
      view: "orders",
      read_endpoint: "/api/ops/admin/orders",
      search: "q",
      actions: [
        { name: "send_proof", label: "Send proof", scope: "row", destructive: false, confirm_required: "conditional", confirm: "This emails the customer their proof.", params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "regenerate", label: "Regenerate", scope: "row", destructive: false, params: schema({ order_id: orderId, note: { type: "string", title: "What to fix", description: "Optional note for the new version", maxLength: 600, format: "textarea" } }, ["order_id"]) },
        { name: "set_caption", label: "Edit caption", scope: "row", destructive: false, params: schema({ order_id: orderId, caption: { type: "string", title: "Caption", description: "Printed under the art in capitals; empty removes it", maxLength: 40 } }, ["order_id"]) },
        { name: "prepare_print", label: "Make print file", scope: "row", destructive: false, params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "send_to_finerworks", label: "Send to FinerWorks", scope: "row", destructive: true, confirm: "This places the order with FinerWorks and charges the FinerWorks card on file.", params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "mark_sent_to_print", label: "Mark sent to print", scope: "row", destructive: false, params: schema({ order_id: orderId, note: { type: "string", title: "Lab order number", maxLength: 120 } }, ["order_id"]) },
        { name: "retry_order", label: "Retry", scope: "row", destructive: false, params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "refund_order", label: "Refund", scope: "row", destructive: true, confirm: "This refunds the customer through Stripe.", params: schema({ order_id: orderId, amount: { type: "number", title: "Amount ($)", description: "Leave empty for a full refund", minimum: 0.01 }, reason: { type: "string", title: "Reason", maxLength: 300 } }, ["order_id"]) },
        { name: "archive", label: "Archive", scope: "row", destructive: true, confirm: "Archive hides the order from the active list.", params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "resend_email", label: "Resend email", scope: "row", destructive: false, confirm_required: "conditional", confirm: "This emails the customer again: their proof, or their tracking once it has shipped.", params: schema({ order_id: orderId, which: { type: "string", title: "Which email", enum: ["proof", "shipping"], description: "Leave empty for the latest one" } }, ["order_id"]) },
        { name: "mark_test", label: "Mark as test", scope: "row", destructive: false, params: schema({ order_id: orderId, on: { type: "boolean", title: "Test order", description: "Off makes it count as a real order again", default: true } }, ["order_id"]) },
        { name: "refresh_status", label: "Refresh status", scope: "row", destructive: false, params: schema({ order_id: orderId }, ["order_id"]) },
      ],
    },
    {
      id: "cogs",
      title: "Real cost of goods",
      description: "What each paid order really cost: Stripe fee, FinerWorks, AI, and whether each number is actual or still an estimate.",
      view: "table",
      read_endpoint: "/api/ops/admin/cogs",
      actions: [
        { name: "refresh_status", label: "Refresh from Stripe and FinerWorks", scope: "row", destructive: false, params: schema({ order_id: orderId }, ["order_id"]) },
        { name: "rerun_job", label: "Sync all FinerWorks orders now", scope: "section", destructive: false, params: schema({ job_id: { type: "string", title: "Job", enum: ["finerworks-sync"], default: "finerworks-sync" } }) },
      ],
    },
    {
      id: "settings",
      title: "Store settings",
      description: "Maintenance mode, homepage headline, test-order emails and FinerWorks costs.",
      read_endpoint: "/api/ops/admin/settings",
      actions: [
        { name: "set_setting", label: "Change setting", scope: "row", destructive: false, params: schema({
          setting: { type: "string", title: "Setting", enum: [...SETTING_KEYS] },
          value: { type: "string", title: "New value", description: "on/off, text, comma-separated emails, or dollars", maxLength: 600 },
        }, ["setting", "value"]) },
      ],
    },
    {
      id: "ai",
      title: "AI spend",
      description: "Every Replicate run with its estimated cost, the monthly AI budget, and the model-lab switch.",
      read_endpoint: "/api/ops/admin/ai",
      actions: [
        { name: "set_ai_cap", label: "Set monthly AI budget", scope: "section", destructive: false, params: schema({ dollars: { type: "number", title: "Monthly budget ($)", minimum: 1, maximum: 5000 } }, ["dollars"]) },
        { name: "set_ai_cap_blocks_orders", label: "Budget also blocks regenerations", scope: "section", destructive: false, params: schema({ on: { type: "boolean", title: "Block regenerations and print upscales at the cap" } }, ["on"]) },
      ],
    },
    {
      id: "finerworks",
      title: "FinerWorks",
      description: "Keys, live/test mode, the saved card, and each product code with its price.",
      read_endpoint: "/api/ops/admin/finerworks",
      actions: [
        { name: "check_finerworks", label: "Check FinerWorks now", scope: "section", destructive: false, params: schema({}) },
      ],
    },
    {
      id: "email_outbox",
      title: "Email outbox",
      description: "Customer emails that failed to send.",
      view: "alerts",
      read_endpoint: "/api/ops/admin/email-outbox",
      actions: [
        { name: "flush_email_outbox", label: "Retry all", scope: "section", destructive: false, params: schema({}) },
        { name: "discard_email", label: "Discard", scope: "row", destructive: true, params: schema({ email_id: { type: "string" } }, ["email_id"]) },
      ],
    },
    {
      id: "audit",
      title: "Change log",
      description: "Every setting, price and order action, with who made it.",
      read_endpoint: "/api/ops/admin/audit",
      actions: [],
    },
  ];
}

/** Every action name a section advertises, with its section. */
export function sectionActions() {
  const m = new Map<string, string>();
  for (const s of adminSections()) for (const a of s.actions) m.set(a.name, s.id);
  return m;
}
