# Burin & Co.

A Netlify site that takes a photo of a car, yacht, aircraft or building, turns it into a
banknote-style line engraving with AI, lets you review it, emails the customer a proof,
and gives you the approved file to order from the print lab. It uses the same order flow,
dashboard and model-compare page as Namesake Portraits.

## How an order flows

1. Customer picks the subject, uploads a photo, chooses style/size/frame/collector edition,
   types the two plaque lines, and pays with Stripe Checkout.
2. Stripe tells the site the payment went through (`/api/stripe-webhook`).
3. The site sends the photo to Replicate (Nano Banana Pro by default) to render the engraving.
4. **You get an email** when it's ready. Open `/admin.html` to compare it with the original photo.
5. You either **Regenerate** (with a note on what to fix) or **Send proof** to the customer.
6. The customer opens their proof link and clicks **Approve** or **Request a change**.
   You get an email either way. Changes go back to step 5, with their note pre-filled.
7. Once approved, click **Make print file**. Topaz upscales the render 2x on Replicate, then it is
   resized to the print at 300 dpi (240 dpi for 30 × 40) and padded to the frame shape with the
   render's own paper (with the caption typeset under the art, if there is one).
   Then click **Send to FinerWorks**: it places the order through the FinerWorks API with that print file,
   Ground shipping and the order ID in `custom_data_1`. It's a **test** order (not billed or printed)
   until `FINERWORKS_LIVE` is `true`. The dashboard won't send an unpaid order, or a print file that's
   from an older version or has an old caption. To place an order by hand instead, download the file,
   order it in FinerWorks, then click **Mark as sent to print** and note the lab's order number.

## Accounts you need

| Service | What it does | Where to get the key |
|---|---|---|
| Stripe | Takes payment | Dashboard → Developers → API keys |
| Replicate | Renders the engraving | replicate.com → Account → API tokens |
| Resend | Sends the emails | resend.com → API Keys (verify your domain first) |
| FinerWorks | Prints, frames, ships | finerworks.com → My Account → Web API (web API key); the app key comes from the same page or FinerWorks support |

The same Stripe, Replicate and Resend accounts as Namesake work; use a new Stripe webhook
and a Resend domain for burinandco.com.

## Environment variables

Set these in Netlify: **Project configuration → Environment variables**. Never put them in code.

| Variable | Example / notes |
|---|---|
| `SITE_SECRET` | Any long random string (40+ characters), different from Namesake's. Signs proof links and file links. |
| `ADMIN_PASSWORD` | The password for `/admin.html` and `/lab.html`. |
| `OWNER_EMAIL` | Where owner notifications go, only if they're turned back on in HQ (off by default). |
| `FROM_EMAIL` | e.g. `Burin & Co. <studio@burinandco.com>` (must be a Resend-verified domain). |
| `RESEND_API_KEY` | From Resend. |
| `STRIPE_SECRET_KEY` | Start with your `sk_test_...` key. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`, see below. |
| `REPLICATE_API_TOKEN` | From Replicate. |
| `REPLICATE_MODEL` | Optional. Default `openai/gpt-image-2.5-sunburst`. Also supported: `google/nano-banana-pro`, `google/nano-banana-2.1`, `black-forest-labs/flux-kontext-max`. |
| `REPLICATE_RESOLUTION` | Optional. Default `4K`. |
| `FINERWORKS_WEB_API_KEY` | From FinerWorks (My Account → Web API). |
| `FINERWORKS_APP_KEY` | From FinerWorks. |
| `FINERWORKS_CODE_...` | Optional. The four product codes are built in (`netlify/shared/finerworks.mts`); a variable such as `FINERWORKS_CODE_16X12_WALNUT` overrides one. |
| `FINERWORKS_LIVE` | Leave unset for test orders (not billed or printed). Set to `true` to place real orders. FinerWorks also keeps orders in test mode while the app key itself is in test mode. |
| `PORTFOLIO_OPS_SECRET` | The Admin Plug secret Tenfold HQ generates (site → Settings → Admin plug). |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Signing secret of the Resend webhook for `email.received` (`whsec_...`). |
| `STRIPE_ACCOUNT_ID` | Burin's Stripe account id (`acct_…`), not secret. Reported in `/api/ops/health` → `stripe.account` (§2a). |
| `OWNER_TEST_EMAILS` | Comma list of the owners' own emails. Orders from them are test orders, left out of revenue and profit in HQ (added to the Owner / test emails store setting). |
| `ABANDONED_CHECKOUT_EMAILS` | Set to `off` to stop the abandoned-checkout reminder (one email, about an hour after someone leaves checkout, offering a free proof with no card). On when unset. |
| `META_PIXEL_ID` | Burin's Meta Pixel ID (Events Manager). Public; loads only after a visitor accepts cookies. |
| `META_CAPI_ACCESS_TOKEN` | Conversions API access token (the older name `META_CAPI_TOKEN` also works; same name as Namesake) for that Pixel (Events Manager → Settings → Generate access token). Server-only. |
| `META_TEST_EVENT_CODE` | Optional, temporary: sends CAPI events to Events Manager → Test events while you check them. Remove after. |
| `CLARITY_PROJECT_ID` | Microsoft Clarity project ID (Settings → Overview). Public; loads only after Accept. |
| `RESEND_RECEIVING_API_KEY` | Resend key that can read received emails (falls back to `RESEND_API_KEY`). |
| `SUPPORT_EMAIL` | Optional. Default `support@burinandco.com`. |
| `HQ_SITE_SLUG` | Optional. Default `burinandco` (the slug HQ shows for the site). |

## FinerWorks setup

1. Add `FINERWORKS_WEB_API_KEY` and `FINERWORKS_APP_KEY` in Netlify.
2. The product codes are already in `netlify/shared/finerworks.mts` (Photo Rag, Nature Wood 2" Dark Walnut or
   Black Oak, Snow White mat, Reflection Control, frame 3" larger than the print). If you change the build, make it in
   FinerWorks' Print Online Setup Tool and copy its product code there, or into a `FINERWORKS_CODE_...` variable in Netlify.
3. In `/admin.html`, click **Check FinerWorks**. It confirms the keys and shows each code's product and price
   (expect about $145 for 16 × 12 and $199 for 20 × 16, before shipping).
4. Send a paid test order to FinerWorks while `FINERWORKS_LIVE` is unset, and check it in FinerWorks.
5. When ready, set `FINERWORKS_LIVE=true` (and switch the app key to live in FinerWorks, with billing set up).

The variable names follow the print size the site shows, so a size added to `catalog.mts` later needs its own pair.

## Stripe webhook

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://burinandco.com/api/stripe/webhook` (the old `/api/stripe-webhook` path still works)
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.succeeded`, `charge.updated`, `charge.refunded`,
  `charge.dispute.created`, `charge.dispute.closed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

## Tenfold HQ (the owners' dashboard)

Burin & Co. is run from Tenfold HQ (hq.tenfoldcommerce.com) through the signed Admin Plug in
`docs/SITE_CONTRACT.md`. Everything lives in `netlify/functions/ops.mts` and `netlify/shared/ops/`.

- Every `/api/ops/*` request is checked with `PORTFOLIO_OPS_SECRET` (HMAC-SHA256, 5-minute window).
- HQ reads health, metrics (with geo, cohorts, channels, cash, fulfillment, mix, SEO), orders, alerts,
  ads attribution, the support inbox, live visitors, monthly reports, pricing and vendors.
- HQ runs the store admin: orders (send proof, regenerate, caption, print file, FinerWorks, refund),
  settings, AI spend, FinerWorks checks, the email outbox and the change log. Every change is logged.
- Prices: the defaults are in `catalog.mts`; HQ's prices and seasonal prices override them and are refused
  below break-even (FinerWorks cost + AI + Stripe fees). The storefront reads them from `/api/catalog`.
- Owner emails are off by default; HQ alerts replace them. Turn them back on in HQ → Admin → Store settings.
- AI: every Replicate run is logged with its estimated cost. The model lab (`/lab.html`) is always on for
  the owners; HQ sees its spend but can't switch it off. There's a monthly AI budget (alert at 75%). No AI runs on a schedule.
- Support mail: customer emails reply to `support@burinandco.com`. Resend receives it and posts to
  `/api/inbound/email`; mail for the other Tenfold brands is ignored.

Run `npm test` and `npm run typecheck` before pushing.

## Prices, styles and prompts

All in `netlify/shared/catalog.mts`: sizes and prices (in cents, US shipping included),
the collector edition price, the two styles, and the engraving prompt for each subject type.
The storefront shows prices in `public/index.html`; keep the two in step.

## Comparing models

`/lab.html` (same password as the dashboard) renders one photo with every model in
`COMPARE_MODELS` (`netlify/shared/replicate.mts`) side by side, using the real order prompt.
Mark the most accurate render for each photo; the tally shows which model wins. Then set
`REPLICATE_MODEL` in Netlify to the winner.

## Testing safely

1. Use Stripe **test** keys and pay with card `4242 4242 4242 4242`.
2. Place a test order with a photo of your own car and walk through every step.

## Files

- `public/index.html`, `styles.css`, `app.js`: storefront and commission form
- `public/admin.html`: your review dashboard
- `public/lab.html`: model compare page
- `public/proof.html`: customer's approve/change page
- `public/ops.css`: styles for the admin, lab, proof and thank-you pages
- `netlify/functions/`: one file per step (orders, webhook, render, proof, admin, lab, files)
- `netlify/shared/`: catalog, prompts, and integrations (Stripe, Replicate, Resend)

Images in `public/img/` are placeholder mockups of a generic coupe, not customer work.
