import type { Config } from "@netlify/functions";
import { runRecovery } from "../shared/recovery.mts";

// Scheduled: emails people who left checkout an hour ago a free-proof link (see shared/recovery.mts).
// Scheduled functions run on the production deploy only. Set ABANDONED_CHECKOUT_EMAILS=off to stop it.
export default async () => {
  const run = await runRecovery();
  console.log("Abandoned checkouts:", JSON.stringify(run));
};

export const config: Config = { schedule: "*/15 * * * *" };
