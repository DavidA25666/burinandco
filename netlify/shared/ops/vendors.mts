// GET /api/ops/vendors (§17): every paid service the store uses, with its cost per New York day.
// Cost of goods (Stripe, FinerWorks, Replicate renders for orders) is kept apart from
// development (Replicate runs on the model-compare lab).
import type { Order } from "../store.mts";
import type { AiCall, Settings } from "../ops-store.mts";
import { dateRange, addDays, nyDate } from "../ops-store.mts";
import { isTest, isPaid, aiByOrder, orderMoney, paidDate } from "./economics.mts";

export function vendorsView(orders: Order[], s: Settings, aiCalls: AiCall[], today = nyDate()) {
  const from = addDays(today, -69);
  const days = dateRange(from, today);
  const ai = aiByOrder(aiCalls);
  const real = orders.filter((o) => !isTest(o, s) && isPaid(o));
  const realIds = new Set(orders.filter((o) => !isTest(o, s)).map((o) => o.id));
  const series = (fill: (add: (date: string, cents: number) => void) => void) => {
    const m = new Map(days.map((dd) => [dd, 0]));
    fill((date, cents) => { if (m.has(date)) m.set(date, m.get(date)! + cents); });
    return days.map((date) => ({ date, cents: Math.round(m.get(date)!) }));
  };
  const firstSeen = (xs: string[]) => xs.sort()[0] ?? null;
  const allFeesActual = real.every((o) => o.stripeFeeCents != null);

  return {
    version: 1,
    money_unit: "cents",
    test_orders_excluded: true,
    vendors: [
      {
        id: "stripe", name: "Stripe", used_for: "Card payments (card saved at order, charged on proof approval)",
        category: "cogs", billing_model: "per_order", status: "live",
        billing_url: "https://dashboard.stripe.com/balance/overview", included_in: "payment_fees",
        source: allFeesActual ? "actual" : "estimated",
        daily: series((add) => { for (const o of real) add(paidDate(o)!, orderMoney(o, s, ai).fees); }),
        first_seen: firstSeen(real.map((o) => paidDate(o)!)),
      },
      {
        id: "finerworks", name: "FinerWorks", used_for: "Printing, framing and Ground shipping per order",
        category: "cogs", billing_model: "per_order", status: "live",
        billing_url: "https://finerworks.com/apps/orderform/myaccount.aspx", included_in: "fulfillment",
        source: "estimated",
        daily: series((add) => { for (const o of real) add(paidDate(o)!, orderMoney(o, s, ai).fulfillment); }),
        first_seen: firstSeen(real.map((o) => paidDate(o)!)),
      },
      {
        id: "replicate", name: "Replicate", used_for: "AI renders, regenerations and print upscales for customer orders",
        category: "cogs", billing_model: "usage", status: "live",
        billing_url: "https://replicate.com/account/billing", included_in: "ai", source: "estimated",
        daily: series((add) => { for (const c of aiCalls) if (c.purpose !== "lab" && (!c.orderId || realIds.has(c.orderId))) add(c.date, c.cents); }),
        first_seen: firstSeen(aiCalls.filter((c) => c.purpose !== "lab").map((c) => c.date)),
      },
      {
        id: "replicate-lab", name: "Replicate (model lab)", used_for: "Owner tests on the model-compare page ",
        category: "development", billing_model: "usage", status: "live",
        billing_url: "https://replicate.com/account/billing", included_in: null, source: "estimated",
        daily: series((add) => { for (const c of aiCalls) if (c.purpose === "lab") add(c.date, c.cents); }),
        first_seen: firstSeen(aiCalls.filter((c) => c.purpose === "lab").map((c) => c.date)),
      },
      {
        id: "resend", name: "Resend", used_for: "Customer email (proofs, receipts) and the support inbox; shared Tenfold Commerce team",
        category: "fixed", billing_model: "monthly", status: "live",
        billing_url: "https://resend.com/settings/billing", included_in: null, source: "estimated",
        note: "Billed once to the shared Tenfold Commerce Resend team, not per store.",
      },
      {
        id: "netlify", name: "Netlify", used_for: "Hosting, functions and Blobs storage",
        category: "fixed", billing_model: "monthly", status: "live",
        billing_url: "https://app.netlify.com/teams", included_in: null, source: "estimated",
        note: "Billed to the Tenfold Commerce Netlify team (HQ reads it from its own ledger).",
      },
    ],
  };
}
