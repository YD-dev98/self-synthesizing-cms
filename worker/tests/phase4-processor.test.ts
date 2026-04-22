import { describe, it, expect, beforeEach, vi } from "vitest";
import { serviceClient, cleanAll } from "./helpers";
import { processIntent } from "../src/processor";
import type Anthropic from "@anthropic-ai/sdk";

const service = serviceClient();

beforeEach(async () => {
  await cleanAll(service);
});

// Helper: create a mock Anthropic client that returns canned responses
function mockAnthropic(responses: Array<{
  content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>;
  stop_reason: string;
}>): Anthropic {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const response = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        return response;
      }),
    },
  } as unknown as Anthropic;
}

const VALID_RESPONSE = JSON.stringify({
  mutations: [
    {
      action: "upsert",
      semantic_key: "trends:ai-industry",
      block_type: "trends",
      title: "AI Industry Trends",
      content: { items: [{ text: "AI is growing" }] },
      display_order: 0,
    },
  ],
  summary: "Created AI trends card",
});

const INVALID_RESPONSE = JSON.stringify({
  mutations: [
    {
      action: "upsert",
      semantic_key: "INVALID KEY",
      block_type: "trends",
      title: "Bad",
      content: {},
      display_order: 0,
    },
  ],
  summary: "Bad response",
});

// ---------------------------------------------------------
// Self-correction
// ---------------------------------------------------------
describe("processIntent — self-correction", () => {
  it("returns validated response on first try", async () => {
    const anthropic = mockAnthropic([
      { content: [{ type: "text", text: VALID_RESPONSE }], stop_reason: "end_turn" },
    ]);

    // Seed an intent
    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    const result = await processIntent(
      anthropic, service, intent!.id, "test", []
    );

    expect(result.mutations).toHaveLength(1);
    expect(result.summary).toBe("Created AI trends card");
  });

  it("succeeds on attempt 2 after invalid first response", async () => {
    const anthropic = mockAnthropic([
      // First call: invalid
      { content: [{ type: "text", text: INVALID_RESPONSE }], stop_reason: "end_turn" },
      // Second call (correction): valid
      { content: [{ type: "text", text: VALID_RESPONSE }], stop_reason: "end_turn" },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    const result = await processIntent(
      anthropic, service, intent!.id, "test", []
    );

    expect(result.mutations).toHaveLength(1);

    // Should have logged 1 validation failure
    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "schema_validation");
    expect(logs).toHaveLength(1);
    expect(logs![0].tool_input).toHaveProperty("attempt", 1);
  });

  it("fails after 3 invalid responses", async () => {
    const anthropic = mockAnthropic([
      { content: [{ type: "text", text: INVALID_RESPONSE }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: INVALID_RESPONSE }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: INVALID_RESPONSE }], stop_reason: "end_turn" },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await expect(
      processIntent(anthropic, service, intent!.id, "test", [])
    ).rejects.toThrow(/Validation failed after 3 attempts/);

    // Should have logged 3 validation failures
    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "schema_validation");
    expect(logs).toHaveLength(3);
  });

  it("handles malformed JSON from Claude", async () => {
    const anthropic = mockAnthropic([
      { content: [{ type: "text", text: "not json at all" }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: VALID_RESPONSE }], stop_reason: "end_turn" },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    const result = await processIntent(
      anthropic, service, intent!.id, "test", []
    );
    expect(result.mutations).toHaveLength(1);
  });
});

// ---------------------------------------------------------
// Tool loop
// ---------------------------------------------------------
describe("processIntent — tool loop", () => {
  it("handles tool_use then final text response", async () => {
    const anthropic = mockAnthropic([
      // First response: tool use
      {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "web_search",
            input: { query: "AI trends 2026" },
          },
        ],
        stop_reason: "tool_use",
      },
      // Second response: final text
      {
        content: [{ type: "text", text: VALID_RESPONSE }],
        stop_reason: "end_turn",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "show AI trends", status: "processing" })
      .select("id")
      .single();

    const result = await processIntent(
      anthropic, service, intent!.id, "show AI trends", []
    );

    expect(result.mutations).toHaveLength(1);

    // Tool call should be logged
    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "web_search");
    expect(logs).toHaveLength(1);
    expect(logs![0].tool_input).toEqual({ query: "AI trends 2026" });
  });

  it("logs each tool call with correct intent_id", async () => {
    const anthropic = mockAnthropic([
      {
        content: [
          { type: "tool_use", id: "t1", name: "web_search", input: { query: "search 1" } },
          { type: "tool_use", id: "t2", name: "web_search", input: { query: "search 2" } },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: VALID_RESPONSE }],
        stop_reason: "end_turn",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await processIntent(anthropic, service, intent!.id, "test", []);

    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "web_search");
    expect(logs).toHaveLength(2);
  });

  it("captures server_tool_use and web_search_tool_result blocks", async () => {
    const anthropic = mockAnthropic([
      {
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_01",
            name: "web_search",
            input: { query: "AI trends" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_01",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/ai",
                title: "AI Trends 2026",
                encrypted_content: "abc123",
                page_age: "April 2026",
              },
            ],
          },
          { type: "text", text: VALID_RESPONSE },
        ],
        stop_reason: "end_turn",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await processIntent(anthropic, service, intent!.id, "test", []);

    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "web_search");
    expect(logs).toHaveLength(1);
    expect(logs![0].tool_input).toEqual({ query: "AI trends" });
    // Output should contain the search results
    expect(logs![0].tool_output).toEqual([
      {
        type: "web_search_result",
        url: "https://example.com/ai",
        title: "AI Trends 2026",
        encrypted_content: "abc123",
        page_age: "April 2026",
      },
    ]);
  });

  it("captures web_fetch_tool_result blocks", async () => {
    const anthropic = mockAnthropic([
      {
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_02",
            name: "web_fetch",
            input: { url: "https://example.com/article" },
          },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_02",
            content: {
              type: "web_fetch_result",
              url: "https://example.com/article",
              content: {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: "Article text" },
                title: "Article Title",
              },
              retrieved_at: "2026-04-22T10:00:00Z",
            },
          },
          { type: "text", text: VALID_RESPONSE },
        ],
        stop_reason: "end_turn",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await processIntent(anthropic, service, intent!.id, "test", []);

    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .eq("tool_name", "web_fetch");
    expect(logs).toHaveLength(1);
    expect(logs![0].tool_input).toEqual({ url: "https://example.com/article" });
    expect(logs![0].tool_output).toHaveProperty("type", "web_fetch_result");
  });

  it("pairs interleaved server tool results to correct invocations", async () => {
    // Regression: two server_tool_use blocks with results arriving in reverse order.
    // Before the fix, pairing matched on "first null output" which would assign
    // the fetch result to the search invocation.
    const anthropic = mockAnthropic([
      {
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_search",
            name: "web_search",
            input: { query: "AI trends" },
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_fetch",
            name: "web_fetch",
            input: { url: "https://example.com/ai" },
          },
          // Results arrive in REVERSE order — fetch result first
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_fetch",
            content: {
              type: "web_fetch_result",
              url: "https://example.com/ai",
              content: { type: "document", source: { type: "text", data: "Article" } },
              retrieved_at: "2026-04-22T00:00:00Z",
            },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_search",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/ai",
                title: "AI Trends",
                encrypted_content: "enc123",
                page_age: "April 2026",
              },
            ],
          },
          { type: "text", text: VALID_RESPONSE },
        ],
        stop_reason: "end_turn",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await processIntent(anthropic, service, intent!.id, "test", []);

    const { data: logs } = await service
      .from("processing_logs")
      .select("*")
      .eq("intent_id", intent!.id)
      .order("created_at", { ascending: true });

    expect(logs).toHaveLength(2);

    // Find each by tool_name
    const searchLog = logs!.find((l) => l.tool_name === "web_search");
    const fetchLog = logs!.find((l) => l.tool_name === "web_fetch");

    // Search invocation should have search results, not fetch results
    expect(searchLog).toBeDefined();
    expect(searchLog!.tool_input).toEqual({ query: "AI trends" });
    expect(searchLog!.tool_output).toBeInstanceOf(Array);
    expect(searchLog!.tool_output[0]).toHaveProperty("type", "web_search_result");

    // Fetch invocation should have fetch results, not search results
    expect(fetchLog).toBeDefined();
    expect(fetchLog!.tool_input).toEqual({ url: "https://example.com/ai" });
    expect(fetchLog!.tool_output).toHaveProperty("type", "web_fetch_result");
  });

  it("throws when turn limit is exceeded", async () => {
    // Always return tool_use — loop should hit the limit
    const anthropic = mockAnthropic([
      {
        content: [
          { type: "tool_use", id: "t1", name: "web_search", input: { query: "loop" } },
        ],
        stop_reason: "tool_use",
      },
    ]);

    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "processing" })
      .select("id")
      .single();

    await expect(
      processIntent(anthropic, service, intent!.id, "test", [])
    ).rejects.toThrow(/exceeded.*turns/i);
  });
});
