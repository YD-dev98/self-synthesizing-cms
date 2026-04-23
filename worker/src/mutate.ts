import type { SupabaseClient } from "@supabase/supabase-js";
import type { MutationResponse } from "./schema.js";

/**
 * Apply validated mutations to site_state, snapshot to history,
 * and mark the intent as completed — all in one atomic transaction.
 *
 * @returns The allocated site_version number.
 */
export async function applyMutationsAndSnapshot(
  client: SupabaseClient,
  intentId: string,
  mutations: MutationResponse["mutations"],
  resultSummary: string
): Promise<number> {
  const { data, error } = await client.rpc("apply_mutations_and_snapshot", {
    mutations: mutations,
    p_intent_id: intentId,
    p_result_summary: resultSummary,
  });

  if (error) {
    throw new Error(`Failed to apply mutations: ${error.message}`);
  }

  return data as number;
}
