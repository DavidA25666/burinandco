import { getStore } from "@netlify/blobs";
import type { StyleId, CategoryId, SizeId, FrameId } from "./catalog.mts";

export type OrderStatus =
  | "awaiting_card" | "card_saved" | "awaiting_payment" | "paid" | "rendering" | "render_failed" | "needs_review"
  | "proof_sent" | "changes_requested" | "payment_due" | "customer_approved" | "sent_to_print" | "archived" | "refunded";

export interface Utm { source: string | null; medium: string | null; campaign: string | null; content: string | null; referrer?: string | null; landedAt?: string | null }

export interface Order {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: OrderStatus;
  customer: { name: string; email: string };
  category: CategoryId;
  style: StyleId;
  size: SizeId;
  frame: FrameId;
  collector: boolean;
  price: number;
  notes: string;
  plaque: [string, string]; // Plaques are retired; older orders may still have one.
  caption?: string; // Optional line printed under the art.
  photoKey: string;
  renders: { key: string; createdAt: string; note: string | null }[];
  changeRequests: { at: string; note: string; version: number }[];
  shipping?: {
    name: string;
    phone: string | null;
    address: { line1: string; line2?: string | null; city: string; state: string; postal_code: string; country: string };
  } | null;
  stripeSessionId?: string;
  // Card saved at order time and charged when the customer approves the proof.
  card?: { customer: string; paymentMethod: string } | null;
  chargeAttempts?: number;
  paymentIntentId?: string;
  paidAt?: string;
  printOrderRef?: string;
  // caption: the caption typeset into this file ("" for none). Missing on files made before it was recorded.
  printFile?: { key: string; version: number; width: number; height: number; dpi: number; caption?: string; createdAt: string } | null;
  // Set when the order went to FinerWorks through the API (printOrderRef holds the readable reference).
  finerworks?: {
    orderId: string | number | null; confirmationId: string | null; testMode: boolean; productCode: string; printVersion: number;
    // From FinerWorks' order status and order list (refresh_status, and the sync every 6 hours).
    status?: string | null; checkedAt?: string;
    shipments?: { trackingNumber: string | null; trackingUrl: string | null; carrier: string | null; shippedAt: string | null; deliveredAt: string | null }[];
    costCents?: number | null;        // what FinerWorks charged for the order: the actual cost of goods
  } | null;
  finerworksError?: { at: string; message: string } | null; // the last failed Send to FinerWorks
  shippingEmailSentAt?: string;
  testOverride?: boolean | null;      // set by "Mark as test" in HQ; wins over the automatic rules
  printStatus?: "preparing" | "failed";
  printError?: string;
  lastError?: string;
  history: { at: string; event: string }[];
  // Added for Tenfold HQ. All optional, so older orders still read.
  livemode?: boolean;                 // false when the order was paid with Stripe test keys
  utm?: { first: Utm | null; last: Utm | null } | null;
  buyerGeo?: { city: string | null; region: string | null; country: string | null; lat: number | null; lng: number | null } | null;
  stripeFeeCents?: number;            // the real fee from Stripe's balance transaction
  chargeId?: string;
  refundedCents?: number;
  refundedAt?: string;
  proofSentAt?: string;               // first proof sent
  sentToPrintAt?: string;
  // Meta ads: the buyer's cookie choice at checkout, and what CAPI needs (only kept with consent).
  // Abandoned-checkout recovery. recovery: the "we'll draw it free" email went out for this unfinished
  // checkout. freeProof: the proof was drawn with no card on file; the card is taken on approval.
  recovery?: { sentAt: string } | null;
  freeProof?: { startedAt: string; via: "order" | "lead" } | null;
  ads?: { consent: boolean; fbp?: string | null; fbc?: string | null; ip?: string | null; ua?: string | null; url?: string | null; purchaseSentAt?: string } | null;
}

// Production data goes to the global store. Previews share a separate "-preview" store, so
// test orders survive a new preview build but never mix with real ones.
function pick(name: string) {
  const production = Netlify.context?.deploy?.context === "production";
  return getStore({ name: production ? name : `${name}-preview`, consistency: "strong" });
}
export const ordersStore = () => pick("orders");
export const filesStore = () => pick("files");
export const labStore = () => pick("lab");

export async function getOrder(id: string): Promise<Order | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return ordersStore().get(`order/${id}`, { type: "json" });
}

export async function saveOrder(order: Order) {
  order.updatedAt = new Date().toISOString();
  await ordersStore().setJSON(`order/${order.id}`, order);
}

export function log(order: Order, event: string) {
  order.history.push({ at: new Date().toISOString(), event });
}

export async function listOrders(): Promise<Order[]> {
  const store = ordersStore();
  const { blobs } = await store.list({ prefix: "order/" });
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Order | null>));
  return all.filter((o): o is Order => !!o).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
