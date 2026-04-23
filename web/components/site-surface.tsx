"use client";

import { startTransition, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { TrendsBlock } from "@/components/blocks/trends-block";
import { WeatherBlock } from "@/components/blocks/weather-block";
import { SummaryBlock } from "@/components/blocks/summary-block";
import {
  applyRealtimeEvent,
  applyRealtimeEvents,
  isRawSiteBlock,
  normalizeSiteBlocks,
  toRealtimeEvent,
  type RealtimeSiteEvent,
  type SiteBlock,
} from "@/lib/site-surface-state";

const spring = { type: "spring" as const, stiffness: 300, damping: 30 };

function BlockRenderer({ block }: { block: SiteBlock }) {
  switch (block.block_type) {
    case "trends":
      return <TrendsBlock title={block.title ?? "Trends"} content={block.content} />;
    case "weather":
      return (
        <WeatherBlock
          title={block.title ?? "Weather"}
          content={block.content}
        />
      );
    case "summary":
      return (
        <SummaryBlock
          title={block.title ?? "Summary"}
          content={block.content}
        />
      );
    default:
      return null;
  }
}

export function SiteSurface() {
  const [blocks, setBlocks] = useState<SiteBlock[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const pendingEvents: RealtimeSiteEvent[] = [];
    let cancelled = false;
    let initialLoadStarted = false;
    let bootstrapped = false;

    const loadInitialState = async () => {
      if (initialLoadStarted) return;
      initialLoadStarted = true;

      const { data } = await supabase
        .from("site_state")
        .select("id, semantic_key, block_type, title, content, display_order")
        .order("display_order");

      if (cancelled) return;

      const initialBlocks = normalizeSiteBlocks(
        (data ?? []).flatMap((block) => (isRawSiteBlock(block) ? [block] : []))
      );
      const nextBlocks = applyRealtimeEvents(initialBlocks, pendingEvents);

      bootstrapped = true;
      pendingEvents.length = 0;

      startTransition(() => {
        setBlocks(nextBlocks);
        setLoaded(true);
      });
    };

    const channel = supabase
      .channel("site_state_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "site_state" },
        (payload) => {
          const event = toRealtimeEvent(payload);
          if (!event) return;

          if (!bootstrapped) {
            pendingEvents.push(event);
            return;
          }

          startTransition(() => {
            setBlocks((previousBlocks) =>
              applyRealtimeEvent(previousBlocks, event)
            );
          });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadInitialState();
          return;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          void loadInitialState();
        }
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  if (!loaded) return null;

  if (blocks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-center text-lg">
          Type an intent below to shape this surface.
        </p>
      </div>
    );
  }

  return (
    <div className="grid auto-rows-auto gap-4 p-4 pb-24">
      <AnimatePresence mode="popLayout">
        {blocks.map((block) => (
          <motion.div
            key={block.id}
            layoutId={block.id}
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            <BlockRenderer block={block} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
