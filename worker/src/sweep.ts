import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Atomically delete expired blocks and snapshot the result.
 * Runs entirely in Postgres — one RPC, one transaction.
 *
 * @returns Number of expired blocks deleted (0 = no-op, no snapshot produced).
 */
export async function sweepExpiredBlocks(
  client: SupabaseClient
): Promise<number> {
  const { data, error } = await client.rpc("sweep_expired_blocks");

  if (error) throw new Error(`Sweep failed: ${error.message}`);

  return data as number;
}
