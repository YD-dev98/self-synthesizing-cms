# Self-Synthesizing CMS

Autonomous web engine where users express intents via a magic bar, a background agent loop (Claude API) processes them, and the frontend morphs in real time. No menus, no admin panel — just intent in, evolved site out.

## Stack

- **Frontend**: Next.js 16 (App Router) + shadcn/ui + Tailwind CSS + Framer Motion
- **Database**: Supabase Postgres (RLS enabled, Realtime on `site_state`)
- **Worker**: Node.js background cron (every 5 min)
- **LLM**: Claude API with `web_search` / `web_fetch` tools
- **Validation**: Zod schemas for all LLM mutation output

## Project Structure

```
web/          → Next.js app (frontend + API routes)
worker/       → Background worker (queue processing, Claude integration)
supabase/     → Migrations and Supabase config
docs/         → product-spec.md and technical-spec.md (source of truth for architecture)
```

## Before Implementing

- Read the relevant phase in `docs/technical-spec.md` before starting any implementation work. Each phase lists deliverables, tests, and scope.
- When editing anything in `web/`, read `web/AGENTS.md` first — it contains framework-specific guidance for this Next.js version.

## Local Development

Prerequisites: Docker Desktop (for local Supabase), Node.js, npm.

```sh
supabase start                  # Start local Supabase (Postgres, Realtime, etc.)
npm test                        # Run all tests (worker + web)
npm test --workspace=worker     # Run worker tests only
npm test --workspace=web        # Run web tests only
```

Local Supabase uses default keys — no `.env` needed for tests. The test helpers in `worker/tests/helpers.ts` and `web/tests/phase2-api.test.ts` hardcode the local defaults.

For the web app dev server, create `web/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase start>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
ACCESS_PASSWORD=<any shared password for v0>
ANTHROPIC_API_KEY=<your key>
```

## Validation

Run these before considering work complete:

```sh
npm test                        # All tests (worker + web)
npm run lint -w web             # ESLint on web/
npm run build -w web            # Next.js production build
```

## Key Conventions

- **Semantic keys**: All `site_state` blocks are identified by `{block_type}:{topic-slug}` (e.g. `trends:ai-industry`). Enforced at both DB (CHECK constraint) and application (Zod) level.
- **RLS boundary**: Anon role can only SELECT on `site_state`. All other tables are service-role-only. Intent submission goes through `/api/intent` server route, never direct DB insert.
- **Site versioning**: Every mutation to `site_state` (intent processing or TTL sweep) produces a versioned snapshot in `site_state_history` via `nextval('site_version_seq')`.
- **Block type registry**: `trends` (24h TTL), `weather` (1h TTL), `summary` (72h TTL). TTLs are stamped by the worker, not the LLM.
- **Schema changes**: Any change to the database schema must update all three: the migration in `supabase/migrations/`, the relevant tests, and `docs/technical-spec.md`. These must stay in sync.

## Specs

Read `docs/technical-spec.md` for schema, architecture, API contracts, and phased implementation plan. Read `docs/product-spec.md` for the product vision and use cases.
