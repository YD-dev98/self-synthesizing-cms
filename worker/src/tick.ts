import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepExpiredBlocks } from "./sweep.js";
import { claimPendingIntents } from "./claim.js";

/**
 * Single worker tick: sweep expired blocks, claim pending intents, process them.
 * Stateless — receives the client, does one pass, returns.
 */
export async function tick(client: SupabaseClient): Promise<void> {
  // Step 0: Sweep expired blocks (atomic — single RPC)
  const swept = await sweepExpiredBlocks(client);
  if (swept > 0) {
    console.log(`Swept ${swept} expired block(s)`);
  }

  // Step 1: Claim pending intents
  const intents = await claimPendingIntents(client);
  if (intents.length === 0) {
    return;
  }

  console.log(`Claimed ${intents.length} intent(s)`);

  // Step 2: Process each intent (stub — Phase 4+ will add LLM processing)
  for (const intent of intents) {
    try {
      // TODO: Phase 4 — LLM reasoning + tool loop
      // TODO: Phase 5 — Apply mutations + snapshot

      await client
        .from("user_intents")
        .update({
          status: "completed",
          result_summary: "Stub: no processing yet",
        })
        .eq("id", intent.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process intent ${intent.id}: ${message}`);

      await client
        .from("user_intents")
        .update({ status: "failed", error: message })
        .eq("id", intent.id);
    }
  }
}
