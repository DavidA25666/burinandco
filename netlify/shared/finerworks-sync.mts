// Every 6 hours: asks FinerWorks about live orders still in production or missing their cost, so HQ
// sees tracking and the real cost of goods without anyone clicking Refresh. Customers get their
// tracking email the first time FinerWorks reports it.
import { listOrders, type Order } from "./store.mts";
import { refreshOrder } from "./order-actions.mts";
import { opsStore } from "./ops-store.mts";

export const SYNC_JOB = { id: "finerworks-sync", name: "Pull FinerWorks status, tracking and cost", schedule: "Every 6 hours", everyMs: 6 * 3_600_000 };

export interface JobRun { at: string; status: "ok" | "error"; message: string }

/** Orders worth asking about: live FinerWorks orders from the last 60 days not yet delivered, or without their cost. */
export function needsSync(o: Order, nowMs = Date.now()) {
  const fw = o.finerworks;
  if (!fw || fw.testMode || fw.orderId == null || !o.sentToPrintAt) return false;
  if (nowMs - Date.parse(o.sentToPrintAt) > 60 * 86_400_000) return false;
  const delivered = fw.shipments?.some((s) => s.deliveredAt);
  return !delivered || fw.costCents == null;
}

export async function runFinerworksSync(): Promise<JobRun> {
  const at = new Date().toISOString();
  let run: JobRun;
  try {
    const due = (await listOrders()).filter((o) => needsSync(o));
    let problems = 0;
    for (const o of due) {
      const notes = await refreshOrder(o);
      if (notes.some((n) => /^FinerWorks: .*(fail|error|not found|HTTP)/i.test(n))) problems++;
    }
    run = { at, status: problems ? "error" : "ok", message: due.length ? `${due.length} order${due.length > 1 ? "s" : ""} checked${problems ? `, ${problems} with errors` : ""}` : "Nothing in production" };
  } catch (e) {
    run = { at, status: "error", message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  await opsStore().setJSON(`job/${SYNC_JOB.id}`, run).catch(() => {});
  return run;
}

export async function lastSyncRun(): Promise<JobRun | null> {
  return (await opsStore().get(`job/${SYNC_JOB.id}`, { type: "json" }).catch(() => null)) as JobRun | null;
}

/** The job as /api/ops/health reports it. */
export function syncJobView(last: JobRun | null, nowMs = Date.now()) {
  const next = last ? Date.parse(last.at) + SYNC_JOB.everyMs : nowMs;
  return {
    id: SYNC_JOB.id, name: SYNC_JOB.name, schedule: SYNC_JOB.schedule,
    lastRunAt: last?.at ?? null, lastStatus: last?.status ?? null, message: last?.message ?? "Not run yet",
    nextRunAt: new Date(Math.max(next, nowMs)).toISOString(),
  };
}
