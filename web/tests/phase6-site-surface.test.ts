import { describe, expect, it } from "vitest";
import {
  applyRealtimeEvent,
  applyRealtimeEvents,
  coerceSiteBlock,
  normalizeSiteBlocks,
  toRealtimeEvent,
  type RawSiteBlock,
  type SiteBlock,
} from "@/lib/site-surface-state";

function rawBlock(overrides: Partial<RawSiteBlock>): RawSiteBlock {
  return {
    id: "block-1",
    semantic_key: "summary:alpha",
    block_type: "summary",
    title: "Alpha",
    content: { text: "hello" },
    display_order: 1,
    ...overrides,
  };
}

function siteBlock(overrides: Partial<SiteBlock>): SiteBlock {
  return {
    id: "block-1",
    semantic_key: "summary:alpha",
    block_type: "summary",
    title: "Alpha",
    content: { text: "hello" },
    display_order: 1,
    ...overrides,
  } as SiteBlock;
}

describe("site surface state", () => {
  it("normalizes and orders the initial site surface by display_order", () => {
    const blocks = normalizeSiteBlocks([
      rawBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 16, condition: "Rain" },
        display_order: 2,
      }),
      rawBlock({
        id: "trends-1",
        semantic_key: "trends:ai",
        block_type: "trends",
        title: "Trends",
        content: {
          summary: "AI is moving fast",
          items: [{ text: "Inference chips", url: "https://example.com" }],
        },
        display_order: 1,
      }),
      rawBlock({
        id: "summary-1",
        semantic_key: "summary:wrap-up",
        block_type: "summary",
        title: "Wrap up",
        content: { text: "A concise recap" },
        display_order: 3,
      }),
    ]);

    expect(blocks.map((block) => block.block_type)).toEqual([
      "trends",
      "weather",
      "summary",
    ]);
    expect(blocks[0]?.content).toEqual({
      summary: "AI is moving fast",
      items: [{ text: "Inference chips", url: "https://example.com", source: undefined }],
    });
    expect(blocks[1]?.content).toEqual({
      temperature: 16,
      unit: undefined,
      condition: "Rain",
      location: undefined,
    });
  });

  it("drops unknown block types during normalization", () => {
    const blocks = normalizeSiteBlocks([
      rawBlock({
        id: "mystery-1",
        semantic_key: "mystery:test",
        block_type: "mystery",
      }),
    ]);

    expect(blocks).toEqual([]);
  });

  it("upserts realtime inserts into the right sorted position", () => {
    const initial = normalizeSiteBlocks([
      rawBlock({
        id: "summary-1",
        semantic_key: "summary:wrap-up",
        title: "Wrap up",
        display_order: 2,
      }),
    ]);

    const next = applyRealtimeEvent(initial, {
      eventType: "INSERT",
      block: siteBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 12, condition: "Cloudy" },
        display_order: 1,
      }),
    });

    expect(next.map((block) => block.semantic_key)).toEqual([
      "weather:stockholm",
      "summary:wrap-up",
    ]);
  });

  it("updates a block in place and re-sorts when display_order changes", () => {
    const initial = normalizeSiteBlocks([
      rawBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 12, condition: "Cloudy" },
        display_order: 1,
      }),
      rawBlock({
        id: "summary-1",
        semantic_key: "summary:wrap-up",
        title: "Wrap up",
        display_order: 2,
      }),
    ]);

    const next = applyRealtimeEvent(initial, {
      eventType: "UPDATE",
      block: siteBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 6, condition: "Snow" },
        display_order: 3,
      }),
    });

    expect(next.map((block) => block.semantic_key)).toEqual([
      "summary:wrap-up",
      "weather:stockholm",
    ]);
    expect(next.find((block) => block.id === "weather-1")?.content).toEqual({
      temperature: 6,
      condition: "Snow",
      unit: undefined,
      location: undefined,
    });
  });

  it("removes blocks on realtime delete events", () => {
    const initial = normalizeSiteBlocks([
      rawBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 12, condition: "Cloudy" },
      }),
      rawBlock({
        id: "summary-1",
        semantic_key: "summary:wrap-up",
        title: "Wrap up",
        display_order: 2,
      }),
    ]);

    const next = applyRealtimeEvent(initial, {
      eventType: "DELETE",
      id: "weather-1",
    });

    expect(next.map((block) => block.id)).toEqual(["summary-1"]);
  });

  it("replays buffered realtime events over the initial snapshot without duplicates", () => {
    const initial = normalizeSiteBlocks([
      rawBlock({
        id: "summary-1",
        semantic_key: "summary:wrap-up",
        title: "Wrap up",
        display_order: 2,
      }),
      rawBlock({
        id: "weather-1",
        semantic_key: "weather:stockholm",
        block_type: "weather",
        title: "Weather",
        content: { temperature: 12, condition: "Cloudy" },
        display_order: 3,
      }),
    ]);

    const bufferedEvents = [
      {
        eventType: "INSERT" as const,
        block: siteBlock({
          id: "trends-1",
          semantic_key: "trends:ai",
          block_type: "trends",
          title: "AI Trends",
          content: { summary: "Fresh updates", items: [{ text: "Inference chips" }] },
          display_order: 1,
        }),
      },
      {
        eventType: "DELETE" as const,
        id: "weather-1",
      },
      {
        eventType: "INSERT" as const,
        block: siteBlock({
          id: "summary-1",
          semantic_key: "summary:wrap-up",
          block_type: "summary",
          title: "Wrap up",
          content: { text: "Updated copy" },
          display_order: 2,
        }),
      },
    ];

    const next = applyRealtimeEvents(initial, bufferedEvents);

    expect(next.map((block) => block.semantic_key)).toEqual([
      "trends:ai",
      "summary:wrap-up",
    ]);
    expect(next.find((block) => block.id === "summary-1")?.content).toEqual({
      text: "Updated copy",
    });
  });

  it("parses realtime payloads using real INSERT, UPDATE, and DELETE block shapes", () => {
    expect(
      toRealtimeEvent({
        eventType: "INSERT",
        new: rawBlock({
          id: "trends-1",
          semantic_key: "trends:ai",
          block_type: "trends",
          title: "AI Trends",
          content: { summary: "Fresh updates" },
        }),
        old: null,
      })
    ).toEqual({
      eventType: "INSERT",
      block: {
        id: "trends-1",
        semantic_key: "trends:ai",
        block_type: "trends",
        title: "AI Trends",
        content: { summary: "Fresh updates", items: undefined },
        display_order: 1,
      },
    });

    expect(
      toRealtimeEvent({
        eventType: "DELETE",
        new: null,
        old: { id: "trends-1" },
      })
    ).toEqual({
      eventType: "DELETE",
      id: "trends-1",
    });
  });

  it("coerces malformed content into safe optional shapes", () => {
    expect(
      coerceSiteBlock(
        rawBlock({
          id: "weather-1",
          semantic_key: "weather:stockholm",
          block_type: "weather",
          title: "Weather",
          content: { temperature: "12", condition: 123 },
        })
      )
    ).toEqual({
      id: "weather-1",
      semantic_key: "weather:stockholm",
      block_type: "weather",
      title: "Weather",
      content: {
        temperature: undefined,
        unit: undefined,
        condition: undefined,
        location: undefined,
      },
      display_order: 1,
    });
  });
});
