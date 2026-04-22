import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MutationResponseSchema, type MutationResponse } from "./schema.js";
import { runClaudeToolLoop, logToolCalls } from "./claude.js";

const MAX_VALIDATION_ATTEMPTS = 3;

/**
 * Process a single intent: call Claude, validate response, retry on failure.
 * Returns the validated mutation response.
 * Throws if all validation attempts are exhausted.
 */
export async function processIntent(
  anthropic: Anthropic,
  supabase: SupabaseClient,
  intentId: string,
  intentText: string,
  currentState: Record<string, unknown>[]
): Promise<MutationResponse> {
  // Run Claude with tool loop
  const result = await runClaudeToolLoop(anthropic, intentText, currentState);

  // Log tool calls
  await logToolCalls(supabase, intentId, result.toolCalls);

  // Parse and validate with self-correction loop
  let lastText = result.text;
  const validationErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    try {
      const parsed = JSON.parse(lastText);
      const validated = MutationResponseSchema.parse(parsed);
      return validated;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      validationErrors.push(`Attempt ${attempt}: ${errorMessage}`);

      // Log validation failure
      await supabase.from("processing_logs").insert({
        intent_id: intentId,
        tool_name: "schema_validation",
        tool_input: { attempt, raw_response: lastText },
        tool_output: { error: errorMessage },
      });

      // If we have retries left, ask Claude to fix it
      if (attempt < MAX_VALIDATION_ATTEMPTS) {
        const correctionResult = await runClaudeToolLoop(
          anthropic,
          `Your previous response was invalid. Error: ${errorMessage}\n\nOriginal intent: ${intentText}\n\nYour invalid response:\n${lastText}\n\nPlease return a corrected JSON response.`,
          currentState
        );
        await logToolCalls(supabase, intentId, correctionResult.toolCalls);
        lastText = correctionResult.text;
      }
    }
  }

  throw new Error(
    `Validation failed after ${MAX_VALIDATION_ATTEMPTS} attempts:\n${validationErrors.join("\n")}`
  );
}
