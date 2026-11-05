import { createHmac, randomUUID } from "node:crypto";
import { blobs, env } from "./setup.ts";
import type { Order } from "../netlify/shared/store.mts";

export const SECRET = "test-secret-for-the-burin-admin-plug-0123456789";

/** Signs a request exactly like Tenfold HQ (contract §1). */
export function signed(method: "GET" | "POST", pathAndQuery: string, body = "", opts: { ts?: number; requestId?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = "v1=" + createHmac("sha256", SECRET).update(`${ts}.${method}.${pathAndQuery}.${body}`).digest("hex");
  return new Request(`https://burinandco.com${pathAndQuery}`, {
    method,
    headers: { "X-Portfolio-Timestamp": ts, "X-Portfolio-Signature": sig, "X-Portfolio-Request-Id": opts.requestId ?? randomUUID(), "content-type": "application/json" },
    ...(method === "POST" ? { body } : {}),
  });
}

export function useSecret() {
  env.set("PORTFOLIO_OPS_SECRET", SECRET);
  env.set("SITE_SECRET", "site-secret-for-tests-only-0123456789");
}

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();

export function order(over: Partial<Order> = {}): Order {
  const id = over.id ?? randomUUID();
  return {
    id, createdAt: day(3), status: "sent_to_print",
    customer: { name: "Maya Rivers", email: "maya@example.com" },
    category: "automobile", style: "studio", size: "16x20", frame: "walnut", collector: false,
    price: 39500, notes: "", plaque: ["", ""], photoKey: `photo/${id}`, renders: [{ key: `render/${id}/1`, createdAt: day(3), note: null }],
    changeRequests: [], history: [{ at: day(3), event: "Order started" }],
    shipping: { name: "Maya Rivers", phone: "617-555-0100", address: { line1: "1 Main St", city: "Boston", state: "MA", postal_code: "02101", country: "US" } },
    card: { customer: "cus_1", paymentMethod: "pm_1" }, paidAt: day(2), paymentIntentId: `pi_${id.slice(0, 8)}`, livemode: true,
    proofSentAt: day(2.5), sentToPrintAt: day(1),
    ...over,
  };
}

export function seed(...orders: Order[]) {
  if (!blobs.has("orders")) blobs.set("orders", new Map());
  for (const o of orders) blobs.get("orders")!.set(`order/${o.id}`, JSON.stringify(o));
}

export const readOrder = (id: string) => JSON.parse(blobs.get("orders")!.get(`order/${id}`)!) as Order;
