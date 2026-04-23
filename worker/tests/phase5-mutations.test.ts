import { describe, it, expect, beforeEach, vi } from "vitest";
import { serviceClient, cleanAll } from "./helpers";
import { applyMutationsAndSnapshot } from "../src/mutate";
import { sweepExpiredBlocks } from "../src/sweep";
import { tick } from "../src/tick";
import type Anthropic from "@anthropic-ai/sdk";
import type { Mutation } from "../src/schema";

const service = serviceClient();

async function createIntent(text: string = "test"): Promise<string> {
  const { data } = await service
    .from("user_intents")
    .insert({ intent_text: text, status: "processing" })
    .select("id")
    .single();
  return data!.id;
}

beforeEach(async () => {
  await cleanAll(service);
});

// ---------------------------------------------------------
// Mutations
// ---------------------------------------------------------
describe("applyMutationsAndSnapshot — mutations", () => {
  it("upsert with new semantic_key inserts a row", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:ai-industry",
        block_type: "trends",
        title: "AI Trends",
        content: { items: ["trend1"] },
        display_order: 0,
      },
    ], "Created AI trends");

    const { data } = await service
      .from("site_state")
      .select("*")
      .eq("semantic_key", "trends:ai-industry")
      .single();
    expect(data).not.toBeNull();
    expect(data!.title).toBe("AI Trends");
    expect(data!.source_intent_id).toBe(intentId);
  });

  it("upsert with existing semantic_key updates the row", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:ai-industry",
        block_type: "trends",
        title: "AI Trends v1",
        content: { version: 1 },
        display_order: 0,
      },
    ], "v1");

    const { data: before } = await service
      .from("site_state")
      .select("created_at, updated_at")
      .eq("semantic_key", "trends:ai-industry")
      .single();

    const intentId2 = await createIntent("update");
    await applyMutationsAndSnapshot(service, intentId2, [
      {
        action: "upsert",
        semantic_key: "trends:ai-industry",
        block_type: "trends",
        title: "AI Trends v2",
        content: { version: 2 },
        display_order: 0,
      },
    ], "v2");

    const { data: after } = await service
      .from("site_state")
      .select("title, created_at, updated_at")
      .eq("semantic_key", "trends:ai-industry")
      .single();

    expect(after!.title).toBe("AI Trends v2");
    expect(after!.created_at).toBe(before!.created_at);
    expect(after!.updated_at).not.toBe(before!.updated_at);
  });

  it("delete removes an existing row", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temp: 15 },
        display_order: 0,
      },
    ], "setup");

    const intentId2 = await createIntent("delete weather");
    await applyMutationsAndSnapshot(service, intentId2, [
      { action: "delete", semantic_key: "weather:stockholm" },
    ], "deleted weather");

    const { data } = await service
      .from("site_state")
      .select("id")
      .eq("semantic_key", "weather:stockholm");
    expect(data).toHaveLength(0);
  });

  it("delete with nonexistent key is a no-op", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      { action: "delete", semantic_key: "weather:nonexistent" },
    ], "no-op");
  });

  it("applies mixed upserts and deletes in one call", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: {},
        display_order: 0,
      },
      {
        action: "upsert",
        semantic_key: "trends:fintech",
        block_type: "trends",
        title: "Fintech",
        content: {},
        display_order: 1,
      },
    ], "setup");

    const intentId2 = await createIntent("mixed");
    await applyMutationsAndSnapshot(service, intentId2, [
      { action: "delete", semantic_key: "weather:stockholm" },
      {
        action: "upsert",
        semantic_key: "summary:q1-report",
        block_type: "summary",
        title: "Q1 Report",
        content: { text: "summary" },
        display_order: 2,
      },
    ], "mixed mutations");

    const { data } = await service
      .from("site_state")
      .select("semantic_key")
      .order("display_order");
    const keys = data!.map((r) => r.semantic_key);
    expect(keys).toEqual(["trends:fintech", "summary:q1-report"]);
  });

  it("marks intent as completed atomically with mutations", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:test",
        block_type: "trends",
        title: "Test",
        content: {},
        display_order: 0,
      },
    ], "Applied trends");

    const { data } = await service
      .from("user_intents")
      .select("status, result_summary")
      .eq("id", intentId)
      .single();
    expect(data!.status).toBe("completed");
    expect(data!.result_summary).toBe("Applied trends");
  });
});

// ---------------------------------------------------------
// TTL determinism
// ---------------------------------------------------------
describe("applyMutationsAndSnapshot — TTL", () => {
  it("trends block gets expires_at = now + 24h", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:test",
        block_type: "trends",
        title: "Test",
        content: {},
        display_order: 0,
      },
    ], "test");

    const { data } = await service
      .from("site_state")
      .select("created_at, expires_at")
      .eq("semantic_key", "trends:test")
      .single();

    const created = new Date(data!.created_at).getTime();
    const expires = new Date(data!.expires_at).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(23.99);
    expect(diffHours).toBeLessThan(24.01);
  });

  it("weather block gets expires_at = now + 1h", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "weather:test",
        block_type: "weather",
        title: "Test",
        content: {},
        display_order: 0,
      },
    ], "test");

    const { data } = await service
      .from("site_state")
      .select("created_at, expires_at")
      .eq("semantic_key", "weather:test")
      .single();

    const created = new Date(data!.created_at).getTime();
    const expires = new Date(data!.expires_at).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(0.99);
    expect(diffHours).toBeLessThan(1.01);
  });

  it("summary block gets expires_at = now + 72h", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "summary:test",
        block_type: "summary",
        title: "Test",
        content: {},
        display_order: 0,
      },
    ], "test");

    const { data } = await service
      .from("site_state")
      .select("created_at, expires_at")
      .eq("semantic_key", "summary:test")
      .single();

    const created = new Date(data!.created_at).getTime();
    const expires = new Date(data!.expires_at).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(71.99);
    expect(diffHours).toBeLessThan(72.01);
  });

  it("TTL is derived from block_type, ignores expires_at in content", async () => {
    const intentId = await createIntent();
    await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "weather:test",
        block_type: "weather",
        title: "Test",
        content: { expires_at: "2099-01-01T00:00:00Z" },
        display_order: 0,
      },
    ], "test");

    const { data } = await service
      .from("site_state")
      .select("created_at, expires_at")
      .eq("semantic_key", "weather:test")
      .single();

    const created = new Date(data!.created_at).getTime();
    const expires = new Date(data!.expires_at).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeLessThan(2);
  });
});

// ---------------------------------------------------------
// History snapshots
// ---------------------------------------------------------
describe("applyMutationsAndSnapshot — history", () => {
  it("snapshots all site_state rows under the same version", async () => {
    const intentId = await createIntent();
    const version = await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:ai",
        block_type: "trends",
        title: "AI",
        content: {},
        display_order: 0,
      },
      {
        action: "upsert",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: {},
        display_order: 1,
      },
    ], "test");

    const { data: history } = await service
      .from("site_state_history")
      .select("*")
      .eq("site_version", version);
    expect(history).toHaveLength(2);

    const keys = history!.map((h) => h.semantic_key).sort();
    expect(keys).toEqual(["trends:ai", "weather:stockholm"]);
  });

  it("registers version in site_versions with correct intent_id", async () => {
    const intentId = await createIntent();
    const version = await applyMutationsAndSnapshot(service, intentId, [
      {
        action: "upsert",
        semantic_key: "trends:test",
        block_type: "trends",
        title: "Test",
        content: {},
        display_order: 0,
      },
    ], "test");

    const { data } = await service
      .from("site_versions")
      .select("*")
      .eq("version", version)
      .single();
    expect(data!.intent_id).toBe(intentId);
  });

  it("consecutive snapshots have strictly increasing versions", async () => {
    const id1 = await createIntent("first");
    const v1 = await applyMutationsAndSnapshot(service, id1, [
      {
        action: "upsert",
        semantic_key: "trends:a",
        block_type: "trends",
        title: "A",
        content: {},
        display_order: 0,
      },
    ], "first");

    const id2 = await createIntent("second");
    const v2 = await applyMutationsAndSnapshot(service, id2, [
      {
        action: "upsert",
        semantic_key: "trends:b",
        block_type: "trends",
        title: "B",
        content: {},
        display_order: 1,
      },
    ], "second");

    expect(v2).toBeGreaterThan(v1);
  });

  it("empty surface after deleting all blocks produces a valid version", async () => {
    const id1 = await createIntent("create");
    await applyMutationsAndSnapshot(service, id1, [
      {
        action: "upsert",
        semantic_key: "weather:only",
        block_type: "weather",
        title: "Only",
        content: {},
        display_order: 0,
      },
    ], "setup");

    const id2 = await createIntent("delete all");
    const version = await applyMutationsAndSnapshot(service, id2, [
      { action: "delete", semantic_key: "weather:only" },
    ], "cleared");

    const { data: ver } = await service
      .from("site_versions")
      .select("version")
      .eq("version", version);
    expect(ver).toHaveLength(1);

    const { data: history } = await service
      .from("site_state_history")
      .select("id")
      .eq("site_version", version);
    expect(history).toHaveLength(0);
  });

  it("sweep + intent in same tick produce distinct ordered versions", async () => {
    const id1 = await createIntent("setup");
    await applyMutationsAndSnapshot(service, id1, [
      {
        action: "upsert",
        semantic_key: "weather:old",
        block_type: "weather",
        title: "Old",
        content: {},
        display_order: 0,
      },
    ], "setup");

    await service
      .from("site_state")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("semantic_key", "weather:old");

    await sweepExpiredBlocks(service);

    const id2 = await createIntent("new content");
    const intentVersion = await applyMutationsAndSnapshot(service, id2, [
      {
        action: "upsert",
        semantic_key: "trends:new",
        block_type: "trends",
        title: "New",
        content: {},
        display_order: 0,
      },
    ], "new content");

    const { data: versions } = await service
      .from("site_versions")
      .select("version, intent_id")
      .order("version", { ascending: true });

    const sweepVersion = versions!.find((v) => v.intent_id === null);
    expect(sweepVersion).toBeDefined();
    expect(sweepVersion!.version).toBeLessThan(intentVersion);
  });
});

// ---------------------------------------------------------
// Full tick with mocked Anthropic client
// ---------------------------------------------------------
describe("tick — full pipeline with LLM", () => {
  const VALID_RESPONSE = JSON.stringify({
    mutations: [
      {
        action: "upsert",
        semantic_key: "trends:ai-industry",
        block_type: "trends",
        title: "AI Industry Trends",
        content: { items: [{ text: "AI is growing fast" }] },
        display_order: 0,
      },
    ],
    summary: "Searched for AI trends and created a dashboard card",
  });

  function mockAnthropic(): Anthropic {
    return {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: "text", text: VALID_RESPONSE }],
          stop_reason: "end_turn",
        })),
      },
    } as unknown as Anthropic;
  }

  it("claim → processIntent → mutations → snapshot → completed", async () => {
    // Insert a pending intent (not pre-claimed — tick claims it)
    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "show me AI trends" })
      .select("id")
      .single();

    await tick(service, mockAnthropic());

    // Intent should be completed with summary
    const { data: updated } = await service
      .from("user_intents")
      .select("status, result_summary")
      .eq("id", intent!.id)
      .single();
    expect(updated!.status).toBe("completed");
    expect(updated!.result_summary).toBe(
      "Searched for AI trends and created a dashboard card"
    );

    // site_state should have the trends block
    const { data: blocks } = await service
      .from("site_state")
      .select("semantic_key, title, content, source_intent_id");
    expect(blocks).toHaveLength(1);
    expect(blocks![0].semantic_key).toBe("trends:ai-industry");
    expect(blocks![0].title).toBe("AI Industry Trends");
    expect(blocks![0].source_intent_id).toBe(intent!.id);

    // site_versions should have a version with intent_id
    const { data: versions } = await service
      .from("site_versions")
      .select("version, intent_id");
    expect(versions).toHaveLength(1);
    expect(versions![0].intent_id).toBe(intent!.id);

    // site_state_history should have the snapshot
    const { data: history } = await service
      .from("site_state_history")
      .select("semantic_key")
      .eq("site_version", versions![0].version);
    expect(history).toHaveLength(1);
    expect(history![0].semantic_key).toBe("trends:ai-industry");
  });
});
