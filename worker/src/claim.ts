import type { SupabaseClient } from "@supabase/supabase-js";

export interface ClaimedIntent {
  id: string;
  intent_text: string;
  status: string;
  created_at: string;
  processed_at: string | null;
  result_summary: string | null;
  error: string | null;
}

/**
 * Atomically claim up to `batchSize` pending intents.
 * Uses CTE + FOR UPDATE SKIP LOCKED to prevent double-processing.
 */
export async function claimPendingIntents(
  client: SupabaseClient,
  batchSize: number = 5
): Promise<ClaimedIntent[]> {
  const { data, error } = await client.rpc("claim_pending_intents", {
    batch_size: batchSize,
  });

  if (error) throw new Error(`Claim failed: ${error.message}`);

  return (data ?? []) as ClaimedIntent[];
}
