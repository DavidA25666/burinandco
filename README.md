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
7. Once approved, download the print file from the dashboard, order the print, frame and
   brass plaque from the lab, then click **Mark as sent to print** and note the lab's order number.
   (No print lab is connected yet; FinerWorks or Prodigi can be wired in later.)

## Accounts you need

| Service | What it does | Where to get the key |
|---|---|---|
| Stripe | Takes payment | Dashboard → Developers → API keys |
| Replicate | Renders the engraving | replicate.com → Account → API tokens |
| Resend | Sends the emails | resend.com → API Keys (verify your domain first) |

The same Stripe, Replicate and Resend accounts as Namesake work; use a new Stripe webhook
and a Resend domain for burinandco.com.

## Environment variables

Set these in Netlify: **Project configuration → Environment variables**. Never put them in code.

| Variable | Example / notes |
|---|---|
| `SITE_SECRET` | Any long random string (40+ characters), different from Namesake's. Signs proof links and file links. |
| `ADMIN_PASSWORD` | The password for `/admin.html` and `/lab.html`. |
| `OWNER_EMAIL` | Where your "ready to review" notifications go. |
| `FROM_EMAIL` | e.g. `Burin & Co. <studio@burinandco.com>` (must be a Resend-verified domain). |
| `RESEND_API_KEY` | From Resend. |
| `STRIPE_SECRET_KEY` | Start with your `sk_test_...` key. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`, see below. |
| `REPLICATE_API_TOKEN` | From Replicate. |
| `REPLICATE_MODEL` | Optional. Default `openai/gpt-image-2.5-sunburst`. Also supported: `google/nano-banana-pro`, `google/nano-banana-2.1`, `black-forest-labs/flux-kontext-max`. |
| `REPLICATE_RESOLUTION` | Optional. Default `4K`. |

## Stripe webhook

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://YOUR-SITE.netlify.app/api/stripe-webhook`
- Event: `checkout.session.completed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

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
