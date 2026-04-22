import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Local Supabase defaults (from `supabase start`)
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY);
}

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

/**
 * Clean all rows from all tables (service role).
 * Call in beforeEach to isolate tests.
 */
export async function cleanAll(client: SupabaseClient): Promise<void> {
  // Order matters: respect foreign keys
  await client.from("site_state_history").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await client.from("processing_logs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await client.from("site_state").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await client.from("user_intents").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}
