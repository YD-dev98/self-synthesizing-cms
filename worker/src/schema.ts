import { z } from "zod";

export const BLOCK_TYPES = ["trends", "weather", "summary"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const TOPIC_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SemanticKeySchema = z.string().refine(
  (key) => {
    const colonIdx = key.indexOf(":");
    if (colonIdx === -1) return false;
    const blockType = key.slice(0, colonIdx);
    const slug = key.slice(colonIdx + 1);
    return (
      (BLOCK_TYPES as readonly string[]).includes(blockType) &&
      TOPIC_SLUG_REGEX.test(slug) &&
      slug.length <= 40
    );
  },
  { message: "Must be {block_type}:{topic-slug} with valid block type and slug format" }
);

export const UpsertMutationSchema = z
  .object({
    action: z.literal("upsert"),
    semantic_key: SemanticKeySchema,
    block_type: z.enum(BLOCK_TYPES),
    title: z.string(),
    content: z.record(z.string(), z.unknown()),
    display_order: z.number().int().min(0),
  })
  .superRefine((data, ctx) => {
    const keyPrefix = data.semantic_key.split(":")[0];
    if (keyPrefix !== data.block_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `semantic_key prefix "${keyPrefix}" must match block_type "${data.block_type}"`,
        path: ["semantic_key"],
      });
    }
  });

export const DeleteMutationSchema = z.object({
  action: z.literal("delete"),
  semantic_key: SemanticKeySchema,
});

export const MutationSchema = z.discriminatedUnion("action", [
  UpsertMutationSchema,
  DeleteMutationSchema,
]);

export const MutationResponseSchema = z.object({
  mutations: z.array(MutationSchema).min(1),
  summary: z.string(),
});

// Exported inferred types — consumed by processor.ts and future phases
export type UpsertMutation = z.infer<typeof UpsertMutationSchema>;
export type DeleteMutation = z.infer<typeof DeleteMutationSchema>;
export type Mutation = z.infer<typeof MutationSchema>;
export type MutationResponse = z.infer<typeof MutationResponseSchema>;
