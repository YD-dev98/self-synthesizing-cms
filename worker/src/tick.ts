import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepExpiredBlocks } from "./sweep.js";
import { claimPendingIntents } from "./claim.js";
import { processIntent } from "./processor.js";
import { applyMutationsAndSnapshot } from "./mutate.js";

/**
 * Single worker tick: sweep expired blocks, claim pending intents, process them.
 * Stateless — receives clients, does one pass, returns.
 *
 * @param anthropic - Pass null to use stub processing (for tests without LLM).
 */
export async function tick(
  client: SupabaseClient,
  anthropic?: Anthropic | null
): Promise<void> {
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

  // Step 2: Process each intent
  for (const intent of intents) {
    try {
      if (anthropic) {
        // Read current site state for LLM context
        const { data: currentState } = await client
          .from("site_state")
          .select("semantic_key, block_type, title, content, display_order")
          .order("display_order");

        // LLM reasoning + validation
        const result = await processIntent(
          anthropic,
          client,
          intent.id,
          intent.intent_text,
          (currentState ?? []) as Record<string, unknown>[]
        );

        // Apply mutations + snapshot + mark completed (atomic RPC)
        await applyMutationsAndSnapshot(
          client, intent.id, result.mutations, result.summary
        );
      } else {
        // Stub mode — no LLM, just mark completed
        await client
          .from("user_intents")
          .update({
            status: "completed",
            result_summary: "Stub: no processing yet",
          })
          .eq("id", intent.id);
      }
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
