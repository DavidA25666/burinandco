# Admin Plug — the Portfolio HQ site contract (v1)

Every store in the portfolio exposes the same six endpoints so Portfolio HQ can
monitor it and fix things from one place. The admin pulls `health`, `metrics`,
`alerts` and `orders` every 10 minutes (and on demand), stores snapshots, and
uses the store's own numbers instead of cost-sheet estimates. The three demo
stores implement this contract in-process (`src/lib/server/demo-ops.ts`), so the
dashboard behaves identically for real and demo sites.

| Method | Path                | Purpose                                           |
| ------ | ------------------- | ------------------------------------------------- |
| GET    | `/api/ops/health`   | Status of every dependency, jobs, storefront state |
| GET    | `/api/ops/metrics`  | Traffic, sales, costs, profit, recurring bookings  |
| GET    | `/api/ops/alerts`   | Open alerts the store knows about                  |
| GET    | `/api/ops/orders`   | Recent and stuck orders                            |
| POST   | `/api/ops/actions`  | Run one whitelisted action                         |
| GET    | `/api/ops/attribution` | Orders, new customers and profit per UTM (ads)  |
| GET    | each `admin_sections[].read_endpoint` | The store admin, run from HQ (§16)  |
| GET    | `/api/ops/vendors`  | Every paid service and its daily cost (§17)       |
| GET/POST | `/api/ops/campaigns` | Marketing campaigns: touches → orders, costs; set-up + mail actions (§18) |

Examples below come from the first store in the portfolio; field names and
units are what matter. Any store that implements them gets the same panels in
Portfolio HQ, and lists what it implements in `capabilities` (§15). New stores:
download the starter kit from the add-site wizard or a site's Features panel
(this file + one ready-to-run agent prompt for the whole contract).

All responses are JSON (`content-type: application/json`), money is in **USD
dollars** (numbers, not cents), timestamps are ISO-8601 UTC, dates are
`YYYY-MM-DD` in the store's reporting timezone (use America/New_York).

---

## 1. Authentication — HMAC-SHA256, 5-minute window

Each store has its own shared secret: a random string of at least 32
characters (Portfolio HQ generates 64 hex characters under **Business page →
Settings → Admin plug → Generate**, or 43 URL-safe characters in the add-site
wizard). Either way it is used **as-is, as a plain string** — never hex- or
base64-decoded. Store it on the
site as `PORTFOLIO_OPS_SECRET`. The admin stores it encrypted and never shows it
again.

Every request carries:

```
X-Portfolio-Timestamp:  <unix seconds>
X-Portfolio-Signature:  v1=<hex HMAC-SHA256(secret, canonical)>
X-Portfolio-Request-Id: <random id, unique per request>
```

where

```
canonical = "<timestamp>.<METHOD>.<path+query>.<raw body>"
```

- `<timestamp>` is the `X-Portfolio-Timestamp` value exactly as sent.
- `METHOD` is upper-case (`GET` / `POST`).
- `path+query` is exactly what was requested, e.g. `/api/ops/metrics?from=2026-09-10&to=2026-10-09`
  (path, then `?` and the query string as received; never the full URL, never re-ordered or decoded).
- `raw body` is the exact request body bytes before any JSON parsing — the
  **empty string for GET**, so a GET's canonical string ends with a dot:
  `1760000000.GET./api/ops/health.`
- The signature is lower-case hex, prefixed `v1=`.
- The **secret is used as a plain UTF-8 string**, exactly as stored in
  `PORTFOLIO_OPS_SECRET` (not hex- or base64-decoded first).
- **No redirects.** Portfolio HQ never follows a 3xx from `/api/ops/*`; serve
  these paths directly on the base URL the owner enters (no www ↔ apex,
  http → https, trailing-slash, locale or login redirects).

The store **must**:

1. Reject with `401` if either header is missing, the timestamp is more than
   **300 seconds** from its clock (either direction), or the signature doesn't
   match. Compare with a constant-time function.
2. For `POST /api/ops/actions`, remember `X-Portfolio-Request-Id` for 10 minutes
   and treat a repeat as a no-op that returns the first result (idempotency +
   replay protection).
3. Only serve these routes over HTTPS, never from a CDN cache
   (`cache-control: no-store`), and never expose them to browsers (no CORS).

Reference verifier (Node / Netlify Functions / TanStack Start):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export async function verifyOps(request: Request, secret = process.env.PORTFOLIO_OPS_SECRET, nowMs = Date.now()): Promise<{ ok: true; body: string } | { ok: false }> {
  const ts = request.headers.get('x-portfolio-timestamp')
  const sig = request.headers.get('x-portfolio-signature')
  if (!secret || !ts || !sig || !/^\d{9,11}$/.test(ts)) return { ok: false }
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > 300) return { ok: false }
  const url = new URL(request.url)
  const body = request.method === 'GET' ? '' : await request.text()
  const expected = 'v1=' + createHmac('sha256', secret).update(`${ts}.${request.method.toUpperCase()}.${url.pathname}${url.search}.${body}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig.trim())
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true, body } : { ok: false }
}
```

The store starter kit (add-site wizard or a site's Features panel) carries a
worked example — a test secret, a timestamp, the canonical string and the
resulting signature, produced by Portfolio HQ's own signer — to check a
verifier against before connecting. **Save & test** in Portfolio HQ names the
endpoint that failed and why (404, 401 with HQ's canonical string, refused
redirect, a JSON field it couldn't read).

---

## 2. `GET /api/ops/health`

```jsonc
{
  "site": "bethoughtful",
  "generatedAt": "2026-10-10T11:00:00Z",
  "status": "warn",                       // worst of checks: ok | warn | fail
  "checks": [
    { "id": "stripe", "category": "payments", "name": "Stripe", "status": "ok",
      "message": "Live mode, payouts enabled" },
    { "id": "stripe-webhook", "category": "webhooks", "name": "Stripe webhook", "status": "ok",
      "message": "Last event 2 min ago, 0 failures in 24h" },
    { "id": "handwrytten-card", "category": "fulfillment", "name": "Handwrytten card on file", "status": "warn",
      "message": "Visa ending 4242 expires 11/2026", "details": { "cardExpires": "2026-11", "balance": 84.5 } },
    { "id": "resend-domain", "category": "email", "name": "Resend domain", "status": "ok",
      "message": "mail.bethoughtfultoday.com verified (SPF, DKIM)" },
    { "id": "ai-gateway", "category": "ai", "name": "AI Gateway", "status": "ok", "message": "0 errors in 24h" }
  ],
  "jobs": [
    { "id": "send-due-letters", "name": "Send due letters to Handwrytten", "schedule": "Every 15 min",
      "lastRunAt": "2026-10-10T10:45:00Z", "lastStatus": "ok", "message": "12 letters submitted",
      "nextRunAt": "2026-10-10T11:00:00Z" }
  ],
  "storefront": {
    "maintenance": false,
    "headline": "Real handwritten letters and cards, mailed for you.",
    "products": [
      { "sku": "letter-standard", "name": "Handwritten letter", "price": 9.85, "unitCost": 4.25, "minPrice": 7.5 }
    ],
    "fees": { "percent": 0.029, "fixed": 0.30 }
  },
  "emailOutbox": { "queued": 0, "failed": 0 },
  "secretExpiresAt": null
}
```

Required categories to report when the store uses them: **payments**,
**fulfillment** (vendor account **including card on file expiry and/or prepaid
balance**), **email** (provider + **sending domain verification**), **jobs**
(every scheduled job's last run), **webhooks** (last event received, failures).
`status` per check: `ok`, `warn` (degraded / expiring soon), `fail` (broken now).

`products[].unitCost` is everything one order of that product costs the store
(fulfillment, postage, AI, packaging). `minPrice` is the store's **profit
floor**. Portfolio HQ previews profit per order as
`price − unitCost − (price × fees.percent + fees.fixed)`.

**Rates.** Send `fees.percent` as a fraction (`0.029`). Portfolio HQ also
accepts an explicit unit (`{ "percent": 2.9, "unit": "percent" }`,
`{ "bps": 290 }`, `"2.9%"`); without one, values above 1 are read as percent
(`2.9` → 2.9%). A fee above 20% is rejected as a contract warning, and
standard Stripe fees (2.9% + $0.30) are used until the store sends a sane
value. The same rules apply to `conversion`, margins, discounts and tax rates.

**Floor and break-even.** If `minPrice` is omitted, the floor is break-even:
`(unitCost + fees.fixed) / (1 − fees.percent)`, rounded up to the cent. A
price at or above break-even is never blocked for losing money. A store with
a pricing engine can add an optional `pricing` block (top level or in
`storefront`) with `targetProfit` (dollars per order), `targetMargin`,
`floorRule`, `fees`, and `products` (array with `sku`, or a map keyed by sku)
carrying `floor`, `breakEven` and `profitPerOrder`. When `profitPerOrder` is
present it is shown as the current profit, and the console warns if its own
math differs by more than $0.05.

## 3. `GET /api/ops/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`

Inclusive date range; the admin asks for the last 30 days and the last 365
days. Support at least 366 days.

```jsonc
{
  "site": "bethoughtful",
  "from": "2026-09-10", "to": "2026-10-09", "currency": "USD",
  "totals": {
    "visits": 4120, "orders": 162, "revenue": 1595.70, "refunds": 19.70,
    "fees": 93.30, "fulfillmentCost": 688.50, "aiCost": 11.20,
    "profit": 783.00,                    // revenue − refunds − fees − fulfillmentCost − aiCost
    "aov": 9.85, "conversion": 0.0393,   // orders / visits (null if no visit data)
    "newCustomers": 120, "returningCustomers": 42
  },
  "daily": [
    { "date": "2026-10-09", "visits": 140, "orders": 6, "revenue": 59.10, "refunds": 0,
      "fees": 3.51, "fulfillmentCost": 25.50, "aiCost": 0.40, "profit": 29.69 }
  ],
  "sources": [ { "source": "Google / organic", "visits": 1900, "orders": 70, "revenue": 689.50 } ],
  "products": [ { "name": "Handwritten letter", "units": 162, "revenue": 1595.70 } ],   // optional
  "funnel": [ { "stage": "Visitors", "count": 4120 }, { "stage": "Purchased", "count": 162 } ], // optional
  "recurring": {
    "activePlans": 58, "planLabel": "auto-letter plans",
    "booked": [
      { "days": 30,  "orders": 41,  "value": 403.85,  "profit": 197.20 },
      { "days": 90,  "orders": 118, "value": 1162.30, "profit": 567.40 },
      { "days": 365, "orders": 466, "value": 4590.10, "profit": 2241.00 }
    ]
  }
}
```

`daily` must contain one row per day in the range (zeros allowed). Sources come
from `ref` / UTM / referrer. `recurring.booked` = orders already scheduled to be
charged/sent within the next 30 / 90 / 365 days (for Be Thoughtful: letters on
auto-plans and pre-scheduled occasions) with their value and expected profit.
Fixed monthly costs (hosting, SaaS) stay on the admin's cost sheet and are
subtracted there; don't include them.

Optional extras Portfolio HQ reads from this response:

- **`daily[]` without cost lines.** If a day has `profit` but no `fees` /
  `fulfillmentCost` / `aiCost`, its variable costs are taken as
  `revenue − refunds − profit` and split like the period totals. snake_case
  keys and `*_cents` fields are accepted; a top-level `"money_unit": "cents"`
  marks every amount as cents.
- **`funnel[]` per flow.** Either the flat `[{ stage, count }]` above, or one
  entry per flow: `{ "flow": "studio", "label": "Letter studio", "steps":
  [{ "step": "landing", "sessions": 25 }, …, { "step": "paid", "sessions": 2 }] }`.
  The dashboard shows landing → paid per flow; the overall conversion is
  always paid orders ÷ visits (the same as the KPI).
- **`launch_date`** (or `first_paid_order_at`): the day fixed costs start.
- **`unit_economics`** — the store's own P&L for the requested range, in
  **integer cents**:

```jsonc
"unit_economics": {
  "orders": 6, "revenue": 3270, "stripe_fees": 276, "fulfillment_cost": 2898, "ai_cost": 90,
  "discounts": 0, "refunds": 0, "contribution": 6, "contribution_per_order": 1,
  "fixed_costs": [ { "name": "Netlify", "amount": 1900 }, { "name": "Resend", "amount": 2000 } ],  // monthly
  "marketing_spend": 0, "net_profit": -5594,
  "cost_source_coverage": 0.92,                  // share of costs that are actuals
  "sources": { "fulfillment_cost": "actual", "ai_cost": "estimated" },   // optional
  "launch_date": "2026-10-08"
}
```

Each line the store sends is shown as "actual" and wins over Portfolio HQ's
estimate; missing lines are estimated (payment fees from `fees`, fulfillment
from the store's per-order cost). Fixed costs are monthly and prorated from
the launch date.

### `customers` — distinct paying customers (recommended)

The one number for "customers" and "repeat rate" on the site page, Insights
cohorts, the briefing and Ask HQ. Count it yourself — HQ can't from `totals`
(`newCustomers` / `returningCustomers` there count orders, not people).

```json
"customers": { "window": "all_time", "customers": 5, "repeat_customers": 1, "repeat_rate": 0.2,
               "paid_orders": 16, "test_orders_excluded": true,
               "definition": "distinct buyer email with a paid order; one checkout = one order; repeat = 2+ paid orders" }
```

- customer = a distinct (lower-cased) buyer email with at least one paid order;
  a paid order = one checkout (not one item or one card); repeat = 2+ paid
  orders; test orders excluded; refunded / unpaid carts don't count.
- Windows may be nested (`{ "all_time": {…}, "last_30_days": {…} }`); HQ shows
  the all-time one. HQ derives the rate from the counts.
- Without this block HQ counts customers from the order list (by email), and
  only as a last resort shows the 30-day totals, labeled as an estimate.

### `geo` — where orders come from (optional)

Aggregated, test orders excluded, ≈1 km precision (2 decimals). `buyers` is
where the order was placed (e.g. Netlify geo), `recipients` where it was
mailed (from the ZIP / postal code). Money follows `money_unit` (or a
`revenue_cents` key).

```json
"geo": {
  "version": 1, "money_unit": "cents",
  "buyers":     [{ "city": "Brooklyn", "region": "NY", "country": "US", "lat": 40.68, "lng": -73.94, "orders": 3, "revenue_cents": 2190 }],
  "recipients": [{ "city": "Austin", "region": "TX", "country": "US", "lat": 30.27, "lng": -97.74, "orders": 1, "revenue_cents": 545 }],
  "top_states": [{ "region": "NY", "country": "US", "orders": 3, "revenue_cents": 2190, "kind": "buyers" }],
  "top_cities": { "buyers": [{ "city": "Brooklyn", "region": "NY", "orders": 3 }], "recipients": [] },
  "coverage": { "orders": 6, "with_buyer": 3, "with_recipient": 1 }
}
```

`top_states` / `top_cities` must be **per mode**: split `{ buyers, recipients }`,
or one list whose rows are tagged `kind`. An untagged single list is ambiguous
(a city with 1 buyer and 1 recipient would count 2) and is ignored: Portfolio HQ
always counts the top lists, the dots and "N of M located" from the same points
per mode. Rows a per-mode list counts beyond the points (a place the store knows
but couldn't geocode) are still mapped, approximately.

Every row in `buyers` / `recipients` should carry `lat` / `lng`. A row with only
`city` / `region` is placed at a centroid and marked "approx." on the map: the
same place in the other list, then a US city / county centre (Census Gazetteer,
bundled), then the state centre. Rows with neither are counted as not mappable.
Orders with no buyer location at all simply aren't in `buyers` (that's what
`coverage.with_buyer` reports).
Portfolio HQ reads 30 days and 1 year from its regular pulls and asks for 7 and
90 days (`/api/ops/metrics?from&to`) when an owner picks those periods.

### 3b. Analytics blocks — `demand`, `cohorts`, `attribution`, `plans`, `goals`, `cash` (optional)

Each block sits at the top level of the metrics response, declares its units
(`"money_unit": "cents"`, `"percent_unit": "fraction"`) and excludes test
orders. Portfolio HQ reads them into the **Insights** tab of a store's page and
the portfolio rollup (`/insights`, live stores only), and puts one line from
each in the 7:00 ET briefing. A missing block is shown as "not reported"; a
block that isn't an object is a contract warning (`metrics.<block>`). Shapes as
Be Thoughtful sends them (abridged):

```json
"demand": {
  "today": "2026-10-10", "conversion_window_days": 14,
  "windows": [{ "days": 30, "dates": 40, "saved_dates": 32, "auto_letters": 8, "accounts": 25,
                "forecast": { "orders": 4.2, "orders_low": 2, "orders_high": 7, "revenue_cents": 2289, "revenue_low_cents": 1090, "revenue_high_cents": 3815 } }],
  "by_occasion": [{ "occasion": "birthday", "label": "Birthday", "dates": 25, "forecast": { "orders": 2, "revenue_cents": 1090 } }],
  "by_week": [{ "week_start": "2026-10-12", "dates": 9, "by_occasion": { "birthday": 6 }, "expected_orders": 1, "expected_revenue_cents": 545 }],
  "conversion": { "reminders": { "reminders": 0, "orders": 0, "observed": null, "rate": 0.08, "low": 0.0175, "high": 0.1425, "basis": "prior" } },
  "forecast_basis": "prior", "forecast_label": "Estimate: too few reminders yet …"
},
"cohorts": {
  "overall": { "customers": 3, "orders": 6, "repeat_customers": 1, "repeat_rate": 0.3333, "median_days_to_second_order": 1,
               "revenue_per_customer_cents": 1637, "contribution_per_customer_cents": 386,
               "retention": { "d30": { "eligible": 0, "ordered_again": 0, "rate": null }, "d60": {}, "d90": {}, "d180": {}, "d365": {} },
               "ltv": { "d90": { "eligible": 0, "avg_orders": null, "avg_revenue_cents": null, "avg_contribution_cents": null }, "d365": {} } },
  "months": [{ "month": "2026-10", "…": "same fields" }],
  "by_channel": [{ "channel": "direct", "…": "same fields" }],
  "by_product": [{ "product": "santa", "label": "Letters from Santa", "…": "same fields" }]
},
"attribution": {
  "from": "2026-09-11", "to": "2026-10-10", "window_days": 90, "ltv_basis": { "direct": "to-date" },
  "first_touch": { "totals": {}, "channels": [{ "channel": "direct", "label": "Direct", "visits": 49, "orders": 6, "new_customers": 3, "returning_customers": 3,
                   "revenue_cents": 4911, "contribution_cents": 1159, "ad_spend_cents": 0, "cost_per_new_customer_cents": null, "ltv_cents": 386, "ltv_to_cac": null }],
                   "campaigns": [{ "channel": "direct", "source": "", "medium": "", "campaign": "", "…": "same fields" }] },
  "last_touch": { "…": "same as first_touch" }
},
"plans": {
  "current_plan": "retail",
  "volume": { "trailing_30_days": { "cards": 4, "letters": 2, "items": 6 }, "prior_30_days": {}, "trailing_90_days": { "per_month": 2 }, "projected_month": { "items": 6, "growth": 1, "method": "last-30-days" } },
  "plans": [{ "id": "pro", "label": "Pro", "monthly_fee_cents": 44900, "card_cents": 199, "letter_cents": 399, "item_cost_cents": { "card": 295, "letter": 509 },
              "cost_at_current_cents": 47098, "cost_at_projected_cents": 47098, "break_even_items_per_month": 239, "is_current": false }],
  "recommendation": { "action": "switch_at", "plan": "pro", "at_items_per_month": 239, "saving_per_month_cents": 0, "message": "Stay on Retail … Switch to Pro at 239 items a month …" }
},
"goals": {
  "items":  { "goal_per_month": 5000, "trailing_30_days": 6, "progress": 0.0012, "this_month_so_far": 6, "this_month_run_rate": 19, "run_rate_progress": 0.0038 },
  "profit": { "this_month_so_far_cents": 1118, "this_month_run_rate_cents": 3466, "target_cents": 0, "cap_cents": 1000000, "progress_to_cap": 0.0035, "status": "below_target" }
},
"cash": {
  "configured": true, "status": "partial", "checked_at": "…",
  "missing_permissions": ["Balance: Read", "Payouts: Read", "Refunds: Read", "Disputes: Read"],
  "balance":  { "available_cents": 12345, "pending_cents": 2000 },
  "payouts":  { "upcoming": [{ "id": "po_…", "amount_cents": 5000, "arrival_date": "2026-10-14", "status": "in_transit" }], "recent": [] },
  "refunds":  { "days": 30, "count": 2, "amount_cents": 1090 },
  "disputes": { "open": 0, "amount_cents": 0, "needs_response": 0 },
  "errors":   { "balance": "The Stripe key is missing the “Balance: Read” permission." }
}
```

Also accepted: camelCase keys, Stripe-style amount lists (`"available": [{ "amount": 12345, "currency": "usd" }]`),
a flat `payouts` / `disputes` list split by `status`, retention as a list of
`{ days, eligible, ordered_again }`, and `percent_unit: "percent"`. When the
store can't read part of Stripe, it sends `null` for that part plus
`missing_permissions`; Portfolio HQ names the missing permission instead of
showing zeros. The goal status is recomputed from the run rate vs target/cap
when both are present.

Bank cash is not part of the contract: Portfolio HQ reads Mercury itself when
`MERCURY_API_TOKEN` (shared) or `<SLUG>_MERCURY_API_TOKEN` (one store) is set
to a read-only token. Runway = (Stripe available + pending + bank available) ÷
average monthly net burn from the shared P&L (up to 90 days, from launch).

### 3c. Analytics pack 2 — `fulfillment`, `feedback`, `mix`, `seo`, `experiments` (optional)

Same rules as §3b: top-level blocks in the metrics response, units declared,
test orders excluded. Durations may be sent as `<key>_hours`, `<key>_minutes`
or `<key>_days` (Portfolio HQ works in hours). They show on the Insights tab
and the rollup, and feed the briefing's **Signals**: late fulfillment (needs a
human; critical at ≥ 3 late or ≥ 48 h late), a rating drop (≥ 0.3★ or ≥ 15
score points on ≥ 5 ratings, vs `previous` or the last two trend weeks), a
≥ 5-point week-over-week change in AI-answer mention rate, and an experiment
whose challenger reaches `win_threshold`. Verbatims are shown to owners in the
app only (never emailed); emails typed by customers are masked.

```json
"fulfillment": {
  "orders": 6, "promise": { "days": 2, "business_days": true, "label": "Mailed within 2 business days" },
  "turnaround": [{ "stage": "paid_to_submitted", "n": 6, "median_minutes": 12, "p90_minutes": 55 },
                 { "stage": "submitted_to_written", "n": 5, "median_hours": 20.5, "p90_hours": 30 },
                 { "stage": "written_to_mailed", "n": 5, "median_hours": 6, "p90_hours": 14 },
                 { "stage": "paid_to_mailed", "n": 5, "median_hours": 27, "p90_hours": 52 },
                 { "stage": "mailed_to_delivered", "n": 3, "median_days": 3, "p90_days": 5 }],
  "on_time": { "eligible": 5, "on_time": 4 },
  "late": { "count": 1, "oldest_hours": 9, "orders": [{ "id": "ord_6", "number": "6", "stage": "submitted_to_written", "late_hours": 9 }] },
  "trend": [{ "week_start": "2026-10-05", "orders": 4, "median_hours": 30, "p90_hours": 50, "on_time_rate": 0.75 }],
  "by_state": [{ "state": "NY", "orders": 2, "median_days": 2.5, "p90_days": 3, "on_time_rate": 1 }],
  "problems": { "orders": 1, "problem_rate": 0.1667, "reprint_rate": 0, "refund_rate": 0,
                "by_reason": [{ "reason": "address_undeliverable", "kind": "problem", "count": 1, "rate": 0.1667 }] }
},
"feedback": {
  "requests": 4, "distribution": { "5": 2, "4": 1, "3": 0, "2": 0, "1": 0 },
  "previous": { "avg_rating": 5, "score": 100, "responses": 2 },
  "trend": [{ "week_start": "2026-10-05", "responses": 3, "avg_rating": 4.67, "score": 67 }],
  "comments": [{ "id": "r1", "rating": 5, "text": "Loved it!", "at": "…", "product": "Thinking of you" }],
  "refund_reasons": [{ "reason": "arrived_late", "count": 1, "amount_cents": 545 }],
  "top_questions": [{ "category": "where_is_my_order", "label": "Where is my order?", "count": 3 }]
},
"mix": {
  "orders": 6, "items": 6,
  "by_product": [{ "key": "thinking_of_you_card", "label": "Thinking of you · Folded card", "orders": 4, "items": 4, "revenue_cents": 2180, "contribution_cents": 4 }],
  "by_occasion": [], "by_format": { "card": { "orders": 4 }, "letter": { "orders": 2 } }, "by_design_source": [], "by_add_on": [],
  "redesign": { "orders": 1, "uses": 2 }, "rewrite": { "orders": 3, "uses": 5 },
  "ai_cost": { "per_order_cents": 15, "total_cents": 90 },
  "items_per_checkout": { "avg": 1, "median": 1 }, "batch_sizes": [{ "bucket": "1", "checkouts": 6, "items": 6 }]
},
"seo": {
  "search_console": { "configured": true, "property": "sc-domain:example.com", "from": "…", "to": "…",
                      "totals": { "clicks": 12, "impressions": 600, "ctr": 0.02, "position": 18.2 }, "previous": {},
                      "queries": [{ "query": "handwritten card service", "clicks": 5, "impressions": 100, "ctr": 0.05, "position": 9 }],
                      "pages": [{ "page": "https://example.com/", "clicks": 9, "impressions": 400 }] },
  "ai_visibility": { "engines": ["ChatGPT", "Perplexity"], "weeks": [{ "week_start": "2026-10-05", "prompts": 20, "mentions": 3, "by_engine": { "ChatGPT": 2 } }] }
},
"experiments": { "win_threshold": 0.95, "experiments": [ "… same items as GET /api/ops/experiments (§10)" ] }
```

When Search Console isn't connected, send `"search_console": { "configured": false, "message": "…" }`;
Portfolio HQ shows a "connect Search Console" hint. Rates are recomputed from
counts when a rate is missing; rollups add counts and order-weight medians.

## 4. `GET /api/ops/alerts`

```json
{ "alerts": [
  { "id": "handwrytten-card-expiring", "severity": "warning", "source": "Handwrytten",
    "title": "Card on file expires in 21 days", "detail": "Update it in Handwrytten → Billing.",
    "createdAt": "2026-10-09T14:00:00Z" }
] }
```

Return only **open** alerts. Keep `id` stable for the same problem: the admin
opens an alert when an id appears and auto-resolves it when the id disappears.
`severity`: `critical` (money or orders are failing now — owners are emailed
and pushed immediately), `warning`, `info`.

## 5. `GET /api/ops/orders?status=attention,scheduled,…`

`status` is a comma list of `scheduled | pending | processing | stuck | failed |
fulfilled | shipped | delivered | refunded`; `attention` means `stuck,failed`.
Without `status`, return the most recent 50. Always include every stuck/failed
order, newest first.

```json
{ "orders": [
  { "id": "BT-10482", "customer": "Maya R.", "item": "Birthday letter", "amount": 9.85,
    "status": "stuck", "issue": "Handwrytten rejected: card declined",
    "createdAt": "2026-10-09T15:12:00Z", "updatedAt": "2026-10-09T15:20:00Z",
    "scheduledFor": null, "actions": ["retry_order", "refund_order"] }
] }
```

`actions` lists which order actions the store will accept right now. Use
initials or first name + last initial for customers — no emails or addresses.

Portfolio HQ calls this endpoint as `/api/ops/orders?limit=100` (no status
filter) and follows pagination: `nextCursor` / `next_cursor` (sent back as
`cursor` and `starting_after`), `hasMore` + the last id, or `page` / `pages`.
The list may be under `orders`, `data`, `items` or `results`. Amounts may be
dollars or integer cents (`amount_cents`, `total_cents`); timestamps may be
ISO strings or unix seconds (`created`).

**Times and status.** Portfolio HQ shows each order at its own `paidAt`
(else `createdAt`) — never `updatedAt`, which many stores stamp when the
response is built. The store's own status word (`orderStatus` / `status`,
e.g. `submitted`, `mailed`) is shown as-is and mapped to the statuses above
only for sorting and attention. `item` (or `product` with `occasion` +
`format`) names the product; `topProducts[].product` names a metrics row.

**Test orders.** Send `"is_test": true` (or `livemode: false`) on orders the
owners placed themselves. They are left out of revenue, orders, customers,
repeat rate and profit everywhere unless an owner turns on "Show test orders"
for the site. Owners can also list their own customer emails in site
settings; an optional `email` / `customerId` on an order is used only for that
match and for counting customers.

**Per-order economics (optional).** An order may carry the store's own numbers
for that order — top level or in `economics` / `costs`: `fees` (payment fees),
`fulfillment` (or `unit_cost`), `ai`, `discount`, `refunds`, `profit`; dollars
or `*_cents`. Ask HQ uses them for "why did order N lose money?"; without them
it estimates from the product's unit cost and the payment fees and says so.

## 6. `POST /api/ops/actions`

Body: `{ "action": "<name>", "params": { … } }`. Unknown actions → `400
{ "ok": false, "code": "unknown_action" }` and nothing changes. **Save & test**
posts `{ "action": "hq_signature_check", "params": {} }` to check POST
signing: answer it like any unknown action (400) — or 200 — after verifying
the signature. Action names are exactly the ones below (pausing is
`pause_site` / `resume_site`). Every response:

```json
{ "ok": true, "message": "Order BT-10482 resubmitted to Handwrytten", "code": null, "data": {} }
```

| action                     | params                                   | store must…                                                                                              |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `retry_order`              | `{ orderId }`                            | re-run fulfillment for a stuck/failed order; `409 not_allowed` otherwise                                  |
| `refund_order`             | `{ orderId, amount?, reason }`           | refund in full (or `amount`) through the payment provider and cancel fulfillment if not yet sent          |
| `rerun_job`                | `{ jobId }`                              | run that scheduled job now                                                                                |
| `pause_site`               | `{ reason? }`                            | maintenance mode: close checkout, show a maintenance page; scheduled sends keep running unless unsafe     |
| `resume_site`              | `{}`                                     | leave maintenance mode                                                                                    |
| `set_price`                | `{ sku, price }`                         | **enforce its own profit floor**: reject with `422 below_profit_floor` if `price < minPrice` or profit ≤ 0 |
| `flush_email_outbox`       | `{}`                                     | retry all queued/failed emails now and report how many went out                                           |
| `update_homepage_headline` | `{ headline }` (3–140 chars, plain text) | update the hero headline (escape it; no HTML)                                                             |

Error codes: `invalid_params` (400), `order_not_found` / `job_not_found` /
`sku_not_found` (404), `not_allowed` (409), `below_profit_floor` (422).
Actions must be idempotent per `X-Portfolio-Request-Id`. Log each one on the
store side too.

Portfolio HQ itself validates the whitelist and parameters, checks the price
floor before sending, asks the owner to confirm money-moving actions (refund,
price, pause, deploys), and writes every attempt — succeeded, blocked or
failed — to its audit log with who/what/when/result.

Redeploy and rollback are **not** part of this contract: the admin does them
through the Netlify API (`NETLIFY_API_TOKEN` + the store's Netlify site id).

## 7. `GET /api/ops/attribution?from=YYYY-MM-DD&to=YYYY-MM-DD`

The store's **own** numbers per traffic source, so the Ads control center can
judge every campaign on real new customers and real profit instead of what the
ad platforms claim. Inclusive range in the reporting timezone; the admin asks
for single days, the last 7 days, month-to-date and arbitrary ranges up to 400
days. One row per distinct `(utm_source, utm_campaign, utm_content)` that had at
least one order in the range.

```jsonc
{
  "site": "bethoughtful",
  "from": "2026-10-01", "to": "2026-10-09", "currency": "USD",
  "model": "last-click (first landing UTM kept 30 days)",   // optional, shown in the admin
  "rows": [
    { "utmSource": "facebook", "utmMedium": "paid_social",
      "utmCampaign": "120211234567890", "utmContent": "120211234567999",
      "orders": 31, "newCustomers": 24, "cards": 52,
      "revenue": 412.30,          // net of refunds
      "profit": 188.40,           // revenue − refunds − fees − fulfillment − AI; BEFORE ad spend
      "avgCards": 1.68,           // cards / orders
      "repeatOrders": 7 },        // orders from customers who had ordered before
    { "utmSource": "(direct)", "utmMedium": null, "utmCampaign": null, "utmContent": null,
      "orders": 40, "newCustomers": 18, "cards": 61, "revenue": 395.00, "profit": 201.10,
      "avgCards": 1.53, "repeatOrders": 22 }
  ]
}
```

- **cards** = physical items in the order (cards/letters for Be Thoughtful,
  prints, books…). `avgCards = cards / orders` (0 when no orders).
- **newCustomers** = orders that were the customer's first ever order, so
  `orders = newCustomers + repeatOrders`.
- Capture `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` on the
  first landing, keep them (cookie/localStorage, 30 days) and store them on the
  order. Orders without UTMs go in a `(direct)` row.
- Lower-case `utmSource`. The admin maps `facebook`, `fb`, `instagram`, `ig`,
  `meta` → Meta; `google`, `adwords`, `youtube` → Google; `pinterest` → Pinterest.

**Recommended ad URL parameters** (the admin matches `utm_campaign` to the
campaign **id** first, then to the owner-set "UTM campaign" value, then to the
campaign name; `utm_content` to the ad set / ad group id or name):

| Platform  | URL parameters |
| --------- | -------------- |
| Meta      | `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{adset.id}}` |
| Google    | `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}` (tracking template / final URL suffix) |
| Pinterest | `utm_source=pinterest&utm_medium=paid_social&utm_campaign={campaignid}&utm_content={adgroupid}` |

The admin computes, per campaign: cost per new customer = spend ÷ newCustomers,
true ROI = (profit − spend) ÷ spend, and average cards per order. Conversions
reported by the ad platforms are shown next to these, clearly labelled, and are
never used by the rules engine.

---

## 7b. `GET /api/ops/inbox` and `POST /api/ops/inbox`

The store's automated inbox: customers waiting on a reply (with an AI-drafted
answer), notices that need a human, and invoices processed or failed. Signed
like every other endpoint; demo stores have none. A 404 means "no inbox yet".

```json
{ "contractVersion": 2,
  "counts": { "needs_reply": 1, "drafts": 1, "urgent": 0, "notices_action": 1, "invoice_failures": 1 },
  "conversations": [
    { "id": "c_81", "customer": "Maya R.", "email": "maya@example.com", "subject": "Where is my card?",
      "category": "where_is_my_order", "urgency": "high", "last_message": "Hi! I ordered on the 3rd…",
      "received_at": "2026-10-10T13:02:00Z", "order": { "id": "42", "item": "Thinking of you · Folded card" },
      "draft": { "id": "d_81", "body": "Hi Maya — your card was mailed on…" },
      "actions": ["send", "edit", "mark_done"] }
  ],
  "drafts": [],
  "notices": [
    { "id": "n_7", "kind": "notice", "source": "Handwrytten", "title": "Card on file declined", "status": "needs_action", "urgency": "urgent" },
    { "id": "inv_3", "kind": "invoice", "source": "Handwrytten", "title": "Invoice #1182", "status": "failed", "amount_cents": 4830, "error": "PDF unreadable" }
  ] }
```

Drafts may be inline (`draft`) or a separate `drafts[]` keyed by
`conversation_id`. Invoices may also come as `invoices[]`. Items marked
`done` / `resolved` are hidden. The lists win over `counts` when both exist.

`POST /api/ops/inbox` — one action as `{ "action": "…", "params": { … } }`.
This is what Be Thoughtful's live store accepts (checked with requests it had
to refuse, so nothing was sent). Ids are integers; numeric strings are
accepted too:

| action           | required params                                   | notes |
|------------------|---------------------------------------------------|-------|
| `send`           | `message_id` (the **draft's** id, from `drafts[].message_id`) | optional `text` (1–20,000 chars) sends an edited reply |
| `approve`        | `message_id`                                      | |
| `edit`           | `message_id`, `text`                              | saves the draft; doesn't send |
| `mark_done`      | `conversation_id`                                 | |
| `reopen`         | `conversation_id`                                 | "Undo" after Mark done |
| `notice_done`    | `email_id`                                        | notices; HQ's "Done" on a notice |
| `set_auto_reply` | `on` (`true` / `false`)                           | |

Portfolio HQ also sends `conversation_id` with draft actions and `sent_by`
(the owner) in `params` and at the top level. Answers: `{ "ok": true,
"message": "Reply sent" }`, or `{ "ok": false, "code": "invalid_params" |
"unknown_action" | "not_done", "message": "…" }` (400 / 409). There is no
dry-run mode: a complete `send` emails the customer. Portfolio HQ writes one
audit entry per attempt with the owner's name, and shows owners a plain-English
message instead of the store's `params.x is required`. Stores without the POST
route (404 / 405) get the same request through `/api/ops/actions` as
`inbox_<action>`.

## 8. Connection status in the admin

- **Connected** — the last pull of every endpoint succeeded.
- **Failing** — the most recent pull got an error (shown with the reason).
- **Secret expiring** — `secretExpiresAt` is within 14 days, or the secret is
  older than ~1 year. Rotate: generate a new one in the admin, set it on the
  store, save.

## 9. Checklist for a store implementing v1

1. Add `PORTFOLIO_OPS_SECRET` to the store's environment.
2. Add the six routes behind `verifyOps()`; respond `no-store`.
3. Report payments, fulfillment (card/balance), email domain, jobs, webhooks in `/health`.
4. Report daily metrics and recurring bookings in `/metrics`.
5. Enforce the profit floor inside `set_price`.
6. Store UTMs on every order and serve `/attribution`; add the URL parameters above to every ad.
7. In Portfolio HQ: Business page → Settings → Admin plug → base URL + secret → **Save & test**.

## 10. `GET /api/ops/experiments` and `POST /api/ops/experiments`

GET returns `{ "money_unit": "cents", "win_threshold": 0.95, "kinds": ["price","copy","design"], "experiments": [ … ] }`
(pulled with every 10-minute pull; a 404 means "use metrics.experiments"):

```json
{ "id": "exp_headline", "name": "Homepage headline", "kind": "copy", "status": "running", "sku": null,
  "started_at": "…", "ended_at": null, "winner": null, "actions": ["stop", "ship"],
  "variants": [{ "id": "control", "label": "Control", "is_control": true, "visitors": 400, "conversions": 8, "revenue_cents": 4360 },
               { "id": "b", "label": "Warmer", "copy": "…", "price_cents": null, "visitors": 410, "conversions": 15,
                 "revenue_cents": 8175, "probability_to_beat": 0.97, "lift": 0.82 }] }
```

POST (signed) bodies, each with `actor` (the owner's name):

- `{ "action": "create", "name", "kind": "price|copy|design|offer", "sku"?, "hypothesis"?, "traffic_percent", "variants": [{ "label", "is_control", "price_cents"? , "copy"? }] }`
- `{ "action": "stop", "id" }`
- `{ "action": "ship", "id", "variant_id" }` — for a price test this sets the price.

Answer `{ ok, message, code? }`. Portfolio HQ refuses any price below the
product's `minPrice` or below break-even after fees before sending, and writes
one audit entry per attempt (`experiment_create|stop|ship`). The store must
enforce its own floor too (`422 below_profit_floor`). Stores without the POST
route get the same request through `/api/ops/actions` as `experiment_<action>`.

## 11. `GET /api/ops/live` — "live now" (cheap; polled every 30 s while an owner is looking)

```json
{ "as_of": "…", "money_unit": "cents", "visitors_5m": 4, "active_checkouts": 1, "orders_today": 2, "revenue_today_cents": 1090,
  "events": [{ "at": "…", "type": "order|checkout|cart|visit", "label": "Order paid · Thinking of you", "region": "NY" }] }
```

Anonymized: no names, emails, addresses or order ids in `label`. Portfolio HQ
strips anything that looks like an email, phone number or ZIP anyway, doesn't
store the answer, pauses while the tab is hidden and backs off (60 s → 5 min)
when the store errors. Keep it fast (cache a few seconds on the store side).

## 12. `GET /api/ops/reports?month=YYYY-MM` — monthly owners' report

Stores serve it as `/api/ops/reports` (without `?month`: `{ "reports": [ … ] }`,
one entry per built month). Portfolio HQ asks `/api/ops/reports?month=` first and
falls back to the original `/api/ops/report?month=`. A JSON `404`
("No report for that month yet") means the endpoint exists; the capability name
is `reports` (or `report` / `monthly_report`).

Built by the store on the 2nd for the previous month; Portfolio HQ asks for it
when it emails the owners' report (13:07 UTC on the 2nd) and caches it 6 hours.
`404` / `{ "ready": false }` is fine: the report then uses Portfolio HQ's own P&L.

```json
{ "month": "2026-10", "money_unit": "cents", "generated_at": "…",
  "summary": { "revenue_cents": 4914, "orders": 6, "refunds_cents": 0, "fees_cents": 276, "fulfillment_cents": 2898, "net_cents": -5300 },
  "sales_by_state": [{ "state": "NY", "orders": 2, "revenue_cents": 1090, "tax_cents": 0, "shipping_cents": 0 }],
  "quickbooks": { "lines": [{ "date": "2026-10-31", "account": "Sales", "description": "Card sales", "amount_cents": 4914 }] } }
```

QuickBooks lines are signed (income positive, expenses negative); when sent they
replace the journal lines Portfolio HQ derives from its P&L in the CPA CSV
(`/api/export/owners-report?month=…&format=csv`, one balanced entry per store).

## 13. `business{}` in `/api/ops/metrics` — business automation (optional)

Triggered sends (business API, Zapier / webhooks, Follow Up Boss, BoldTrail,
donor imports, CRM anniversaries) and the queues behind them. Counts are
current (queues) or for `from`–`to` (sends); money follows `money_unit`.

```json
"business": {
  "version": 1, "money_unit": "cents", "from": "2026-10-01", "to": "2026-10-10",
  "sends": { "by_source": [
    { "source": "api",            "by_status": { "mailed": 4, "submitted": 1, "awaiting_approval": 1 } },
    { "source": "zapier_webhook", "by_status": { "awaiting_approval": 2, "failed": 1 } },
    { "source": "follow_up_boss", "by_status": { "held_spend_cap": 1, "scheduled": 2 } },
    { "source": "boldtrail",      "by_status": { "awaiting_payment": 2 } },
    { "source": "donor_import",   "by_status": { "mailed": 30, "held_billing": 1 } } ] },
  "approvals":      { "waiting": 3, "amount_cents": 1635, "oldest_at": "…" },
  "held":           { "spend_cap": 1, "billing": 1 },
  "checkout_links": { "outstanding": 1, "cards": 2, "amount_cents": 1090 },
  "accounts":       { "business_active": 4, "nonprofit_active": 1 },
  "donor_imports":  { "month": "2026-10", "this_month": 2, "donors": 31, "cards": 31 }
}
```

Statuses are grouped as: waiting for approval, waiting for payment, held (spend
cap), held (billing), queued, sent (submitted / written / mailed / delivered),
failed, canceled; unknown words are matched loosely. `sends` may also be flat
rows `[{ source, status, count }]` or a map keyed by source. Without
`approvals` / `held` / `checkout_links`, those counts come from the statuses.

Portfolio HQ shows a Business automation panel on the store page and puts
"N business cards waiting for approval/payment" (approvals + Checkout-link
cards) under "Needs a human" in the briefing when it's above 0.

A health check whose id/name mentions *saved card* is read as the saved-card
billing status. A check with status `info` / `off` / `disabled`, or `unknown`
with a message starting "Off." / containing "turns on when", is an **info item**:
shown, never alerted (Be Thoughtful's "Saved-card billing turns on when Stripe
is upgraded"). A "missing: Customers: Write, …" list in its message is shown as
the Stripe permissions to add.

Search Console (§3c `seo.search_console`): `configured: true` with no totals /
rows shows "Connected · data usually appears within a few days" instead of the
setup hint.


---

## 14. Itemized pricing — `GET` / `POST /api/ops/pricing`

What stores ship (contract v5; capability `price_matrix`). Portfolio HQ pulls it
with every 10-minute store pull and re-reads it after each change.

`GET /api/ops/pricing` (signed):

```json
{ "contractVersion": 5, "version": 2, "money_unit": "cents",
  "tiers": [ { "id": "single", "label": "1–9", "minItems": 1 }, { "id": "ten", "label": "10–24", "minItems": 10 }, { "id": "bulk", "label": "25+", "minItems": 25 } ],
  "cells": { "base": { "card": { "single": { "cents": 570, "source": "tier", "floorCents": 555, "breakEvenCents": 555,
                                             "marginCents": 15.22, "aiCents": 25, "overrideCents": 569, "schedule": null, "raisedToFloor": false } } },
             "<line>": { "card": { … }, "letter": { … } } },
  "schedules": [ { "id": "…", "line": "<line>", "product": "card", "tier": "bulk", "cents": 1000, "startsOn": "2027-09-01", "endsOn": "2027-09-02" } ],
  "aiBudget": null }
```

Line `base` is the product's own row. `overrideCents` is the owner's own price
(the store raises it to the floor when it's below: `raisedToFloor`).

`POST /api/ops/pricing` (signed, `X-Portfolio-Request-Id` required), one cell:

```json
{ "op": "set", "product": "card", "line": "base", "tier": "single", "cents": 600, "startsOn": "2026-11-15", "endsOn": "2026-12-24", "sent_by": "Justin" }
{ "op": "clear", "product": "card", "line": "base", "tier": "single", "sent_by": "Justin" }
{ "op": "clear", "product": "card", "line": "<line>", "tier": "bulk", "startsOn": "2027-09-01", "endsOn": "2027-09-02" }
```

Dates are New York days, both included, both or neither. `clear` without dates
clears the own price; with dates it cancels that schedule. Snake or camel case,
`cents` or `price` (dollars). Refusals: `422 below_floor` (names the lowest
allowed price), `422 invalid_dates`, `400 invalid_params`, `404 not_found`.
Success: `{ ok, message, data: { version, cell, schedules } }`, version bumped.
`set_price` on `/api/ops/actions` still sets the base single-tier cell.

### 14b. Add-on prices — `addOns` in `GET /api/ops/pricing` (optional)

Extras sold on top of an item, each with its own price, cost and floor (Be
Thoughtful: one voice and one video message per character, plus the
customer's own recording). Capability `addon_prices`. Portfolio HQ shows an
**Add-ons** section in the site's price editor for whatever items the store
returns: a new character's items appear with no HQ change. Items with a
`character` are grouped under **Character messages** (one row per character,
voice and video); items without one whose id starts with `own-` under **Your
own recording**; anything else under **Other add-ons**.

```json
"addOns": {
  "date": "2026-10-11",
  "stripe": { "rate": 0.029, "fixedCents": 30, "fixedNote": "Stripe’s fixed fee is carried by the letter’s own checkout, not the add-on." },
  "items": [
    { "id": "santa-video", "label": "Santa’s video message", "kind": "video", "character": "santa", "unit": "per letter (8 s video)",
      "costLines": [ { "label": "Veo $0.10/s × 8 s × 1.5", "cents": 120, "ai": true }, { "label": "Storage and QR hosting", "cents": 8, "ai": true } ],
      "costCents": 128, "aiCents": 128, "defaultCents": 195, "cents": 195, "source": "default",
      "floorCents": 135, "marginCents": 61.34, "overrideCents": null, "schedule": null, "raisedToFloor": false, "stripeCents": 5.66 },
    { "id": "own-voice", "label": "Your own voice message (record or upload)", "kind": "voice", "character": null, "unit": "per card",
      "costCents": 4, "aiCents": 3, "defaultCents": 5, "cents": 5, "source": "default", "floorCents": 5, "marginCents": 0.85 }
  ],
  "schedules": [ { "id": "ao_1", "item": "santa-video", "cents": 249, "startsOn": "2026-11-15", "endsOn": "2026-12-24", "created_by": "Justin" } ]
}
```

- **Per item:** `id` (`[A-Za-z0-9_.:-]`, stable), `label`, `kind` (`voice`,
  `video`, …), `character` (id, or `null`), `cents` = the price today,
  `defaultCents`, `source` = `default` | `override` | `seasonal`,
  `costCents` = the real unit cost (with `costLines[]` when known),
  `floorCents` = the lowest price the store accepts (break-even after its
  costs and Stripe), `marginCents` = profit per add-on at today's price,
  `overrideCents` = the owner's own price, `schedule` = the seasonal price in
  force (`{ id, cents, startsOn, endsOn }`). Fractional cents are fine.
- **Margin** is price − cost − Stripe's `rate` (the fixed fee only when
  `stripe.fixedApplies: true`). HQ colours it green, amber (under 20% of the
  price) or red (losing money or under the floor).
- **Every priced extra goes here** (owner rule: every price is editable in
  HQ). Anything the store charges on top of an item — character messages, the
  customer's own recording, AI art extras (`kind: "design"`: extra redesign,
  paint with my photo), extra rewrites, own cover, postage — must be an item.
  A price the store doesn't let anyone change (e.g. postage passed through at
  cost) is sent with `"passThrough": true` (or `"editable": false`): HQ shows
  it for reference with a PASS-THROUGH badge, without an editor, and refuses
  changes to it. A price that lives only in an admin read (e.g. a flat
  `addOns: { extraRewrite: 5 }` map) is not editable from HQ.
- **Badge**: HQ shows DEFAULT, CUSTOM (`source: "override"` or an
  `overrideCents`), or SEASONAL on each card, and switches it as soon as the
  store accepts a change.

Changes, on the same signed endpoint (`X-Portfolio-Request-Id` required):

```json
{ "op": "set", "item": "santa-video", "cents": 249, "sent_by": "Justin" }
{ "op": "set", "item": "santa-video", "cents": 249, "startsOn": "2026-11-15", "endsOn": "2026-12-24", "sent_by": "Justin" }
{ "op": "clear", "item": "santa-video", "sent_by": "Justin" }
{ "op": "clear", "item": "santa-video", "startsOn": "2026-11-15", "endsOn": "2026-12-24", "sent_by": "Justin" }
```

`price` (dollars) is accepted instead of `cents`. Dates are New York days,
both included, both or neither (seasonal). `clear` without dates resets the
item to its default; with dates it cancels that seasonal price. Refusals:
`422 below_floor` with `data: { floorCents, floorPrice }` and a message naming
the lowest allowed price, `400 invalid_params` (unknown item, one date only),
`404 not_found` (nothing to clear). Portfolio HQ refuses below the floor
first, shows the store's refusal inline with the floor, re-reads pricing after
every change and writes one audit entry per attempt (`addon_price_set` /
`addon_price_reset` / `addon_schedule_cancel`) with the old and new price and
margin. Ask HQ understands "set Santa video to $2.49" (owner confirms) and
"what's our margin on Santa voice?". A store with add-ons but no `cells` may
send just `{ "addOns": { … } }`.

### 14a. Original draft — `storefront.priceMatrix` in `/api/ops/health`

Still read when a store sends it and has no `/api/ops/pricing`.

Prices by product × quantity tier, plus per-line rows (occasions and kinds:
Letter from Santa, Tooth Fairy, Easter Bunny, thank-you, birthday, holiday,
sympathy, business, nonprofit…), with optional dated overrides. Portfolio HQ
shows the editor only once this block is present. Integer cents (`*_cents`) or
dollars; snake or camel case.

```json
"priceMatrix": {
  "tiers": [ { "id": "1", "min_qty": 1, "max_qty": 9 }, { "id": "10-24", "min_qty": 10, "max_qty": 24 }, { "id": "25+", "min_qty": 25 } ],
  "products": [ { "id": "card", "name": "Card", "unit_cost_cents": 498 }, { "id": "letter", "name": "Letter", "unit_cost_cents": 712 } ],
  "lines": [ { "id": "santa", "product": "letter", "name": "Letter from Santa", "unit_cost_cents": 735 } ],
  "cells": [
    { "product": "card", "tier": "1", "price_cents": 570, "floor_cents": 545, "base_price_cents": 570 },
    { "product": "letter", "line": "santa", "tier": "1", "price_cents": 900, "base_price_cents": 800, "floor_cents": 780, "override_id": "ov_9" }
  ],
  "schedules": [
    { "id": "ps_3", "product": "letter", "line": "santa", "tier": "1", "price_cents": 900,
      "starts_at": "2026-11-15", "ends_at": "2026-12-24", "status": "upcoming", "created_by": "Justin" }
  ]
}
```

- `tiers` may also be strings (`["1", "10-24", "25+"]`); cells may instead be
  a `prices` (or `tiers`) map on each product / line: `{ "1": 5.70, "10-24": 5.10 }`.
- **Floor per cell:** the cell's `floor`, else (single-item tier only) the
  row's `floor`, else break-even from the unit cost and payment fees, with the
  fixed fee spread over the tier's smallest order. Without either, the current
  price is the floor (it can't be lowered blindly). Margin per item = price −
  unit cost − fees (the store's `margin` wins when sent).
- Dates are inclusive `YYYY-MM-DD` (store's local day). A missing start
  means now; a missing end means until reverted. Cancelled schedules are hidden.

Changes are signed `POST /api/ops/actions` (or `priceMatrix.endpoint`):

```json
{ "action": "set_price_cell", "params": { "product": "letter", "line": "santa", "tier": "1", "price_cents": 900,
  "starts_at": "2026-11-15", "ends_at": "2026-12-24", "sent_by": "Justin" } }
{ "action": "revert_price_cell", "params": { "product": "letter", "line": "santa", "tier": "1", "override_id": "ov_9", "sent_by": "Justin" } }
{ "action": "cancel_price_schedule", "params": { "schedule_id": "ps_3", "sent_by": "Justin" } }
```

The store may rename these with `priceMatrix.actions: { set, revert, cancel_schedule }`.
It must refuse a price below its floor (`{ "ok": false, "code": "below_profit_floor" }`).
Portfolio HQ refuses first, and writes one audit entry per attempt (`price_set` /
`price_revert` / `price_schedule_cancel`) with the old and new price and margin.
The existing single `set_price { sku, price }` keeps working alongside.

## 15. `capabilities` in `/api/ops/health` — what this store supports

Portfolio HQ shows every feature for every site: **On**, or **Not supported
by this site yet** with a "Propose a build" button that generates the exact
store-side prompt. A store lists what it implements **inside the
`/api/ops/health` response** (top-level `capabilities` key). Portfolio HQ
reads it from every health pull; a separate `GET /api/ops/capabilities`
(same shape, or `{ "capabilities": … }`) is only tried as a fallback during a
feature check when health has none — don't rely on it:

```json
"capabilities": { "version": 1, "features": ["health", "metrics", "unit_economics", "recurring", "orders", "alerts", "actions",
  "prices", "price_matrix", "addon_prices", "attribution", "inbox", "geo", "demand", "cohorts", "channels", "plans_goals", "cash",
  "fulfillment", "feedback", "mix", "seo", "experiments", "live", "report", "business", "admin", "vendors", "campaigns"] }
```

- `features` may also be a map (`{ "inbox": true, "geo": "1" }`) or a bare
  list; unknown keys are ignored; common renames (`price_grid`, `live_now`,
  `business_automation`, `owners_report`…) are mapped in one place
  (`KEY_ALIASES` in `src/lib/capabilities.ts`).
- Anything not declared is still detected from the data (a `geo{}` block turns
  on the map, a `priceMatrix` the itemized grid, …), and the on-demand endpoints
  (`/inbox`, `/attribution`, `/experiments`, `/live`, `/report`) are probed with
  a signed GET from the add-site wizard or "Check features". A 404 means "not
  supported"; nothing is ever changed by a probe.
- Bump `version` when the list's meaning changes; Portfolio HQ reads any version.

## 16. `admin_sections` — the store's admin, run from Portfolio HQ

**Owner rule: the owners never log into a store's own `/admin`.** Every admin
screen the store has is advertised to Portfolio HQ, which renders it generically
on the site's **Admin** tab: a table (or cards) from the section's read
endpoint, one button per action with a form built from the action's params
JSON schema, a confirmation for destructive actions, a result message, and one
audit entry per attempt. A new section or action on the store shows up in HQ
with no HQ change.

List the sections **inside `capabilities` in `/api/ops/health`** (§15):

```jsonc
"capabilities": {
  "version": 1,
  "features": ["health", "metrics", "…", "admin"],
  "admin_sections": [
    {
      "id": "character_messages",            // [a-z0-9_-], unique
      "title": "Character voice & video",
      "description": "Personalized voice + video messages per order",   // optional
      "view": "character",                   // optional hint: character | orders | refunds | alerts (else a generic table)
      "read_endpoint": "/api/ops/admin/character-messages",            // signed GET, must start with /api/ops/
      "search": "q",                         // optional: query param the read endpoint takes for a search
      "actions": [
        { "name": "retry_character_message", "label": "Retry", "scope": "row", "destructive": false,
          "params": { "type": "object", "properties": { "message_id": { "type": "string" } }, "required": ["message_id"] } },
        { "name": "make_video_now", "label": "Make video now", "scope": "row", "destructive": false,
          "params": { "type": "object", "properties": { "message_id": { "type": "string" } }, "required": ["message_id"] } },
        { "name": "make_demos", "label": "Make demos", "scope": "section", "destructive": false,
          "params": { "type": "object", "properties": { "character": { "type": "string", "enum": ["all", "…"] } } } },
        { "name": "mark_refunded_by_hand", "label": "Mark refunded by hand", "scope": "row", "destructive": true,
          "params": { "type": "object", "properties": { "refund_id": { "type": "string" }, "note": { "type": "string", "maxLength": 300 } }, "required": ["refund_id"] } }
      ]
    },
    { "id": "orders", "title": "Orders", "view": "orders", "read_endpoint": "/api/ops/admin/orders", "search": "q",
      "actions": [{ "name": "refund_order", "label": "Refund", "scope": "row", "destructive": true,
        "params": { "type": "object", "properties": { "order_id": { "type": "string" }, "amount": { "type": "number", "minimum": 0.01 } }, "required": ["order_id"] } }] }
  ]
}
```

**Actions.** `name` is `[A-Za-z0-9_.:-]`, up to 64 characters. `params` is a
JSON schema object: `properties` with `type` `string` | `number` | `integer` |
`boolean`, plus optional `title`, `description`, `enum`, `minimum`, `maximum`,
`minLength`, `maxLength`, `pattern`, `format` (`date`, `email`, `textarea`) and
`default`, and a `required` list. `scope` is `row` (one button per item; its
params are filled from the row — same-named fields, then the row `id` for the
first `*_id` field) or `section` (one button for the whole section). Without
`scope`, an action with an `id` / `*_id` param is a row action.
`destructive: true` means Portfolio HQ always shows a confirmation dialog first,
and refuses to send it unconfirmed. `confirm` (a string) replaces the default
warning text. `endpoint` (optional, `/api/ops/…`) is where the action is
POSTed; the default is `/api/ops/actions`.

**Describe every input.** An action that takes parameters must describe them —
Portfolio HQ opens a form (a bottom sheet on phones) before calling the store
and never sends an action with its params missing. Accepted shapes, all read
the same way:

- `params` **or `inputs`** (also `params_schema` / `input_schema`): the JSON
  schema above. Without `title`, a short `description` is the field's label
  (`"Order number"`); a long one keeps its first clause as the label and the
  whole text as help. `help` is help text.
- A list of descriptors: `[{ "name", "type", "enum" | "options": [{ "value", "label" }], "required", "label", "help" }]`
  (`type` may also be `enum`, `textarea`, `list`, `json`).
- `type: "array"` (`items.type` string / integer → one per line or comma
  separated; `items.type: object` → JSON) and `type: "object"` (JSON).
- `"confirm": { "type": "boolean", "const": true }` is a confirmation token:
  never shown as a field, sent as `true` only after the owner confirmed.
  `confirm_required`: `always` (= destructive), `conditional` (costs money or
  touches everything — HQ always asks first), `never`.
- "One of these": `anyOf: [{ "required": ["order_id"] }, { "required": ["message_id"] }]`.
  An action whose only inputs are optional ids needs at least one of them.
- `read` (or `reads[0].endpoint`) is accepted for `read_endpoint`; a read
  answer may be wrapped as `{ "section", "view", "generatedAt", "data": { … } }`,
  and its top-level scalar settings are shown as the section's summary.

Errors: reply with a plain `message` the owner can read ("Pick a character
first"). HQ rewrites `params.<field> is required` into plain words with the
field's label and keeps your raw text in its audit log.

If a store advertises one of the contract's action names below without
describing params, HQ falls back to its own form for it (an action HQ doesn't
know and that has no params runs with none).

**Character voices** (a section with `"view": "voices"`, or any section whose
actions are these): `character_voice_set {character, voice_name?, style?, pace?, regenerate_demo?}`,
`character_voice_reset {character, regenerate_demo?}`, `character_voice_demo {character | "all", include_video?, confirm?}`
(videos cost money: `confirm_required: "conditional"`), `character_voice_regenerate {order_id | message_id}` (free).
Its read endpoint answers `characters: [{ character, title, profile: { voiceName, style, pace, edited }, defaults, sample: { voiceUrl, videoUrl } }]`,
`voices: [{ name, label }]` (the stock voices), `paces: [...]` and
`recentVoiceTakes: [{ messageId, orderId, character, status, oldVoice, canRegenerate, createdAt }]`.
HQ shows each profile with Play buttons and one-tap Regenerate per recent
message (older voices first).

**Running an action.** Portfolio HQ validates the owner's input against the
schema (unknown keys are dropped), then sends a signed POST (§1, with
`X-Portfolio-Request-Id` for idempotency):

```json
{ "action": "retry_character_message", "params": { "message_id": "msg_42" }, "section": "character_messages", "sent_by": "Justin" }
```

Reply `{ "ok": true, "message": "Video re-queued" }`, or
`{ "ok": false, "code": "not_allowed", "message": "…" }` (4xx). The store must
validate the params itself too, and must only accept actions it advertises.
Every attempt — ok, blocked (bad params, unconfirmed destructive, store refused)
or error — is one `admin_action` entry in Portfolio HQ's Activity log with the
owner's name, section, action and params.

**Read endpoint.** A signed GET answering any of: a bare list; `{ "items": [...] }`
(or `rows` / `data` / `results` / `records` / `<section id>`). Optional:
`columns` (`["child_name", "status", …]` or `[{ "key", "label" }]`), a
`summary` / `counts` object of numbers, `total`, `note`, and other lists next to
the main one (e.g. `manual_refunds: [...]`), shown as their own tables. Rows:

```json
{
  "items": [
    { "id": "msg_42", "child_name": "Bobby", "character": "Snowman", "status": "failed", "error": "Voice render timed out",
      "order_id": "1042", "video_url": "https://…/msg_42.mp4", "audio_url": "https://…/msg_42.mp3", "updated_at": "2026-10-11T02:10:00Z" }
  ],
  "manual_refunds": [
    { "id": "rf_7", "refund_id": "rf_7", "customer": "Ana P.", "order_id": "1039", "amount_cents": 1499, "status": "needs_refund",
      "reason": "Video could not be made", "payment_intent": "pi_3Q…", "actions": ["mark_refunded_by_hand"] }
  ],
  "summary": { "queued": 3, "failed": 1, "sent_today": 12 }
}
```

- `actions` on a row (names) limits the row's buttons to those advertised
  actions; without it every row action shows.
- Money: `amount_cents` (integer) or `amount` (dollars). Times: ISO-8601 UTC.
- Media: `video_url`, `audio_url` / `voice_url`, or `preview_url` (https) get a
  play / preview button.
- Stripe: `stripe_url` (a `https://dashboard.stripe.com/…` link) or a
  `payment_intent` / `charge_id` gives "Open in Stripe".
- **Needs a human.** A row with `refund_needed: true` (or status
  `needs_refund` / `manual_refund`, or any row in a list named `*refund*` that
  isn't `refunded`) is a manual refund to do; a row with a failing status in a
  `character` section is a failed character message; any row with
  `"attention": "critical" | "high" | "normal" | "info"` (+ optional
  `attention_title`) is flagged. Portfolio HQ puts these in its Action items
  inbox and the briefing's "Needs a human", with the row's actions as one-tap
  buttons.

Portfolio HQ reads every section's read endpoint with each 10-minute pull (a
failure never marks the plug failing) and again when an owner opens the Admin
tab or after an action. Owners can also type a command in Ask HQ or Request a
change ("retry Bobby's video"): HQ matches it to one advertised action and row,
and runs it only after the owner confirms.

## 17. `GET /api/ops/vendors` — vendors & costs (every paid service)

Owner rule: every application that costs money is visible and categorized in
Portfolio HQ. The store lists every paid (or planned, or free) service it
uses, with what it cost per day. Portfolio HQ pulls it with every 10-minute
pull (a failure or 404 never marks the plug failing), shows one row per vendor
on its Vendors page and the site page, itemizes the store's P&L lines by
vendor, and raises a "New service detected" action item for a vendor it
hasn't seen before once the store reports a cost for it.

```json
{
  "vendors": [
    { "id": "fulfillment-partner", "name": "Fulfillment partner", "used_for": "Printing + postage per order",
      "category": "cogs", "billing_model": "per_order", "status": "live",
      "billing_url": "https://fulfillment.example/billing",
      "included_in": "fulfillment", "source": "actual",
      "daily": [{ "date": "2026-10-10", "cents": 2415 }], "first_seen": "2026-09-01" },
    { "id": "google-gemini", "name": "Google AI Studio / Gemini API", "used_for": "Veo video, TTS, images",
      "category": "cogs", "billing_model": "usage", "status": "live", "included_in": "ai", "source": "estimated",
      "daily": [{ "date": "2026-10-10", "cents": 312 }] },
    { "id": "resend", "name": "Resend", "used_for": "Transactional email", "category": "fixed",
      "billing_model": "monthly", "status": "live", "included_in": null, "monthly_cents": 2000 },
    { "id": "twilio", "name": "Twilio", "used_for": "SMS (10DLC)", "category": "fixed",
      "billing_model": "monthly", "status": "planned", "included_in": null, "detected": true }
  ]
}
```

- `id` — stable slug; `name` — what the owners call it.
- `category` — `cogs` (cost of goods: anything paid per order — payments,
  fulfillment, per-order AI such as letters / video / voice / images,
  per-order emails or SMS), `fixed` (fixed / overhead: subscriptions, domains,
  phone numbers, plan fees), `marketing` (ad platforms), `development`
  (build tools). Omit it when unsure: HQ counts the cost in fixed / overhead
  and asks an owner to pick one.
- `billing_model` — `per_order` | `usage` | `monthly` | `annual` | `free` | `export_only`.
- `status` — `live` | `inactive` | `planned`. A `planned` vendor that starts
  costing money raises a High action item in HQ.
- `included_in` — the P&L line this vendor's cost is ALREADY part of in
  `/api/ops/metrics` (`payment_fees`, `fulfillment`, `ai`, `fixed_costs`).
  HQ then splits that line by vendor instead of counting the cost twice.
  `null` = the store reports this cost nowhere else: HQ adds it to the P&L
  under its category.
- `daily[] {date, cents}` — cost per America/New_York day, integer cents,
  covering at least the last 62 days (this and last month). `source` says
  whether the amounts are `actual` (from the vendor's bill / API / measured
  usage) or `estimated` (rates × volume).
- `monthly_cents` — the recurring amount when there is no daily figure
  (subscriptions); HQ prorates it per day from the launch date.
- `detected: true` — the store just started using this service (HQ raises
  "New service detected" until an owner reviews it). Any `id` HQ hasn't seen
  before counts as new too, but only raises the item once it has a cost
  (free and known services are acknowledged automatically).
- `billing_url` — https link to the vendor's billing page (shown on the row).
- Amounts may also be sent in micro-USD (`micro_usd` / `cost_micros` on a
  daily row, `monthly_micros`) — HQ keeps sub-cent precision.
- **AI billed directly by a provider** (Google: Veo video, Gemini TTS / images —
  rows whose id / name says google, gemini, veo, vertex or imagen) is not part of
  the AI Gateway cost the store meters in `aiCost`: HQ puts it on the AI line
  and ADDS it to the store's `aiCost`. If your `aiCost` already includes it, set
  `"metric_includes": true` on the row and HQ splits the line instead.
- `character_media[]` (optional, next to `vendors`) — the ledger of generated
  clips: `{ date, kind: "video"|"voice"|…, micro_usd, order_id?, paid?, purpose:
  "order"|"demo"|"owner_test"|"regeneration" }`. Clips tied to a paid order are
  per-order AI (cost of goods); demo clips, owner tests and regenerations not
  tied to a paid order are overhead ("AI for demo clips & owner tests").
- Never include secrets, account numbers or customer data. Add `vendors` to
  `capabilities.features` (§15).

Vendors HQ already knows from its own ledger (Netlify team billing and agent
runs, the company domain, HQ's own email, Claude for Ask HQ) don't need to be
listed by a store. Owners can also add a vendor, set its monthly amount once
(it repeats every month) and change its category or status on the Vendors page.

## 18. `GET` / `POST /api/ops/campaigns` — marketing campaigns (attribution)

Portfolio HQ's Marketing page shows one row per campaign — channel, status,
budget, spent, pieces out (cards mailed), scans / clicks, signups, first
orders, paying customers, business accounts, revenue, gross profit, cost per
signup / paying customer / business account, repeat rate, ROAS and a trend —
plus a funnel, a timeline, every attributed order and, for referral / seed
campaigns, a chain view (sender → recipient → scan → their own send,
generations, k-factor). HQ renders exactly what the store reports; it never
invents a count. Until a store implements this section, HQ shows **"Needs
store update — capability `campaigns`"** and tracks spend only.

HQ pulls `GET /api/ops/campaigns?from=YYYY-MM-DD&to=YYYY-MM-DD` (trailing 365
days) with every 10-minute pull; a 404 or failure never marks the plug
failing. Money is in **integer cents**; dates are America/New_York days.

```json
{
  "version": 1,
  "from": "2025-10-11",
  "to": "2026-10-11",
  "campaigns": [
    {
      "key": "friends-family-seed",
      "name": "Friends & family seed",
      "channel": "seed",
      "status": "live",
      "budget_cents": 100000,
      "offer": "2 free cards per person",
      "totals": { "pieces_out": 180, "scans": 64, "clicks": 12, "signups": 31, "first_orders": 14,
                  "orders": 19, "paying_customers": 14, "business_accounts": 0, "repeat_customers": 3,
                  "revenue_cents": 41300, "gross_profit_cents": 18200 },
      "daily": [
        { "date": "2026-11-03", "pieces_out": 40, "scans": 9, "clicks": 2, "signups": 4, "first_orders": 2,
          "orders": 2, "paying_customers": 2, "business_accounts": 0, "repeat_customers": 0,
          "revenue_cents": 5800, "gross_profit_cents": 2500 }
      ],
      "costs": [
        { "date": "2026-11-03", "label": "Cards mailed (40 × free)", "vendor_id": "fulfillment-partner", "cents": 15600 }
      ],
      "orders": [
        { "id": "1042", "at": "2026-11-03T15:20:00Z", "amount_cents": 2900, "gross_profit_cents": 1250,
          "code": "FRIE-7KQ2MX", "kind": "first", "customer_type": "consumer", "occasion": "Christmas" }
      ],
      "sources": [ { "utm_source": "friends", "utm_campaign": "friends-family-seed", "scans": 64, "clicks": 12, "signups": 31, "orders": 19 } ],
      "codes": [ { "code": "FRIE-7KQ2MX", "kind": "referral", "uses": 2, "limit": 2, "url": "https://store.example/?code=FRIE-7KQ2MX" } ],
      "chain": [
        { "id": "n1", "parent_id": null, "generation": 0, "sends": 2, "scans": 1, "orders": 0 },
        { "id": "n2", "parent_id": "n1", "generation": 1, "sends": 1, "scans": 1, "orders": 1 }
      ]
    }
  ],
  "lists": [ { "id": "realtors-tx", "name": "Realtors · Texas", "count": 120 } ]
}
```

- `key` — stable slug; the same value as `utm_campaign` on every link / QR of
  the campaign. HQ creates campaigns with `campaign_create` (below) and
  matches the store's rows by `key`; a key HQ hasn't seen joins its registry.
- `channel` — `seed` | `referral` | `mail` | `b2b_mail` | `google_ads` |
  `meta_ads` | `tiktok` | `partnership` | `influencer` | `seo` | `organic` |
  `other`. `status` — `idea` | `ready` | `live` | `paused` | `done`.
- `daily[]` — **additive** counts per day (HQ sums any period from them):
  `pieces_out` (cards mailed that day), `scans` (QR), `clicks` (links with the
  campaign's utm), `signups`, `first_orders`, `orders`, `paying_customers`
  (counted on the day of their first paid order), `business_accounts`
  (counted on the day the account first pays), `repeat_customers` (counted
  once, on the day of their second paid order), `revenue_cents`,
  `gross_profit_cents` (revenue − cost of goods). Test orders excluded.
  `totals` is optional and used only when `daily` is empty.
- `costs[]` — what the campaign cost the store per day (e.g. mailed cards,
  free cards in a seed, a promo below price **booked as marketing spend**).
  `vendor_id` = the §17 vendor this cost is already in (HQ shows it on the
  campaign but never adds it to the P&L twice); without `vendor_id` HQ adds
  it to the P&L Marketing line.
- `orders[]` — every attributed order in the range (no customer names or
  emails): `kind` `first` | `repeat`, `customer_type` `consumer` | `business`,
  `occasion` (e.g. Christmas, wedding) so HQ can answer "which campaign brought
  the most Christmas orders?".
- `sources[]` — touches by `utm_source` / `utm_campaign` (segments such as
  realtors vs wedding planners in one B2B mailing).
- `chain[]` — referral / seed campaigns: one node per person (anonymous id),
  `parent_id` = who sent them the card, `generation` 0 for seed senders,
  `sends` = cards they sent, `scans`, `orders`. HQ computes generations and
  the k-factor (new senders per sender).
- `lists[]` — mailing lists the store can mail for a campaign (for the batch
  preview).

`POST /api/ops/campaigns` — signed like every POST, body
`{ "action": …, "params": {…}, "sent_by": "<owner name>" }`, reply
`{ "ok": true|false, "message": "…", "code"?: "…", "data"?: {…} }`; an unknown
action → `400 { "code": "unknown_action" }` and nothing changes (HQ then shows
"Needs store update: <action>").

| action | params | the store… |
| ------ | ------ | ---------- |
| `campaign_create` | `{ key, channel, name, budget_cents, offer }` | registers the campaign (status `ready`; never launches it) |
| `campaign_generate_codes` | `{ key, count, kind: "qr" \| "promo" \| "referral", per_code_limit }` | creates the codes and answers `data.codes[] {code, url, limit}`; promo / referral discounts below cost are booked as marketing spend (cost in `costs[]`) |
| `campaign_set_status` | `{ key, status }` | changes status (HQ sends `live` only after an owner confirmed) |
| `campaign_mail_batch_preview` | `{ key, list_id }` | answers `data {count, cost_cents}` — **never sends** |
| `campaign_mail_batch_send` | `{ key, list_id, confirm: true }` | mails the batch; refuse without `confirm: true` (`code: "needs_confirm"`) |

HQ only sends `campaign_mail_batch_send` after a preview of the same list and
an owner's confirmation (a second one when it goes past the campaign budget).
Nothing in this section may spend money or send mail on its own. Add
`campaigns` to `capabilities.features` (§15).
