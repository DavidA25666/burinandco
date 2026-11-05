import type { Config } from "@netlify/functions";
import { runFinerworksSync } from "../shared/finerworks-sync.mts";

// Scheduled: FinerWorks status, tracking and real cost for live orders in production.
// Scheduled functions run on the production deploy only.
export default async () => {
  const run = await runFinerworksSync();
  console.log("FinerWorks sync:", run.status, run.message);
};

export const config: Config = { schedule: "0 */6 * * *" };
