export type BlockType = "trends" | "weather" | "summary";

export interface BaseSiteBlock<TBlockType extends BlockType, TContent> {
  id: string;
  semantic_key: string;
  block_type: TBlockType;
  title: string | null;
  content: TContent;
  display_order: number;
}

export interface TrendsItem {
  text?: string;
  url?: string;
  source?: string;
}

export interface TrendsContent {
  items?: TrendsItem[];
  summary?: string;
}

export interface WeatherContent {
  temperature?: number;
  unit?: string;
  condition?: string;
  location?: string;
}

export interface SummaryContent {
  text?: string;
}

export type TrendsSiteBlock = BaseSiteBlock<"trends", TrendsContent>;
export type WeatherSiteBlock = BaseSiteBlock<"weather", WeatherContent>;
export type SummarySiteBlock = BaseSiteBlock<"summary", SummaryContent>;
export type SiteBlock = TrendsSiteBlock | WeatherSiteBlock | SummarySiteBlock;

export interface RawSiteBlock {
  id: string;
  semantic_key: string;
  block_type: string;
  title: string | null;
  content: unknown;
  display_order: number;
}

export type RealtimeSiteEvent =
  | { eventType: "INSERT" | "UPDATE"; block: SiteBlock }
  | { eventType: "DELETE"; id: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRawSiteBlock(value: unknown): value is RawSiteBlock {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.semantic_key === "string" &&
    typeof value.block_type === "string" &&
    (typeof value.title === "string" || value.title === null) &&
    typeof value.display_order === "number" &&
    "content" in value
  );
}

function normalizeTrendsContent(value: unknown): TrendsContent {
  const content = isRecord(value) ? value : {};
  const items = Array.isArray(content.items)
    ? content.items.flatMap((item) => {
        if (!isRecord(item)) return [];

        return [
          {
            text: typeof item.text === "string" ? item.text : undefined,
            url: typeof item.url === "string" ? item.url : undefined,
            source: typeof item.source === "string" ? item.source : undefined,
          },
        ];
      })
    : undefined;

  return {
    items,
    summary: typeof content.summary === "string" ? content.summary : undefined,
  };
}

function normalizeWeatherContent(value: unknown): WeatherContent {
  const content = isRecord(value) ? value : {};

  return {
    temperature:
      typeof content.temperature === "number" ? content.temperature : undefined,
    unit: typeof content.unit === "string" ? content.unit : undefined,
    condition:
      typeof content.condition === "string" ? content.condition : undefined,
    location: typeof content.location === "string" ? content.location : undefined,
  };
}

function normalizeSummaryContent(value: unknown): SummaryContent {
  const content = isRecord(value) ? value : {};

  return {
    text: typeof content.text === "string" ? content.text : undefined,
  };
}

export function coerceSiteBlock(block: RawSiteBlock): SiteBlock | null {
  const baseBlock = {
    id: block.id,
    semantic_key: block.semantic_key,
    title: block.title,
    display_order: block.display_order,
  };

  switch (block.block_type) {
    case "trends":
      return {
        ...baseBlock,
        block_type: "trends",
        content: normalizeTrendsContent(block.content),
      };
    case "weather":
      return {
        ...baseBlock,
        block_type: "weather",
        content: normalizeWeatherContent(block.content),
      };
    case "summary":
      return {
        ...baseBlock,
        block_type: "summary",
        content: normalizeSummaryContent(block.content),
      };
    default:
      return null;
  }
}

export function normalizeSiteBlocks(blocks: RawSiteBlock[]): SiteBlock[] {
  return sortBlocks(
    blocks.flatMap((block) => {
      const nextBlock = coerceSiteBlock(block);
      return nextBlock ? [nextBlock] : [];
    })
  );
}

export function sortBlocks(blocks: SiteBlock[]): SiteBlock[] {
  return [...blocks].sort(
    (left, right) =>
      left.display_order - right.display_order ||
      left.semantic_key.localeCompare(right.semantic_key)
  );
}

export function upsertBlock(
  blocks: SiteBlock[],
  nextBlock: SiteBlock
): SiteBlock[] {
  const withoutPrevious = blocks.filter((block) => block.id !== nextBlock.id);
  return sortBlocks([...withoutPrevious, nextBlock]);
}

export function applyRealtimeEvent(
  blocks: SiteBlock[],
  event: RealtimeSiteEvent
): SiteBlock[] {
  if (event.eventType === "DELETE") {
    return blocks.filter((block) => block.id !== event.id);
  }

  return upsertBlock(blocks, event.block);
}

export function applyRealtimeEvents(
  blocks: SiteBlock[],
  events: RealtimeSiteEvent[]
): SiteBlock[] {
  return events.reduce(applyRealtimeEvent, blocks);
}

export function toRealtimeEvent(payload: {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: unknown;
  old: unknown;
}): RealtimeSiteEvent | null {
  if (payload.eventType === "DELETE") {
    const previous = isRecord(payload.old) ? payload.old : null;
    return typeof previous?.id === "string"
      ? { eventType: "DELETE", id: previous.id }
      : null;
  }

  const nextBlock = isRawSiteBlock(payload.new)
    ? coerceSiteBlock(payload.new)
    : null;

  return nextBlock ? { eventType: payload.eventType, block: nextBlock } : null;
}
