import { describe, it, expect, beforeEach } from "vitest";
import { serviceClient, cleanAll } from "./helpers";
import { sweepExpiredBlocks } from "../src/sweep";
import { claimPendingIntents } from "../src/claim";

const service = serviceClient();

beforeEach(async () => {
  await cleanAll(service);
});

// ---------------------------------------------------------
// Sweep
// ---------------------------------------------------------
describe("sweepExpiredBlocks", () => {
  it("deletes rows where expires_at < now()", async () => {
    // Insert an expired block
    await service.from("site_state").insert({
      semantic_key: "weather:old",
      block_type: "weather",
      content: { temp: 5 },
      display_order: 0,
      expires_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });

    const count = await sweepExpiredBlocks(service);
    expect(count).toBe(1);

    const { data } = await service.from("site_state").select("id");
    expect(data).toHaveLength(0);
  });

  it("leaves non-expired rows untouched", async () => {
    await service.from("site_state").insert({
      semantic_key: "weather:fresh",
      block_type: "weather",
      content: { temp: 20 },
      display_order: 0,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), // 1h from now
    });

    const count = await sweepExpiredBlocks(service);
    expect(count).toBe(0);

    const { data } = await service.from("site_state").select("id");
    expect(data).toHaveLength(1);
  });

  it("leaves rows with no expires_at untouched", async () => {
    await service.from("site_state").insert({
      semantic_key: "summary:evergreen",
      block_type: "summary",
      content: { text: "permanent" },
      display_order: 0,
      expires_at: null,
    });

    const count = await sweepExpiredBlocks(service);
    expect(count).toBe(0);

    const { data } = await service.from("site_state").select("id");
    expect(data).toHaveLength(1);
  });

  it("produces a versioned snapshot when rows are deleted", async () => {
    await service.from("site_state").insert([
      {
        semantic_key: "weather:expired",
        block_type: "weather",
        content: {},
        display_order: 0,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        semantic_key: "trends:fresh",
        block_type: "trends",
        content: {},
        display_order: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ]);

    await sweepExpiredBlocks(service);

    // site_versions should have one entry with NULL intent_id
    const { data: versions } = await service
      .from("site_versions")
      .select("*");
    expect(versions).toHaveLength(1);
    expect(versions![0].intent_id).toBeNull();

    // History should have only the surviving block
    const { data: history } = await service
      .from("site_state_history")
      .select("*");
    expect(history).toHaveLength(1);
    expect(history![0].semantic_key).toBe("trends:fresh");
    expect(history![0].site_version).toBe(versions![0].version);
  });

  it("does not produce a snapshot when no rows are deleted", async () => {
    await service.from("site_state").insert({
      semantic_key: "trends:safe",
      block_type: "trends",
      content: {},
      display_order: 0,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await sweepExpiredBlocks(service);

    const { data: versions } = await service
      .from("site_versions")
      .select("version");
    expect(versions).toHaveLength(0);

    const { data: history } = await service
      .from("site_state_history")
      .select("id");
    expect(history).toHaveLength(0);
  });

  it("snapshot reflects post-deletion state", async () => {
    await service.from("site_state").insert([
      {
        semantic_key: "weather:gone1",
        block_type: "weather",
        content: {},
        display_order: 0,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        semantic_key: "weather:gone2",
        block_type: "weather",
        content: {},
        display_order: 1,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        semantic_key: "summary:stays",
        block_type: "summary",
        content: { text: "hi" },
        display_order: 2,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ]);

    await sweepExpiredBlocks(service);

    const { data: history } = await service
      .from("site_state_history")
      .select("semantic_key");
    expect(history).toHaveLength(1);
    expect(history![0].semantic_key).toBe("summary:stays");
  });

  it("records empty surface when sweep deletes the last block", async () => {
    await service.from("site_state").insert({
      semantic_key: "weather:only",
      block_type: "weather",
      content: {},
      display_order: 0,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    await sweepExpiredBlocks(service);

    // Version should exist
    const { data: versions } = await service
      .from("site_versions")
      .select("version");
    expect(versions).toHaveLength(1);

    // But history should have zero rows — empty surface
    const { data: history } = await service
      .from("site_state_history")
      .select("id")
      .eq("site_version", versions![0].version);
    expect(history).toHaveLength(0);

    // This is distinguishable from "version doesn't exist"
    // because the version row exists in site_versions
  });
});

// ---------------------------------------------------------
// Claim
// ---------------------------------------------------------
describe("claimPendingIntents", () => {
  it("claims oldest intents first when batch is limited", async () => {
    // Insert 3 intents with clearly separated timestamps
    await service.from("user_intents").insert([
      { intent_text: "oldest", created_at: "2026-01-01T00:00:00Z" },
      { intent_text: "middle", created_at: "2026-01-02T00:00:00Z" },
      { intent_text: "newest", created_at: "2026-01-03T00:00:00Z" },
    ]);

    // Claim only 2 — should pick the two oldest
    const claimed = await claimPendingIntents(service, 2);
    expect(claimed).toHaveLength(2);

    const claimedTexts = claimed.map((c) => c.intent_text).sort();
    expect(claimedTexts).toEqual(["middle", "oldest"]);

    // Newest should still be pending
    const { data: remaining } = await service
      .from("user_intents")
      .select("intent_text, status")
      .eq("status", "pending");
    expect(remaining).toHaveLength(1);
    expect(remaining![0].intent_text).toBe("newest");
  });

  it("respects batch size limit", async () => {
    for (let i = 0; i < 5; i++) {
      await service
        .from("user_intents")
        .insert({ intent_text: `intent-${i}` });
    }

    const claimed = await claimPendingIntents(service, 2);
    expect(claimed).toHaveLength(2);

    // 3 should still be pending
    const { data: remaining } = await service
      .from("user_intents")
      .select("id")
      .eq("status", "pending");
    expect(remaining).toHaveLength(3);
  });

  it("sets status to processing after claiming", async () => {
    await service
      .from("user_intents")
      .insert({ intent_text: "test" });

    const claimed = await claimPendingIntents(service, 5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("processing");

    // Verify in DB
    const { data } = await service
      .from("user_intents")
      .select("status")
      .eq("id", claimed[0].id)
      .single();
    expect(data!.status).toBe("processing");
  });

  it("does not claim already-processing intents", async () => {
    await service
      .from("user_intents")
      .insert({ intent_text: "busy", status: "processing" });

    const claimed = await claimPendingIntents(service, 5);
    expect(claimed).toHaveLength(0);
  });

  it("does not claim completed intents", async () => {
    await service
      .from("user_intents")
      .insert({ intent_text: "done", status: "completed" });

    const claimed = await claimPendingIntents(service, 5);
    expect(claimed).toHaveLength(0);
  });

  it("does not claim failed intents", async () => {
    await service
      .from("user_intents")
      .insert({ intent_text: "broken", status: "failed" });

    const claimed = await claimPendingIntents(service, 5);
    expect(claimed).toHaveLength(0);
  });

  it("concurrent claims never return the same intent", async () => {
    // Insert 4 intents
    for (let i = 0; i < 4; i++) {
      await service
        .from("user_intents")
        .insert({ intent_text: `concurrent-${i}` });
    }

    // Two concurrent claims of 3 each
    const [batch1, batch2] = await Promise.all([
      claimPendingIntents(service, 3),
      claimPendingIntents(service, 3),
    ]);

    // Combined should have all 4, with no overlap
    const allIds = [...batch1.map((i) => i.id), ...batch2.map((i) => i.id)];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(4);
    expect(allIds).toHaveLength(4);
  });

  it("returns empty array when no pending intents", async () => {
    const claimed = await claimPendingIntents(service, 5);
    expect(claimed).toHaveLength(0);
  });
});
