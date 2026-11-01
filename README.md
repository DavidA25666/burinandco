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
| `OWNER_EMAIL` | Where your "ready to review" notifications go. |
| `FROM_EMAIL` | e.g. `Burin & Co. <studio@burinandco.com>` (must be a Resend-verified domain). |
| `RESEND_API_KEY` | From Resend. |
| `STRIPE_SECRET_KEY` | Start with your `sk_test_...` key. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`, see below. |
| `REPLICATE_API_TOKEN` | From Replicate. |
| `REPLICATE_MODEL` | Optional. Default `openai/gpt-image-2.5-sunburst`. Also supported: `google/nano-banana-pro`, `google/nano-banana-2.1`, `black-forest-labs/flux-kontext-max`. |
| `REPLICATE_RESOLUTION` | Optional. Default `4K`. |
| `FINERWORKS_WEB_API_KEY` | From FinerWorks (My Account → Web API). |
| `FINERWORKS_APP_KEY` | From FinerWorks. |
| `FINERWORKS_CODE_16X12_WALNUT` | FinerWorks product code for a 16 × 12 print in dark walnut. See "FinerWorks setup". |
| `FINERWORKS_CODE_16X12_BLACKOAK` | Same, black oak. |
| `FINERWORKS_CODE_20X16_WALNUT` | 20 × 16 print, dark walnut. |
| `FINERWORKS_CODE_20X16_BLACKOAK` | 20 × 16 print, black oak. |
| `FINERWORKS_LIVE` | Leave unset for test orders (not billed or printed). Set to `true` to place real orders. FinerWorks also keeps orders in test mode while the app key itself is in test mode. |

## FinerWorks setup

1. Add `FINERWORKS_WEB_API_KEY` and `FINERWORKS_APP_KEY` in Netlify.
2. In FinerWorks' Print Online Setup Tool, build each product: Framed Giclee, Hahnemühle Photo Rag,
   Nature Wood 2" frame in Dark Walnut or Black Oak, Snow White mat, Reflection Control acrylic,
   frame 3" larger than the print (16 × 12 print in a 19 × 15 frame; 20 × 16 in a 23 × 19).
   Copy each **product code** into the matching `FINERWORKS_CODE_...` variable (four in all), then redeploy.
3. In `/admin.html`, click **Check FinerWorks**. It confirms the keys and shows each code's product and price
   (expect about $145 for 16 × 12 and $199 for 20 × 16, before shipping).
4. Send a paid test order to FinerWorks while `FINERWORKS_LIVE` is unset, and check it in FinerWorks.
5. When ready, set `FINERWORKS_LIVE=true` (and switch the app key to live in FinerWorks, with billing set up).

The variable names follow the print size the site shows, so a size added to `catalog.mts` later needs its own pair.

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
