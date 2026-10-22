import { getStore, getDeployStore } from "@netlify/blobs";
import type { StyleId, CategoryId, SizeId, FrameId } from "./catalog.mts";

export type OrderStatus =
  | "awaiting_payment" | "paid" | "rendering" | "render_failed" | "needs_review"
  | "proof_sent" | "changes_requested" | "customer_approved" | "sent_to_print" | "archived";

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
  plaque: [string, string];
  photoKey: string;
  renders: { key: string; createdAt: string; note: string | null }[];
  changeRequests: { at: string; note: string; version: number }[];
  shipping?: {
    name: string;
    phone: string | null;
    address: { line1: string; line2?: string | null; city: string; state: string; postal_code: string; country: string };
  } | null;
  stripeSessionId?: string;
  printOrderRef?: string;
  printFile?: { key: string; version: number; width: number; height: number; dpi: number; createdAt: string } | null;
  printStatus?: "preparing" | "failed";
  printError?: string;
  lastError?: string;
  history: { at: string; event: string }[];
}

// Production data goes to the global store; previews and local dev stay isolated per deploy.
function pick(name: string) {
  const opts = { name, consistency: "strong" as const };
  return Netlify.context?.deploy?.context === "production" ? getStore(opts) : getDeployStore(opts);
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
