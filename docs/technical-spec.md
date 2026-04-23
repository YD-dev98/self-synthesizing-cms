# Technical Spec: Self-Synthesizing CMS

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│              (Next.js on Vercel)                  │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │            Dynamic Site Surface              │ │
│  │      (renders from site_state table)         │ │
│  │                                               │ │
│  │  Subscribes to Supabase Realtime for         │ │
│  │  live state updates — no manual refresh      │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │              Magic Bar                        │ │
│  │   (fixed bottom, submits via /api/intent)     │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
            │                           │
            │ POST /api/intent          │ Supabase Client SDK
            │ GET  /api/intent/[id]     │ (Realtime on site_state only)
            ▼                           ▼
┌─────────────────────────────────────────────────┐
│              Supabase Postgres                    │
│                                                   │
│  user_intents        — intent queue + history     │
│  site_state          — current rendered content   │
│  site_state_history  — versioned snapshots        │
│  processing_logs     — tool call audit trail      │
└─────────────────────────────────────────────────┘
                      ▲
                      │ Supabase Client SDK
                      │
┌─────────────────────────────────────────────────┐
│            Background Worker                      │
│         (Node.js, cron every 5 min)               │
│                                                   │
│  1. Query pending intents                         │
│  2. Send to Claude API with tools                 │
│  3. Execute tool results (search, fetch)          │
│  4. Synthesize into content blocks                │
│  5. Write updated site_state                      │
│  6. Mark intents as processed                     │
└─────────────────────────────────────────────────┘
```

## Tech Stack

| Layer              | Technology                    |
|--------------------|-------------------------------|
| Frontend           | Next.js (App Router)          |
| UI Components      | shadcn/ui + Tailwind CSS      |
| Animations         | Framer Motion                 |
| Hosting            | Vercel                        |
| Database           | Supabase Postgres             |
| Realtime           | Supabase Realtime             |
| Background Worker  | Node.js (cron-triggered)      |
| LLM                | Claude API (modular)          |
| Tools              | web_search, web_fetch         |

## Database Schema

### `user_intents`

The queue and historical record of all user requests.

```sql
CREATE TABLE user_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  result_summary TEXT,                     -- brief LLM summary of what it did
  error TEXT                               -- error message if failed
);

CREATE INDEX idx_intents_status ON user_intents(status) WHERE status = 'pending';
CREATE INDEX idx_intents_created ON user_intents(created_at DESC);
```

### `site_state`

The current content surface. Each row is a content block rendered by the frontend.

```sql
CREATE TABLE site_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_key TEXT NOT NULL UNIQUE,        -- canonical identity, format: {block_type}:{topic-slug}
  block_type TEXT NOT NULL,                -- 'trends' | 'weather' | 'summary' | etc.
  title TEXT,
  content JSONB NOT NULL,                  -- flexible structure per block type
  source_intent_id UUID REFERENCES user_intents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                  -- set by worker based on block_type TTL defaults
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_state_order ON site_state(display_order);
CREATE INDEX idx_state_expires ON site_state(expires_at) WHERE expires_at IS NOT NULL;
```

### `processing_logs`

Audit trail of every tool call the LLM makes.

```sql
CREATE TABLE processing_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID REFERENCES user_intents(id),
  tool_name TEXT NOT NULL,                 -- 'web_search' | 'web_fetch' | 'schema_validation' | etc.
  tool_input JSONB,
  tool_output JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_intent ON processing_logs(intent_id);
```

### `site_versions`

Version registry — one row per snapshot, even if the site surface is empty. This makes empty surfaces distinguishable from nonexistent versions.

```sql
CREATE SEQUENCE site_version_seq START 1;

CREATE TABLE site_versions (
  version INTEGER PRIMARY KEY,
  intent_id UUID REFERENCES user_intents(id),  -- NULL for system-initiated (e.g. TTL sweep)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `site_state_history`

Block-level snapshot data, keyed to a version. Zero rows for a given version means the surface was empty at that point.

```sql
CREATE TABLE site_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_version INTEGER NOT NULL REFERENCES site_versions(version),
  semantic_key TEXT NOT NULL,
  block_type TEXT NOT NULL,
  title TEXT,
  content JSONB NOT NULL,
  display_order INTEGER NOT NULL,
  expires_at TIMESTAMPTZ,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_version, semantic_key)       -- one entry per block per version
);

CREATE INDEX idx_history_version ON site_state_history(site_version);
CREATE INDEX idx_versions_intent ON site_versions(intent_id);
```

A new version is produced whenever `site_state` changes — whether from intent processing or a TTL sweep. The worker writes a row to `site_versions` first, then inserts the block rows into `site_state_history` (which may be zero for an empty surface). To check if a version exists: query `site_versions`. To reconstruct the site: `SELECT * FROM site_state_history WHERE site_version = N`. An empty result with an existing version means the surface was intentionally empty.

**Sweep path is fully atomic** — the `sweep_expired_blocks()` Postgres function acquires an advisory lock (`pg_advisory_xact_lock(42)`), deletes expired rows, allocates a version, registers it in `site_versions`, and snapshots surviving blocks into `site_state_history` — all in a single transaction. No JS round trips between the steps.

**State mutation lock convention:** Every Postgres function that mutates `site_state` and/or writes to `site_versions` + `site_state_history` must acquire `pg_advisory_xact_lock(42)` at the start. This serializes all state writers so snapshots are always consistent. Phase 5's `apply_mutations_and_snapshot()` RPC must use the same lock ID.

## Component Details

### 1. Magic Bar (Frontend)

- Fixed-position input at viewport bottom using shadcn/ui `Input` + `Button`
- On submit: POST to `/api/intent` server route (not direct DB insert)
- Shows subtle confirmation via shadcn/ui `Sonner` toast ("Intent queued — site will evolve shortly")
- Gated behind a session password for v0 (shadcn/ui `Dialog` modal on first visit)

**Access gate (v0):**

Intent submission goes through a Next.js API route (`/api/intent`) that validates a shared password before writing to the database. This prevents abuse via direct Supabase access — the anon key has no INSERT policy on `user_intents`.

```
POST /api/intent
Headers: { x-access-token: <password> }
Body:    { intent_text: "show me AI trends" }

→ Server validates token against ACCESS_PASSWORD env var
→ If valid: inserts into user_intents using service role key, returns 200
→ If invalid: returns 401
```

The frontend stores the password in a cookie after first successful validation.

**RLS policies:**

The anon role has no access to `user_intents` at all — no SELECT, no INSERT. This prevents exposing intent text, error messages, or processing details to the public Supabase client. All intent operations go through server routes using the service role:

- `POST /api/intent` — validates password, inserts intent, returns `{ id }`
- `GET /api/intent/[id]` — validates password, returns `{ id, status }` only (for polling)

The anon role can only SELECT on `site_state` (for Realtime subscriptions and initial page load). All other tables are service-role-only.

### 2. Site Surface (Frontend)

- Queries `site_state` ordered by `display_order`
- Subscribes to Supabase Realtime on `site_state` table
- When new/updated rows arrive, UI morphs without page reload
- Each `block_type` maps to a React component built with shadcn/ui primitives:
  - `trends` → `Card` grid with title, summary, key points, sources using `Badge`, `Separator`
  - `weather` → `Card` with weather data display
  - `summary` → `Card` with general text block
- All styling via Tailwind CSS utility classes — no custom CSS beyond globals
- Empty state: minimal landing with just the magic bar and a prompt

**Layout-aware transitions:**

The site surface must feel organic — blocks don't snap in/out, they flow. All state changes from Supabase Realtime are animated with layout-aware transitions:

- **Inserts** — new blocks fade in and expand from zero height, pushing siblings down smoothly
- **Removals** — blocks collapse and fade out, siblings slide up to fill the gap
- **Reorders** — blocks animate to their new positions (translate Y) rather than jumping
- **Resizes** — content changes within a block animate height smoothly so surrounding blocks adjust

Implementation approach:
- Use CSS `grid` layout with `auto` row heights for natural flow
- Framer Motion's `AnimatePresence` + `layout` prop for mount/unmount and reorder animations
- Each block wrapped in a `motion.div` with `layoutId={block.id}` so Framer Motion tracks identity across renders
- Supabase Realtime events (`INSERT`, `UPDATE`, `DELETE`) update local React state, which triggers Framer Motion's layout animation system automatically
- Transitions use spring physics (not linear/ease) for organic feel: `type: "spring", stiffness: 300, damping: 30`

### 3. Background Worker

Worker uses recursive setTimeout (not setInterval) to guarantee the previous tick
completes before the next one is scheduled. No overlapping ticks.

```
Every 5 minutes (sequential, non-overlapping):

  0. SWEEP EXPIRED BLOCKS (single atomic RPC: sweep_expired_blocks())
     In one Postgres transaction:
       → DELETE expired rows from site_state
       → If any deleted: nextval → INSERT site_versions → INSERT site_state_history
     Returns count of deleted rows. Zero = no-op, no version allocated.

  1. CLAIM PENDING INTENTS (atomic, race-safe)
     WITH claimed AS (
       SELECT id FROM user_intents
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED
     )
     UPDATE user_intents
     SET status = 'processing', processed_at = now()
     FROM claimed
     WHERE user_intents.id = claimed.id
     RETURNING user_intents.*;

  2. For each claimed intent:
     a. Build Claude API request:
        - System prompt with canonical key format and block_type registry
        - Include current site_state as context
        - Include the intent
        - Available tools: web_search, web_fetch
     b. Execute Claude response (agentic tool loop)
     c. Log each tool call to processing_logs
     d. Validate + self-correct mutation response (up to 3 attempts)
     e. Single atomic RPC: apply_mutations_and_snapshot()
        - Acquires pg_advisory_xact_lock(42)
        - Upserts/deletes on site_state with TTL stamps per block_type
        - Allocates version → INSERT site_versions (with intent_id)
        - Snapshots full site_state into site_state_history
        - Marks intent as completed with result_summary
        (All in one Postgres transaction — no split requests)

  3. On error: UPDATE status = 'failed', error = message
```

The `FOR UPDATE SKIP LOCKED` CTE ensures that if two worker runs overlap, the second one skips any rows the first is still holding — no double-processing, no blocking. However, the worker uses recursive `setTimeout` (not `setInterval`) so ticks never overlap in practice.

### 4. Claude API Integration

**Canonical key format & block type registry:**

The LLM does not freely invent `semantic_key` values or TTLs. The system enforces a canonical format and the worker controls freshness.

```
Semantic key format:  {block_type}:{topic-slug}
                      └── from registry ──┘  └── lowercase, hyphenated, ≤40 chars ──┘

Examples:
  trends:ai-industry
  weather:stockholm
  summary:quarterly-earnings
```

Block type registry (worker-side, not LLM-controlled):

| block_type | TTL default | Description                     |
|------------|-------------|---------------------------------|
| `trends`   | 24 hours    | Industry/topic trend cards      |
| `weather`  | 1 hour      | Weather data for a location     |
| `summary`  | 72 hours    | General research summaries      |

- `block_type` in mutations must be one of the registered types — unknown types fail validation
- `expires_at` is never set by the LLM — the worker stamps it as `now() + TTL` based on the block type
- The topic slug is the only part the LLM controls, constrained by regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/`, max 40 chars
- This prevents drift: the system prompt instructs Claude to reuse existing semantic keys when updating content, and the slug format leaves no room for stylistic variation

**System prompt structure:**

```
You are the brain of a self-evolving website. Given a user intent
and the current site state, decide what actions to take.

You have access to:
- web_search: Search the web for information
- web_fetch: Fetch content from a URL

BLOCK TYPES (you must use one of these):
- trends: industry/topic trend cards
- weather: weather data for a location
- summary: general research summaries

SEMANTIC KEY FORMAT: {block_type}:{topic-slug}
- topic-slug must be lowercase, hyphenated, ≤40 chars
- Reuse existing keys when updating content (check current state)
- Examples: trends:ai-industry, weather:stockholm, summary:quarterly-earnings

Your job:
1. Analyze the intent
2. Use tools to gather information
3. Return a JSON response describing site_state mutations

Response format:
{
  "mutations": [
    {
      "action": "upsert",
      "semantic_key": "trends:ai-industry",
      "block_type": "trends",
      "title": "AI Industry Trends",
      "content": { ... structured content ... },
      "display_order": 1
    }
  ],
  "summary": "Searched for AI trends and created a dashboard card with 5 key findings"
}

For deletions:
{
  "mutations": [
    { "action": "delete", "semantic_key": "weather:stockholm" }
  ],
  "summary": "Removed the Stockholm weather widget as requested"
}
```

**Tool loop:** The worker runs an agentic loop — sends message to Claude, if response contains `tool_use`, executes the tool, appends result, re-sends until Claude returns a final text/JSON response.

**Schema validation & self-correction:**

All mutation responses from Claude are validated against Zod schemas before being applied to `site_state`. This ensures the LLM never writes malformed data into the content surface.

```typescript
const BLOCK_TYPES = ["trends", "weather", "summary"] as const;
const TOPIC_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SemanticKeySchema = z.string().refine((key) => {
  const [blockType, ...slugParts] = key.split(":");
  const slug = slugParts.join(":");
  return (
    BLOCK_TYPES.includes(blockType as any) &&
    TOPIC_SLUG_REGEX.test(slug) &&
    slug.length <= 40
  );
}, "Must be {block_type}:{topic-slug} with valid block type and slug format");

const UpsertMutationSchema = z
  .object({
    action: z.literal("upsert"),
    semantic_key: SemanticKeySchema,
    block_type: z.enum(BLOCK_TYPES),
    title: z.string(),
    content: z.record(z.unknown()),
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

const DeleteMutationSchema = z.object({
  action: z.literal("delete"),
  semantic_key: SemanticKeySchema,
});

const MutationSchema = z.discriminatedUnion("action", [
  UpsertMutationSchema,
  DeleteMutationSchema,
]);

const MutationResponseSchema = z.object({
  mutations: z.array(MutationSchema).min(1),
  summary: z.string(),
});
```

If validation fails, the worker enters a **self-correction loop**:

1. Send the Zod error back to Claude along with the original intent and the invalid response
2. Claude attempts to fix its output
3. Re-validate the corrected response
4. Up to **3 attempts** — if all fail, mark the intent as `failed` and log the validation errors to `processing_logs` with `tool_name: 'schema_validation'`

This keeps the site state clean while giving the LLM a chance to recover from structural mistakes.

## Project Structure

```
self-synthesizing-cms/
├── docs/
│   ├── product-spec.md
│   └── technical-spec.md
├── web/                        # Next.js app
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx            # Site surface + magic bar
│   │   ├── globals.css
│   │   └── api/
│   │       └── intent/
│   │           ├── route.ts    # POST: validates password, inserts intent
│   │           └── [id]/
│   │               └── route.ts  # GET: returns { id, status } for polling
│   ├── components/
│   │   ├── magic-bar.tsx
│   │   ├── access-gate.tsx     # Password modal for v0
│   │   ├── site-surface.tsx
│   │   └── blocks/
│   │       ├── trends-block.tsx
│   │       └── weather-block.tsx
│   ├── lib/
│   │   └── supabase.ts         # Supabase client config (browser + server)
│   ├── package.json
│   └── next.config.js
├── worker/                     # Background worker
│   ├── src/
│   │   ├── index.ts            # Entrypoint: config + recursive setTimeout loop
│   │   ├── tick.ts             # Single worker tick: sweep → claim → process
│   │   ├── sweep.ts            # Calls atomic sweep_expired_blocks() RPC
│   │   ├── claim.ts            # Calls atomic claim_pending_intents() RPC
│   │   ├── supabase.ts         # Service role client factory
│   │   ├── processor.ts        # Intent processing logic (Phase 4+)
│   │   ├── claude.ts           # Claude API client + tool loop (Phase 4+)
│   │   ├── tools.ts            # Tool definitions (Phase 4+)
│   │   └── schema.ts           # Zod schemas + block type registry (Phase 4+)
│   ├── package.json
│   └── tsconfig.json
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql  # 5 tables + sequence + RLS + RPCs (sweep, claim, nextval)
└── package.json                    # Root workspace
```

## Realtime Flow

```
User types "show me AI trends"
  → POST /api/intent (password validated server-side)
  → Server inserts into user_intents via service role
  → Returns { id }, user sees "Intent queued"

~5 min later, worker wakes up:
  → Reads pending intent
  → Calls Claude: "User wants AI trends"
  → Claude uses web_search → gets results
  → Claude uses web_fetch → gets article content
  → Claude synthesizes → returns mutations
  → Worker writes to site_state
  → Supabase Realtime pushes change to frontend

Frontend receives realtime event:
  → New trends block appears, UI morphs
  → No page reload needed
```

## Environment Variables

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # Worker + API route (server-side only)

# Claude
ANTHROPIC_API_KEY=

# Worker
CRON_INTERVAL_MS=300000          # 5 minutes

# Access gate (v0)
ACCESS_PASSWORD=                 # Shared password for intent submission
```

## Implementation Phases

Each phase is independently testable. Later phases build on earlier ones but can stub dependencies for isolated testing.

### Test Tooling

| Layer | Tool | Why |
|---|---|---|
| Worker unit + integration (schema, queue, mutations) | **Vitest** | Fast, native TypeScript, same runtime as worker code |
| API routes | **Vitest** + Next.js test helpers | Test route handlers as functions, no browser needed |
| Frontend components | **Vitest** + **React Testing Library** | Component rendering, Realtime event simulation |
| Frontend E2E | **Playwright** | Full browser, real Supabase + worker, visual assertions |
| Schema types | **`tsc --noEmit`** | Compile-time check that Zod schemas produce correct TypeScript types |

All phases 1–5 and 7 use Vitest. Phase 6 uses Vitest for component logic + Playwright for animation/visual tests. Phase 8 is Playwright only (full browser against live services).

### Phase 1 — Database Foundation

Set up all tables, indexes, RLS policies, and the version sequence.

**Deliverables:**
- `001_initial_schema.sql` migration with all 4 tables + sequence
- RLS policies: anon can only SELECT on `site_state`, all other tables service-role-only

**Tests:**
- Migration applies cleanly on a fresh Supabase instance
- Anon role: SELECT on `site_state` succeeds, INSERT/UPDATE/DELETE rejected
- Anon role: all operations on `user_intents`, `processing_logs`, `site_state_history` rejected
- Service role: full CRUD on all tables
- `site_version_seq` increments correctly across multiple `nextval()` calls
- `UNIQUE (site_version, semantic_key)` rejects duplicate blocks within a snapshot
- `UNIQUE (semantic_key)` on `site_state` rejects duplicate keys

---

### Phase 2 — API Layer

Intent submission and status polling routes with access gate.

**Deliverables:**
- `POST /api/intent` — validates password, inserts intent, returns `{ id }`
- `GET /api/intent/[id]` — validates password, returns `{ id, status }`
- Supabase server client using service role key

**Tests:**
- POST without password → 401
- POST with wrong password → 401
- POST with valid password + intent text → 200, returns UUID, row exists in DB with status `pending`
- POST with empty intent text → 400
- GET with valid id → returns correct status
- GET with nonexistent id → 404
- GET without password → 401

---

### Phase 3 — Worker: Queue Management

Atomic claiming, expired block sweep, and status transitions. No LLM yet — use a passthrough stub that marks intents as completed.

**Deliverables:**
- Cron entry point (`index.ts`) with configurable interval
- Expired block sweep query
- Atomic claim query (CTE + FOR UPDATE SKIP LOCKED)
- Status transition logic: pending → processing → completed/failed

**Tests:**

*Sweep (Vitest):*
- Sweep deletes rows where `expires_at < now()`, leaves non-expired rows untouched
- Sweep that deletes rows → produces a `site_versions` entry (with NULL `intent_id`) and `site_state_history` snapshot
- Sweep that deletes nothing → no version allocated, no snapshot
- Sweep snapshot reflects post-deletion state (deleted blocks absent)
- Sweep that deletes the last block → version exists in `site_versions`, zero rows in `site_state_history` (valid empty surface)

*Claiming (Vitest):*
- Claim returns oldest pending intents first when batch is limited
- Claimed intents have status `processing` after the query
- Concurrent claim calls (simulated overlapping workers) never return the same intent
- Already-processing or completed intents are never claimed
- Failed intents stay as `failed`, are not re-claimed

*Tick status transitions (Vitest):*
- Pending intent → processing → completed with `result_summary` after tick
- Processing is visible in DB during claim
- Multiple intents processed in one tick
- Tick is a no-op when no pending intents
- Completed and failed intents are not re-processed

---

### Phase 4 — Worker: LLM Integration

Claude API client with agentic tool loop, Zod validation, and self-correction.

**Deliverables:**
- Claude API client with tool loop (`claude.ts`)
- Zod schemas with `superRefine` cross-validation (`schema.ts`)
- Exported inferred types: `MutationResponse`, `UpsertMutation`, `DeleteMutation`
- Self-correction loop (re-send validation error, up to 3 attempts)
- Tool call logging to `processing_logs`

**Tests:**

*Typecheck (`tsc --noEmit`):*
- `schema.ts` compiles with no errors
- Inferred types (`z.infer<typeof MutationResponseSchema>` etc.) are exported and used by `processor.ts` — a type mismatch between schema and consumer breaks the build

*Schema validation (Vitest, mocked Claude responses, no live API calls):*
- Valid mutation response → passes Zod, returns parsed mutations
- Missing `semantic_key` → Zod rejects
- `semantic_key` prefix doesn't match `block_type` → `superRefine` rejects
- Invalid topic slug (uppercase, spaces, >40 chars) → Zod rejects
- Unknown `block_type` → Zod rejects
- Delete mutation with valid `semantic_key` → passes
- Delete mutation without `semantic_key` → rejects

*Self-correction (Vitest, mocked):*
- First response invalid, second valid → succeeds on attempt 2
- 3 consecutive invalid responses → marks intent `failed`, logs all 3 errors to `processing_logs` with `tool_name: 'schema_validation'`

*Tool loop (Vitest, mocked):*
- Response with `tool_use` block → executes tool, re-sends, loops until final response
- Each tool call logged to `processing_logs` with correct `intent_id`, `tool_name`, `tool_input`, `tool_output`

---

### Phase 5 — Worker: State Mutations & History

Apply validated mutations to `site_state` and snapshot to history.

**Deliverables:**
- Atomic `apply_mutations_and_snapshot()` Postgres RPC: acquires `pg_advisory_xact_lock(42)`, applies upserts/deletes to `site_state`, stamps TTL per block type, allocates version in `site_versions`, snapshots to `site_state_history` — single transaction
- JS-side caller in worker that invokes the RPC with validated mutations + intent ID

**Tests:**

*Mutations (Vitest):*
- Upsert with new `semantic_key` → INSERT, row exists in `site_state`
- Upsert with existing `semantic_key` → UPDATE, `updated_at` changes, `created_at` preserved
- Delete with existing `semantic_key` → row removed from `site_state`
- Delete with nonexistent `semantic_key` → no error, no-op

*TTL determinism (Vitest, frozen clock via `vi.useFakeTimers`):*
- `trends` block gets `expires_at` exactly `now() + 24h` — not approximate, assert to the second
- `weather` block gets `expires_at` exactly `now() + 1h`
- `summary` block gets `expires_at` exactly `now() + 72h`
- TTL is derived solely from `block_type`, not from LLM output — a mutation with an `expires_at` field in content is ignored
- Unknown `block_type` (should never pass validation, but defensively) → throws rather than writing a row with no TTL

*History snapshots (Vitest):*
- All current `site_state` rows appear in `site_state_history` with same `site_version`
- `site_version` is consistent across all rows in a batch
- Two consecutive snapshots have strictly increasing `site_version`
- Intent-triggered snapshot: `site_versions` row has correct `intent_id`
- Sweep-triggered snapshot: `site_versions` row has `intent_id = NULL`
- Empty surface after mutation: `site_versions` row exists, zero rows in `site_state_history`
- A cron run that sweeps expired blocks AND processes intents produces two distinct versions (sweep version < intent version)

*Pipeline (Vitest, mocked LLM):*
- Claim → process → validate → mutate → snapshot → complete — intent ends as `completed` with `result_summary`

---

### Phase 6 — Frontend: Site Surface & Realtime

Render content blocks from `site_state` with live updates and layout-aware transitions.

**Deliverables:**
- Supabase browser client with Realtime subscription on `site_state`
- `site-surface.tsx` — queries initial state, subscribes to changes
- Block components: `trends-block.tsx`, `weather-block.tsx`, `summary-block.tsx`
- Framer Motion `AnimatePresence` + `layout` wrappers

**Tests:**
- Initial load: renders all blocks from `site_state` ordered by `display_order`
- Empty state: shows prompt text and magic bar only
- Realtime INSERT → new block appears in correct position
- Realtime UPDATE → block content updates in place
- Realtime DELETE → block removed from surface
- Block type routing: `trends` data renders trends component, `weather` renders weather, etc.
- Layout animation: insert triggers fade-in + expand (visual/snapshot test)
- Layout animation: removal triggers collapse + fade-out
- Layout animation: reorder triggers positional transition

---

### Phase 7 — Frontend: Magic Bar & Access Gate

User intent input with password protection.

**Deliverables:**
- `access-gate.tsx` — modal that prompts for password, stores in cookie on success
- `magic-bar.tsx` — fixed-bottom input, POSTs to `/api/intent`, shows confirmation
- Status polling: after submit, polls `GET /api/intent/[id]` until completed/failed

**Tests:**
- Gate blocks magic bar until valid password entered
- Invalid password shows error, does not store cookie
- Valid password stores cookie, gate dismissed, persists across reload
- Submit intent: POST fires with correct headers and body
- Confirmation message shown after successful submit
- Polling: status transitions from `pending` → `processing` → `completed` reflected in UI
- Empty input: submit button disabled or submission prevented

---

### Phase 8 — End-to-End Integration

Full loop verification with live Claude API.

**Deliverables:**
- Integration test script that runs the complete flow
- Manual test checklist

**Tests:**
- Type "show me AI trends" → intent created → worker claims → Claude searches + fetches → mutations validated → `site_state` updated → Realtime pushes to frontend → trends block renders
- Type "show the weather in Stockholm" → weather block appears with live data
- Type "remove the weather" → weather block deleted from surface
- Second intent reusing same `semantic_key` → block updated, not duplicated
- After processing: `site_state_history` contains correct versioned snapshot
- Expired block disappears after TTL + next cron sweep
- Two intents submitted before cron runs → both processed in single run, in order

## V0 Scope Boundaries

**In scope:**
- Magic bar → server route → intent queue → worker → Claude reasoning → state mutation → reactive UI
- Access gate (shared password via server route, RLS blocks direct anon inserts)
- Atomic queue claiming (CTE + FOR UPDATE SKIP LOCKED)
- Canonical semantic keys with block type registry and Zod validation
- Self-correction loop (3 attempts) for invalid LLM output
- Worker-side TTL defaults per block type, expired block sweep each cron run
- Site state history with per-intent-run versioned snapshots
- web_search and web_fetch tools
- Trends, weather, and summary block types
- Supabase Realtime with layout-aware Framer Motion transitions
- Basic error handling

**Out of scope for v0:**
- Full authentication / multi-user / per-user state
- Intent deduplication or merging
- Multiple LLM providers
- Custom tool definitions beyond the registry
- Deployment pipeline (local dev is fine)
