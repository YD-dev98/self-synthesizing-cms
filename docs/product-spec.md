# Product Spec: Self-Synthesizing CMS

## Vision

An autonomous web engine that replaces traditional CMS interaction with a self-evolving UI driven by a background agent loop. Users don't navigate menus or manage content — they express high-level goals in plain text, and the system evolves to meet them.

## Core Interaction Model

### The Magic Bar

A persistent text input fixed at the bottom of the viewport. This is the sole interface for user intent.

- User types a goal: "show me AI industry trends this week"
- Intent is queued in the database
- Within minutes, the site evolves to reflect the request

There are no pages, no navigation, no admin panel. The site is a living surface that responds to intent.

### The Agent Loop

A background process (cron, every 5 minutes) acts as the system brain:

1. **Poll** — Read pending intents from the queue
2. **Reason** — LLM analyzes intents against current site state
3. **Act** — Execute tool calls (web search, data fetch, content synthesis)
4. **Mutate** — Write updated site state back to the database
5. **Render** — Frontend picks up new state and morphs the UI

This is async intelligence, not instant messaging. The site evolves like an organism, not a chatbot.

## Flow Comparison

```
Traditional:  Client → API → Database → Render
This system:  User Intent → LLM Reasoning → Cron Job → State Mutation → Reactive Frontend
```

## Initial Use Case: Market Intelligence Dashboard

The first proof-of-concept targets a research/intelligence dashboard:

- "show me AI industry trends" → searches the web, fetches articles, synthesizes into content blocks
- "what's happening in fintech this week" → curated trend cards with sources
- "show the weather in Stockholm" → fetches weather data, renders a weather widget

### Tool Chain

```
Search → Fetch → Synthesize
```

1. **Search** — Web search for relevant sources (Claude web_search)
2. **Fetch** — Retrieve full content from top results (Claude web_fetch)
3. **Synthesize** — LLM distills raw data into structured content blocks with summaries, key points, and source attribution

## Historical Record

The system maintains a complete, reconstructable history of the site's evolution:

- **Intent log** — Every user request is recorded in `user_intents` with its processing outcome, forming the narrative of *what was asked*.
- **Tool audit trail** — Every web search, fetch, and validation attempt is logged in `processing_logs`, showing *how the system reasoned*.
- **Versioned snapshots** — After each intent is processed, a full snapshot of the site surface is captured in `site_state_history` under a monotonic version number. This means you can reconstruct exactly what the site looked like at any point in its evolution: `SELECT * FROM site_state_history WHERE site_version = N`.

Each snapshot records which intent produced it. You can trace the full chain: intent `abc-def` produced site version `n`, which changed the site from version `n-1` — for example by adding a weather block and updating a trends card. Intent IDs and site versions are independent sequences (UUIDs vs. integers), linked through the `intent_id` foreign key on each snapshot.

## V0 Success Criteria

The minimum viable proof is the full loop working end-to-end:

1. User types intent into magic bar
2. Intent is stored in Supabase
3. Cron job picks up the intent
4. LLM reasons about it, executes web search/fetch
5. Synthesized content is written to site state
6. Frontend reflects the new state

If you can type "show me AI trends" and, within one cron cycle, see a rendered dashboard of synthesized intelligence — v0 is complete.
