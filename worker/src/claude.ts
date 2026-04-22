import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { BLOCK_TYPES } from "./schema.js";

const MAX_TURNS = 10;

const SYSTEM_PROMPT = `You are the brain of a self-evolving website. Given a user intent and the current site state, decide what actions to take.

You have access to:
- web_search: Search the web for information
- web_fetch: Fetch content from a URL

BLOCK TYPES (you must use one of these):
${BLOCK_TYPES.map((t) => `- ${t}`).join("\n")}

SEMANTIC KEY FORMAT: {block_type}:{topic-slug}
- topic-slug must be lowercase, hyphenated, ≤40 chars
- Reuse existing keys when updating content (check current state)
- Examples: trends:ai-industry, weather:stockholm, summary:quarterly-earnings

Your job:
1. Analyze the intent
2. Use tools to gather information
3. Return a JSON response describing site_state mutations

Response format:
{
  "mutations": [
    {
      "action": "upsert",
      "semantic_key": "trends:ai-industry",
      "block_type": "trends",
      "title": "AI Industry Trends",
      "content": { "items": [...] },
      "display_order": 1
    }
  ],
  "summary": "Searched for AI trends and created a dashboard card with 5 key findings"
}

For deletions:
{
  "mutations": [
    { "action": "delete", "semantic_key": "weather:stockholm" }
  ],
  "summary": "Removed the Stockholm weather widget as requested"
}

Return ONLY the JSON object. No markdown, no code fences, no extra text.`;

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: unknown;
}

// Internal tracking with tool_use_id for pairing server results
interface TrackedToolCall extends ToolCall {
  tool_use_id: string;
}

export interface ClaudeResult {
  text: string;
  toolCalls: ToolCall[];
}

// Server tool result block types returned by the Anthropic API
const SERVER_TOOL_RESULT_TYPES = [
  "web_search_tool_result",
  "web_fetch_tool_result",
] as const;

/**
 * Run the agentic tool loop: send message to Claude, handle tool_use blocks,
 * re-send with tool results until Claude returns a final text response.
 *
 * Captures both client-side tool_use and server-side tool blocks
 * (server_tool_use / web_search_tool_result / web_fetch_tool_result)
 * for full audit trail.
 *
 * Enforces a turn limit to prevent runaway loops.
 */
export async function runClaudeToolLoop(
  client: Anthropic,
  intentText: string,
  currentState: Record<string, unknown>[],
): Promise<ClaudeResult> {
  const toolCalls: TrackedToolCall[] = [];

  const userContent = `CURRENT SITE STATE:\n${JSON.stringify(currentState, null, 2)}\n\nUSER INTENT: ${intentText}`;

  const messages: MessageParam[] = [
    { role: "user", content: userContent },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 5,
        },
      ],
    });

    // Walk all content blocks and capture everything
    const textParts: string[] = [];
    const clientToolUseBlocks: ToolUseBlock[] = [];

    for (const block of response.content) {
      const blockType = (block as any).type as string;

      if (blockType === "text") {
        textParts.push((block as any).text);
      } else if (blockType === "tool_use") {
        // Client-side tool use — we'd execute these if we had any
        clientToolUseBlocks.push(block as ToolUseBlock);
      } else if (blockType === "server_tool_use") {
        // Server-side tool invocation (web_search, web_fetch)
        const serverBlock = block as any;
        toolCalls.push({
          tool_use_id: serverBlock.id,
          tool_name: serverBlock.name,
          tool_input: serverBlock.input as Record<string, unknown>,
          tool_output: null, // paired result comes in a separate block
        });
      } else if (
        (SERVER_TOOL_RESULT_TYPES as readonly string[]).includes(blockType)
      ) {
        // Server-side tool result (web_search_tool_result, web_fetch_tool_result)
        const resultBlock = block as any;
        const toolUseId: string = resultBlock.tool_use_id;
        // Pair with the matching server_tool_use by tool_use_id
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if (toolCalls[i].tool_use_id === toolUseId) {
            toolCalls[i].tool_output = resultBlock.content;
            break;
          }
        }
      }
    }

    // If no client-side tool use, we're done — return the text
    if (response.stop_reason !== "tool_use" || clientToolUseBlocks.length === 0) {
      return {
        text: textParts.join("\n"),
        toolCalls,
      };
    }

    // Handle client-side tool use: build tool results
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of clientToolUseBlocks) {
      toolCalls.push({
        tool_use_id: toolUse.id,
        tool_name: toolUse.name,
        tool_input: toolUse.input as Record<string, unknown>,
        tool_output: null,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: "Tool executed.",
      });
    }

    // Append assistant response + tool results and loop
    messages.push({
      role: "assistant",
      content: response.content as ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: toolResults,
    });
  }

  throw new Error(`Tool loop exceeded ${MAX_TURNS} turns`);
}

/**
 * Log tool calls to processing_logs table.
 */
export async function logToolCalls(
  supabase: SupabaseClient,
  intentId: string,
  toolCalls: ToolCall[]
): Promise<void> {
  if (toolCalls.length === 0) return;

  const rows = toolCalls.map((tc) => ({
    intent_id: intentId,
    tool_name: tc.tool_name,
    tool_input: tc.tool_input,
    tool_output: tc.tool_output,
  }));

  const { error } = await supabase.from("processing_logs").insert(rows);
  if (error) {
    console.error("Failed to log tool calls:", error.message);
  }
}
