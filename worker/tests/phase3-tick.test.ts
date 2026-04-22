import { describe, it, expect, beforeEach } from "vitest";
import { serviceClient, cleanAll } from "./helpers";
import { tick } from "../src/tick";

const service = serviceClient();

beforeEach(async () => {
  await cleanAll(service);
});

describe("tick — status transitions", () => {
  it("transitions pending intent to completed with result_summary", async () => {
    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "show me trends" })
      .select("id")
      .single();

    await tick(service);

    const { data } = await service
      .from("user_intents")
      .select("status, result_summary, processed_at")
      .eq("id", intent!.id)
      .single();

    expect(data!.status).toBe("completed");
    expect(data!.result_summary).toBeTruthy();
    expect(data!.processed_at).not.toBeNull();
  });

  it("sets status to processing during claim (visible in DB)", async () => {
    // Insert intent
    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "test" })
      .select("id")
      .single();

    // Claim but don't process — call the claim RPC directly
    const { data: claimed } = await service.rpc("claim_pending_intents", {
      batch_size: 5,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("processing");

    // Verify in DB
    const { data } = await service
      .from("user_intents")
      .select("status")
      .eq("id", intent!.id)
      .single();
    expect(data!.status).toBe("processing");
  });

  it("full lifecycle: pending → processing → completed", async () => {
    const { data: intent } = await service
      .from("user_intents")
      .insert({ intent_text: "lifecycle test" })
      .select("id")
      .single();

    // Before tick: pending
    const { data: before } = await service
      .from("user_intents")
      .select("status")
      .eq("id", intent!.id)
      .single();
    expect(before!.status).toBe("pending");

    // After tick: completed
    await tick(service);

    const { data: after } = await service
      .from("user_intents")
      .select("status")
      .eq("id", intent!.id)
      .single();
    expect(after!.status).toBe("completed");
  });

  it("processes multiple intents in one tick", async () => {
    await service.from("user_intents").insert([
      { intent_text: "first" },
      { intent_text: "second" },
      { intent_text: "third" },
    ]);

    await tick(service);

    const { data } = await service
      .from("user_intents")
      .select("status")
      .eq("status", "completed");
    expect(data).toHaveLength(3);
  });

  it("tick is a no-op when no pending intents", async () => {
    // No intents at all — should not throw
    await tick(service);

    const { data } = await service.from("user_intents").select("id");
    expect(data).toHaveLength(0);
  });

  it("does not re-process already completed intents", async () => {
    await service.from("user_intents").insert({
      intent_text: "already done",
      status: "completed",
      result_summary: "original summary",
    });

    await tick(service);

    const { data } = await service
      .from("user_intents")
      .select("result_summary")
      .single();
    expect(data!.result_summary).toBe("original summary");
  });

  it("does not re-process failed intents", async () => {
    await service.from("user_intents").insert({
      intent_text: "already failed",
      status: "failed",
      error: "original error",
    });

    await tick(service);

    const { data } = await service
      .from("user_intents")
      .select("status, error")
      .single();
    expect(data!.status).toBe("failed");
    expect(data!.error).toBe("original error");
  });
});
