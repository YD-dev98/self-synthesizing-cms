import { describe, it, expect } from "vitest";
import {
  SemanticKeySchema,
  UpsertMutationSchema,
  DeleteMutationSchema,
  MutationResponseSchema,
  type MutationResponse,
  type UpsertMutation,
  type DeleteMutation,
} from "../src/schema";

// ---------------------------------------------------------
// SemanticKeySchema
// ---------------------------------------------------------
describe("SemanticKeySchema", () => {
  it("accepts valid keys", () => {
    expect(() => SemanticKeySchema.parse("trends:ai-industry")).not.toThrow();
    expect(() => SemanticKeySchema.parse("weather:stockholm")).not.toThrow();
    expect(() => SemanticKeySchema.parse("summary:q1-2026")).not.toThrow();
  });

  it("rejects unknown block type prefix", () => {
    expect(() => SemanticKeySchema.parse("unknown:test")).toThrow();
  });

  it("rejects uppercase in slug", () => {
    expect(() => SemanticKeySchema.parse("trends:AI-Industry")).toThrow();
  });

  it("rejects spaces in slug", () => {
    expect(() => SemanticKeySchema.parse("trends:ai industry")).toThrow();
  });

  it("rejects empty slug", () => {
    expect(() => SemanticKeySchema.parse("trends:")).toThrow();
  });

  it("rejects slug longer than 40 chars", () => {
    const long = "a".repeat(41);
    expect(() => SemanticKeySchema.parse(`trends:${long}`)).toThrow();
  });

  it("accepts slug exactly 40 chars", () => {
    const slug = "a".repeat(40);
    expect(() => SemanticKeySchema.parse(`trends:${slug}`)).not.toThrow();
  });

  it("rejects key with no colon", () => {
    expect(() => SemanticKeySchema.parse("trends-ai")).toThrow();
  });
});

// ---------------------------------------------------------
// UpsertMutationSchema
// ---------------------------------------------------------
describe("UpsertMutationSchema", () => {
  const validUpsert = {
    action: "upsert" as const,
    semantic_key: "trends:ai-industry",
    block_type: "trends" as const,
    title: "AI Industry Trends",
    content: { items: [{ text: "trend 1" }] },
    display_order: 1,
  };

  it("accepts valid upsert", () => {
    expect(() => UpsertMutationSchema.parse(validUpsert)).not.toThrow();
  });

  it("rejects mismatched semantic_key prefix and block_type", () => {
    expect(() =>
      UpsertMutationSchema.parse({
        ...validUpsert,
        semantic_key: "weather:stockholm",
        block_type: "trends",
      })
    ).toThrow(/must match/);
  });

  it("rejects unknown block_type", () => {
    expect(() =>
      UpsertMutationSchema.parse({
        ...validUpsert,
        block_type: "unknown",
        semantic_key: "unknown:test",
      })
    ).toThrow();
  });

  it("rejects missing title", () => {
    const { title, ...noTitle } = validUpsert;
    expect(() => UpsertMutationSchema.parse(noTitle)).toThrow();
  });

  it("rejects negative display_order", () => {
    expect(() =>
      UpsertMutationSchema.parse({ ...validUpsert, display_order: -1 })
    ).toThrow();
  });

  it("rejects non-integer display_order", () => {
    expect(() =>
      UpsertMutationSchema.parse({ ...validUpsert, display_order: 1.5 })
    ).toThrow();
  });
});

// ---------------------------------------------------------
// DeleteMutationSchema
// ---------------------------------------------------------
describe("DeleteMutationSchema", () => {
  it("accepts valid delete", () => {
    expect(() =>
      DeleteMutationSchema.parse({
        action: "delete",
        semantic_key: "weather:stockholm",
      })
    ).not.toThrow();
  });

  it("rejects delete without semantic_key", () => {
    expect(() => DeleteMutationSchema.parse({ action: "delete" })).toThrow();
  });

  it("rejects delete with invalid semantic_key", () => {
    expect(() =>
      DeleteMutationSchema.parse({
        action: "delete",
        semantic_key: "invalid",
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------
// MutationResponseSchema
// ---------------------------------------------------------
describe("MutationResponseSchema", () => {
  it("accepts valid response with upsert", () => {
    const response = {
      mutations: [
        {
          action: "upsert",
          semantic_key: "trends:ai-industry",
          block_type: "trends",
          title: "AI Trends",
          content: { items: [] },
          display_order: 0,
        },
      ],
      summary: "Created AI trends card",
    };
    const result = MutationResponseSchema.parse(response);
    expect(result.mutations).toHaveLength(1);
    expect(result.summary).toBe("Created AI trends card");
  });

  it("accepts valid response with delete", () => {
    const response = {
      mutations: [
        { action: "delete", semantic_key: "weather:stockholm" },
      ],
      summary: "Removed weather widget",
    };
    expect(() => MutationResponseSchema.parse(response)).not.toThrow();
  });

  it("accepts mixed upserts and deletes", () => {
    const response = {
      mutations: [
        {
          action: "upsert",
          semantic_key: "trends:fintech",
          block_type: "trends",
          title: "Fintech Trends",
          content: {},
          display_order: 0,
        },
        { action: "delete", semantic_key: "weather:stockholm" },
      ],
      summary: "Updated trends, removed weather",
    };
    expect(() => MutationResponseSchema.parse(response)).not.toThrow();
  });

  it("rejects empty mutations array", () => {
    expect(() =>
      MutationResponseSchema.parse({ mutations: [], summary: "nothing" })
    ).toThrow();
  });

  it("rejects missing summary", () => {
    expect(() =>
      MutationResponseSchema.parse({
        mutations: [
          { action: "delete", semantic_key: "trends:test" },
        ],
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------
// Type exports compile correctly
// ---------------------------------------------------------
describe("Type exports", () => {
  it("inferred types are usable", () => {
    // This test verifies that the types compile and are assignable.
    // If the types were wrong, tsc --noEmit would catch it.
    const upsert: UpsertMutation = {
      action: "upsert",
      semantic_key: "trends:test",
      block_type: "trends",
      title: "Test",
      content: {},
      display_order: 0,
    };
    const del: DeleteMutation = {
      action: "delete",
      semantic_key: "trends:test",
    };
    const response: MutationResponse = {
      mutations: [upsert, del],
      summary: "test",
    };
    expect(response.mutations).toHaveLength(2);
  });
});
