import { getServiceClient } from "./supabase.js";
import { tick } from "./tick.js";

const CRON_INTERVAL_MS = parseInt(
  process.env.CRON_INTERVAL_MS ?? "300000",
  10
);

async function loop(): Promise<void> {
  const client = getServiceClient();
  await tick(client).catch((err) => console.error("Tick failed:", err));
  setTimeout(loop, CRON_INTERVAL_MS);
}

console.log(`Worker started. Polling every ${CRON_INTERVAL_MS / 1000}s`);
loop().catch((err) => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
