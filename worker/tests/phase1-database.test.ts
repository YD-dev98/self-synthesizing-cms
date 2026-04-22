import { describe, it, expect, beforeEach } from "vitest";
import { anonClient, serviceClient, cleanAll } from "./helpers";

const service = serviceClient();
const anon = anonClient();

beforeEach(async () => {
  await cleanAll(service);
});

// ---------------------------------------------------------
// RLS: anon role
// ---------------------------------------------------------
describe("RLS — anon role", () => {
  it("can SELECT from site_state", async () => {
    const { error } = await anon.from("site_state").select("*");
    expect(error).toBeNull();
  });

  it("cannot INSERT into site_state", async () => {
    const { error } = await anon.from("site_state").insert({
      semantic_key: "trends:test",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
  });

  it("cannot UPDATE site_state", async () => {
    // Seed a row with service role
    await service.from("site_state").insert({
      semantic_key: "trends:test",
      block_type: "trends",
      content: {},
      display_order: 0,
    });

    const { error } = await anon
      .from("site_state")
      .update({ title: "hacked" })
      .eq("semantic_key", "trends:test");
    // RLS should block — either error or zero affected rows
    const { data } = await service
      .from("site_state")
      .select("title")
      .eq("semantic_key", "trends:test")
      .single();
    expect(data?.title).toBeNull();
  });

  it("cannot DELETE from site_state", async () => {
    await service.from("site_state").insert({
      semantic_key: "trends:test",
      block_type: "trends",
      content: {},
      display_order: 0,
    });

    await anon.from("site_state").delete().eq("semantic_key", "trends:test");

    // Row should still exist
    const { data } = await service
      .from("site_state")
      .select("id")
      .eq("semantic_key", "trends:test");
    expect(data).toHaveLength(1);
  });

  it("cannot SELECT from user_intents", async () => {
    await service.from("user_intents").insert({ intent_text: "secret" });

    const { data } = await anon.from("user_intents").select("*");
    expect(data).toHaveLength(0);
  });

  it("cannot INSERT into user_intents", async () => {
    const { error } = await anon
      .from("user_intents")
      .insert({ intent_text: "sneaky" });
    expect(error).not.toBeNull();
  });

  it("cannot SELECT from processing_logs", async () => {
    const { data } = await anon.from("processing_logs").select("*");
    expect(data).toHaveLength(0);
  });

  it("cannot INSERT into processing_logs", async () => {
    const { error } = await anon.from("processing_logs").insert({
      tool_name: "web_search",
    });
    expect(error).not.toBeNull();
  });

  it("cannot SELECT from site_state_history", async () => {
    const { data } = await anon.from("site_state_history").select("*");
    expect(data).toHaveLength(0);
  });

  it("cannot INSERT into site_state_history", async () => {
    const { error } = await anon.from("site_state_history").insert({
      site_version: 1,
      semantic_key: "trends:test",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------
// RLS: service role
// ---------------------------------------------------------
describe("RLS — service role", () => {
  it("has full CRUD on user_intents", async () => {
    // Insert
    const { data: inserted, error: insertErr } = await service
      .from("user_intents")
      .insert({ intent_text: "test intent" })
      .select()
      .single();
    expect(insertErr).toBeNull();
    expect(inserted?.intent_text).toBe("test intent");

    // Select
    const { data: selected } = await service
      .from("user_intents")
      .select("*")
      .eq("id", inserted!.id);
    expect(selected).toHaveLength(1);

    // Update
    const { error: updateErr } = await service
      .from("user_intents")
      .update({ status: "processing" })
      .eq("id", inserted!.id);
    expect(updateErr).toBeNull();

    // Delete
    const { error: deleteErr } = await service
      .from("user_intents")
      .delete()
      .eq("id", inserted!.id);
    expect(deleteErr).toBeNull();
  });

  it("has full CRUD on site_state", async () => {
    const { data: inserted, error: insertErr } = await service
      .from("site_state")
      .insert({
        semantic_key: "weather:stockholm",
        block_type: "weather",
        content: { temp: 15 },
        display_order: 1,
      })
      .select()
      .single();
    expect(insertErr).toBeNull();
    expect(inserted?.semantic_key).toBe("weather:stockholm");

    const { error: updateErr } = await service
      .from("site_state")
      .update({ title: "Stockholm Weather" })
      .eq("id", inserted!.id);
    expect(updateErr).toBeNull();

    const { error: deleteErr } = await service
      .from("site_state")
      .delete()
      .eq("id", inserted!.id);
    expect(deleteErr).toBeNull();
  });

  it("has full CRUD on processing_logs", async () => {
    const { data: inserted, error: insertErr } = await service
      .from("processing_logs")
      .insert({ tool_name: "web_search", tool_input: { q: "AI" } })
      .select()
      .single();
    expect(insertErr).toBeNull();
    expect(inserted?.tool_name).toBe("web_search");

    const { error: deleteErr } = await service
      .from("processing_logs")
      .delete()
      .eq("id", inserted!.id);
    expect(deleteErr).toBeNull();
  });

  it("has full CRUD on site_state_history", async () => {
    const { data: inserted, error: insertErr } = await service
      .from("site_state_history")
      .insert({
        site_version: 999,
        semantic_key: "trends:test",
        block_type: "trends",
        content: {},
        display_order: 0,
      })
      .select()
      .single();
    expect(insertErr).toBeNull();
    expect(inserted?.site_version).toBe(999);

    const { error: deleteErr } = await service
      .from("site_state_history")
      .delete()
      .eq("id", inserted!.id);
    expect(deleteErr).toBeNull();
  });
});

// ---------------------------------------------------------
// Constraints
// ---------------------------------------------------------
describe("Constraints", () => {
  it("rejects duplicate semantic_key in site_state", async () => {
    await service.from("site_state").insert({
      semantic_key: "trends:ai",
      block_type: "trends",
      content: {},
      display_order: 0,
    });

    const { error } = await service.from("site_state").insert({
      semantic_key: "trends:ai",
      block_type: "trends",
      content: { different: true },
      display_order: 1,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation
  });

  it("rejects duplicate (site_version, semantic_key) in site_state_history", async () => {
    await service.from("site_state_history").insert({
      site_version: 1,
      semantic_key: "trends:ai",
      block_type: "trends",
      content: {},
      display_order: 0,
    });

    const { error } = await service.from("site_state_history").insert({
      site_version: 1,
      semantic_key: "trends:ai",
      block_type: "trends",
      content: { different: true },
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("allows same semantic_key in different site_versions", async () => {
    const { error: e1 } = await service.from("site_state_history").insert({
      site_version: 1,
      semantic_key: "trends:ai",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(e1).toBeNull();

    const { error: e2 } = await service.from("site_state_history").insert({
      site_version: 2,
      semantic_key: "trends:ai",
      block_type: "trends",
      content: { updated: true },
      display_order: 0,
    });
    expect(e2).toBeNull();
  });

  it("rejects invalid block_type in site_state_history", async () => {
    const { error } = await service.from("site_state_history").insert({
      site_version: 100,
      semantic_key: "unknown:test",
      block_type: "unknown",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects mismatched semantic_key prefix in site_state_history", async () => {
    const { error } = await service.from("site_state_history").insert({
      site_version: 100,
      semantic_key: "weather:stockholm",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects invalid slug format in site_state_history", async () => {
    const { error } = await service.from("site_state_history").insert({
      site_version: 100,
      semantic_key: "trends:AI-Industry",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects invalid status values on user_intents", async () => {
    const { error } = await service
      .from("user_intents")
      .insert({ intent_text: "test", status: "invalid_status" });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check_violation
  });

  it("rejects invalid block_type on site_state", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "unknown:test",
      block_type: "unknown",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check_violation
  });

  // -- Canonical semantic key enforcement --

  it("accepts valid semantic_key matching block_type", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "trends:ai-industry",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).toBeNull();
  });

  it("rejects semantic_key prefix that doesn't match block_type", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "weather:stockholm",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects semantic_key with uppercase slug", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "trends:AI-Industry",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects semantic_key with spaces in slug", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "trends:ai industry",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects semantic_key with empty slug", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "trends:",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("rejects semantic_key with slug longer than 40 chars", async () => {
    const longSlug = "a".repeat(41);
    const { error } = await service.from("site_state").insert({
      semantic_key: `trends:${longSlug}`,
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("accepts semantic_key with slug exactly 40 chars", async () => {
    const slug = "a".repeat(40);
    const { error } = await service.from("site_state").insert({
      semantic_key: `weather:${slug}`,
      block_type: "weather",
      content: {},
      display_order: 0,
    });
    expect(error).toBeNull();
  });

  it("rejects semantic_key with no colon separator", async () => {
    const { error } = await service.from("site_state").insert({
      semantic_key: "trends-ai-industry",
      block_type: "trends",
      content: {},
      display_order: 0,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

// ---------------------------------------------------------
// Sequence: site_version_seq
// ---------------------------------------------------------
describe("site_version_seq", () => {
  it("increments monotonically across calls", async () => {
    const { data: v1 } = await service.rpc("nextval_site_version");
    const { data: v2 } = await service.rpc("nextval_site_version");
    const { data: v3 } = await service.rpc("nextval_site_version");

    expect(v2).toBe(v1 + 1);
    expect(v3).toBe(v2 + 1);
  });
});

// ---------------------------------------------------------
// Realtime publication
// ---------------------------------------------------------
describe("Realtime", () => {
  it("site_state is in supabase_realtime publication", async () => {
    const { data, error } = await service.rpc("check_realtime_publication");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});
