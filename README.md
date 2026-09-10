# Voice AI Agent — Patient Registration System

A voice-based AI agent, reachable **by phone**, that registers patients through natural conversation,
persists them to a database through a validated REST API, and remembers them on the next call.

> **Assessment note:** this repository is the complete, runnable system. The hosted preview runs the
> **web voice simulator** (browser STT/TTS driving the *same* agent engine the phone line uses) because
> a sandbox preview cannot place PSTN calls. The **Architecture tab** in the app and the
> [Provisioning a real phone number](#provisioning-a-real-phone-number) section below document the
> exact steps (Vapi or Twilio) to attach a real, dialable U.S. number to this same deployment.

---

## Live demo / submission checklist

| Item | Where |
|---|---|
| Web app + dashboard | the deployed preview URL (this app) |
| Voice registration | open the app → **Voice Registration** tab → *Start registration call* |
| REST API base | `<APP_BASE_URL>/api` (interactive reference in the **API** tab) |
| Health check | `GET /api/health` |
| Phone number | provisioned via the Vapi/Twilio guides (env-driven, no code changes) |

Demo data only — no real patient data is stored (challenge FAQ). Secrets are provided via
environment variables; nothing is hardcoded (`.env.example` documents every variable).

---

## What the system does

1. A caller dials in (or starts the web simulator) — **Maya**, the AI intake coordinator, greets them.
2. Conversationally collects the **standard minimum U.S. demographic dataset** (17 fields; required
   fields enforced, optionals offered — never pushed).
3. **Validates every field server-side** and re-prompts *specifically* for invalid values
   (e.g. a 3-digit phone, a future date of birth).
4. **Reads everything back** and asks the caller to confirm or correct before saving.
5. Saves through the **same service layer** the REST API uses (`POST /patients` semantics), then
   announces *“You’re all set, [First Name].”* and offers a first appointment.
6. The full transcript + final payload of every call is **persisted and viewable** (Transcripts tab).

### Bonus features (all implemented)

| Bonus | Where |
|---|---|
| **Duplicate detection** — phone match → *“It looks like we already have a record for [Name]. Would you like to update your information instead?”* → update flow via `PUT` semantics | voice agent `duplicate` stage |
| **Appointment scheduling** — post-registration offer, mock slots, real `appointments` table | **Appointments** tab |
| **Multi-language** — say *“Hablo español”* and the call continues in Spanish (read-back included) | deterministic language detection + ES prompts |
| **Call transcript/summary** — full transcript + final payload per call, linked to the patient | `call_sessions` table + **Transcripts** tab |
| **Dashboard** — patients, transcripts, appointments, live call simulator, API playground | the app itself |
| **Automated tests** — 36 tests: validation rules, REST contract, agent state machine (scripted fake LLM) | `tests/`, run with `bun test` |

---

## Architecture

```
Phone Call (real number via Twilio/Vapi, or Web Simulator)
        ⇅
Voice AI Agent  ── deterministic state machine + LLM (extraction & wording)
        ⇅  (writes through the SAME service layer as the REST API)
Database (SQLite via Prisma — patients · call_sessions · appointments)
        ⇅
Web Service (REST API + operations dashboard)
```

### The core design decision: *state machine + LLM hybrid*

A pure-LLM agent drifts (skips confirmation, hallucinates bookings, accepts invalid data).
A rigid IVR is exactly what the challenge forbids. So responsibilities are split:

| Deterministic (code) | LLM (prompted) |
|---|---|
| stage transitions & flow guarantees | natural, warm spoken wording |
| field validation (Zod, shared with REST API) | messy spoken phrasing → normalized fields |
| confirmation read-back text (server-built) | intent classification (yes / no / edit / start-over) |
| duplicate lookup · DB writes · failure handling | graceful handling of corrections & tangents |
| transcript + payload logging | multi-language response generation |

Three safety nets make the rubric-critical behaviors **impossible to drift**:

1. **Server-side re-prompt override** — a rejected field always produces a specific re-ask for that
   field, regardless of what the LLM said.
2. **Intent detection fallback** — if the LLM labels an utterance `auto`, regex intent detection
   (bilingual) infers confirm/decline/slot-pick, so a mis-classification can never skip confirmation
   or hallucinate a booking.
3. **Regex extraction fallback** — high-confidence patterns (phone, ZIP, email, “born …”/“nací el …”)
   are recovered server-side if the LLM misses them.

Full details: [`docs/PROMPT_ENGINEERING.md`](docs/PROMPT_ENGINEERING.md).

---

## Tech stack & justification

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 16 + TypeScript** | one deployable for API + dashboard; typed end-to-end; fastest path to a production-shaped system in 3 hours |
| Database | **Prisma + SQLite** | zero-ops, relational, real constraints + indexes; moving to Postgres = change one env var + provider line |
| Validation | **Zod, single source of truth** | the same schema powers REST 422s, the agent’s per-field re-prompts, and the tests — rules can never drift |
| LLM | **z-ai-web-dev-sdk** (server-side only) | injected as `LlmFn` so the entire agent is unit-testable with a scripted fake |
| Telephony | **Twilio TwiML** + **Vapi tools** | two independent provisioning paths; both reuse the identical conversation engine |
| UI | Tailwind + shadcn/ui | accessible, responsive console with zero custom CSS debt |

---

## Quickstart

```bash
bun install
cp .env.example .env          # defaults work for local dev

bun run db:push               # create schema
bun run db:seed               # 2 demo patients + 1 appointment
bun run dev                   # http://localhost:3000

bun test                      # 36 automated tests (validation · API · agent)
bun run lint                  # ESLint
```

Open the app → **Voice Registration** → *Start registration call*. Speak (Chrome/Edge) or type.

---

## Deploying to Vercel (hosted PostgreSQL)

**Why not SQLite on Vercel?** Serverless functions have a *read-only, ephemeral* filesystem — a
SQLite file cannot exist persistently there, and every query would fail (the app's health badge
shows **DB unreachable**). The **default Prisma schema (`prisma/schema.prisma`) is PostgreSQL**
— that is what production and any reviewer sees. Local development uses a `file:` URL, and
`scripts/prisma-setup.mjs` then automatically selects the `prisma/schema.sqlite.prisma` dev
variant (identical models) — no schema editing ever needed. The build provisions tables + demo
seed automatically, and the app **additionally self-provisions at runtime** (see below).

### Step 1 — Create a hosted Postgres (pick one, all have free tiers)

| Provider | Where | Connection strings |
|---|---|---|
| **Neon** (recommended) | neon.tech → new project | Dashboard → *Connection details*: copy **Pooled connection** and **Direct connection** |
| **Vercel Postgres** | Vercel → **Storage** → *Create Database* → Neon (Postgres) | `.env.local` tab shows `DATABASE_URL` (pooled) + `DIRECT_URL`-style direct string |
| **Supabase** | supabase.com → project → *Connect* | *Transaction pooler* (port 6543) + *Direct connection* (port 5432) |

> ⚠️ **About the "Prisma Postgres" integration on Vercel:** it works, but its `DATABASE_URL` uses
> Prisma's Accelerate protocol (`prisma+postgres://…`), which requires the `@prisma/extension-accelerate`
> client extension instead of the standard engine. For this assessment, **Neon / Vercel Postgres /
> Supabase are the zero-code-change path** (plain `postgresql://` URLs). If you prefer Prisma
> Postgres, follow Prisma's Vercel guide and add the extension to `src/lib/db.ts`.

### Step 2 — Set environment variables in Vercel

Project → **Settings → Environment Variables** (values are secrets — never commit them):

| Key | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://…` (pooled for Neon/Supabase) | runtime queries — if your integration injected `POSTGRES_PRISMA_URL` / `POSTGRES_URL` instead, the build picks those up automatically |
| `DIRECT_DATABASE_URL` | `postgresql://…` (direct, non-pooled) | used by `db push`/`migrate` at build time; falls back to `DATABASE_URL` (or the injected `POSTGRES_URL_NON_POOLING` / `DATABASE_URL_UNPOOLED`) if unset |
| `APP_BASE_URL` | `https://<your-app>.vercel.app` | required for Vapi/Twilio webhooks |
| `DEFAULT_LANGUAGE` | `en` (optional) | `es` for Spanish-first calls |

### Step 3 — Deploy

Push/deploy the project. Vercel detects the **`vercel-build`** script automatically (no custom
Build Command needed) and runs:

```
node scripts/prisma-setup.mjs --push --seed   # generate client → create tables → seed demo data
next build
```

The first deploy creates all tables and seeds 2 demo patients + 1 appointment; later deploys are
no-ops (push is schema-diff based, seed skips when data exists). **Verify**: open
`https://<your-app>.vercel.app/api/health` → `"database": "connected"`, and the header badge flips
from *DB unreachable* to connected.

### Runtime self-provisioning + diagnostics (safety net)

Provisioning happens in **three independent layers**, so a skipped build step can never leave the
app broken:

1. `vercel-build` script (or the `next.config.ts` hook when a custom build command runs) →
   `prisma generate` + `db push` + seed during the build;
2. **runtime bootstrap** — on the first request, `src/lib/db-bootstrap.ts` checks for the
   `patients` table and, if missing, applies idempotent DDL + seeds demo data (race-safe under
   serverless cold starts);
3. **`GET /api/health` diagnostics** — reports which connection env vars are visible, the detected
   provider, the bootstrap result, and any DB error (no secrets exposed). If the badge is ever
   red, this JSON pinpoints the cause immediately.

### Migration-based provisioning (optional, production-grade)

By default the build uses `prisma db push` (self-healing, no migration history). To use classic
migrations instead — e.g. required by change-control policies — an `init` migration ships in
`prisma/migrations/`. Set `PRISMA_MIGRATE="true"` in Vercel env and the build runs
`prisma migrate deploy` against `DIRECT_DATABASE_URL`. Note: pick **one** mode per database;
a DB provisioned with `db push` has no `_prisma_migrations` history, so switch modes only on a
fresh database (or baseline via `prisma migrate resolve --applied`).

### Deploy checklist / troubleshooting

| Symptom | Fix |
|---|---|
| Header still shows **DB unreachable** | `DATABASE_URL` missing/typo'd in Vercel env → set it, **Redeploy** (Deployments → ⋯ → Redeploy) |
| Build log shows `provider=sqlite` on Vercel | No Postgres URL was visible at build time → connect the database (Storage → Connect to project) or add `DATABASE_URL`, then redeploy. (Injected `POSTGRES_PRISMA_URL`/`POSTGRES_URL` are picked up automatically.) |
| `PrismaClient` error about query engine at runtime | Redeploy once — the client is regenerated during every build with the correct engine |
| Build fails at `db push` | Wrong password/host, or DB paused (Neon free tier auto-suspends → wake it by opening the console) |
| `prepared statement … already exists` | You're pointing `DIRECT_DATABASE_URL` at a **pooled** endpoint → use the *direct* (non-pooler) string |
| Works, but empty dashboard | Seed ran before tables? Run once with `PRISMA_SKIP_PUSH` unset, or seed manually (see below) |
| Tables exist, want manual control | Set `PRISMA_SKIP_PUSH="true"` and run `bunx prisma db push` + `bun prisma/seed.ts` locally against the hosted URL |

> **Voice-agent LLM on Vercel:** the agent's LLM (`z-ai-web-dev-sdk`) expects runtime-injected
> credentials; on generic hosts it degrades gracefully to the deterministic fallback extraction
> (regex + state machine), so registration still works end-to-end. For full NLU quality, deploy
> where the SDK is credentialed or swap in a keyed provider (see `.env.example`).

---

## REST API

Consistent envelope on every response: `{ "data": …, "error": null }` /
`{ "data": null, "error": { "message", "details?": … } }`

| Method | Endpoint | Description | Codes |
|---|---|---|---|
| GET | `/api/patients?last_name=&date_of_birth=&phone_number=` | list + filters (DOB as `YYYY-MM-DD`) | 200, 400 |
| GET | `/api/patients/:id` | single by `patient_id` (UUID) | 200, 400, 404 |
| POST | `/api/patients` | create → returns record with `patient_id` | 201, 400, 422 |
| PUT | `/api/patients/:id` | **partial** update | 200, 400, 404, 422 |
| DELETE | `/api/patients/:id` | **soft** delete (sets `deleted_at`; never hard-deletes) | 200, 404 |
| POST | `/api/voice/session` | start a call → `{ session_id, greeting }` | 201 |
| POST | `/api/voice/chat` | one conversational turn | 200, 404, 429 |
| DELETE | `/api/voice/session/:id` | hang up (finalizes transcript) | 200, 404 |
| POST | `/api/telephony/vapi` | Vapi tool-call webhook | 200 |
| POST | `/api/telephony/twilio` | Twilio TwiML webhook | 200 (XML) |
| GET | `/api/appointments` · `?slots=1` | appointments / mock availability | 200 |
| GET | `/api/calls` · `/api/calls/:id` | transcripts + final payloads | 200, 404 |
| GET | `/api/health` · `/api/stats` | liveness / counters | 200 |

Validation failures return **422** with per-field details, e.g.:

```json
{ "data": null, "error": { "message": "Validation failed.", "details": [
  { "field": "phone_number", "message": "phone_number must be a valid U.S. 10-digit phone number." },
  { "field": "date_of_birth", "message": "date_of_birth must be a valid date (MM/DD/YYYY), not in the future." }
] } }
```

All inputs are sanitized (control chars stripped, length-capped) and rate-limited per IP / per session.

---

## Data model (`prisma/schema.prisma`)

The default schema targets **PostgreSQL** (production/Vercel); `prisma/schema.sqlite.prisma` is the
identical local-development variant. It implements the challenge's standard minimum demographic
dataset exactly — types, defaults, and constraints — plus:

- `patient_id` UUID primary key, `created_at`/`updated_at` UTC, `deleted_at` (soft delete)
- indexes on `phone_number`, `last_name`, `date_of_birth` (query params + duplicate lookup)
- `phone_number` intentionally **not** unique — households share phones; duplicates are handled
  conversationally (bonus requirement), not by constraint
- `call_sessions` — per-call transcript (JSON), final collected payload, outcome, language,
  duration, linked patient
- `appointments` — patient, date/time, provider, reason, status

---

## Provisioning a real phone number

Both paths are fully wired — **no code changes needed**, only provider configuration.

### Path A — Vapi (recommended, fastest)

1. Sign up at [vapi.ai](https://vapi.ai) → **Phone Numbers** → buy a U.S. number.
2. Create an Assistant → import the config served at `/docs/vapi-assistant-config.json`
   (it contains the full system prompt, voice, transcriber, and tool wiring).
3. Set the assistant **serverUrl** to `https://<YOUR-DOMAIN>/api/telephony/vapi`.
4. Call the number. Vapi handles telephony/STT/TTS; tool calls
   (`register_patient`, `update_patient`, `get_patient_by_phone`, `schedule_appointment`) hit the
   webhook and write through the same service layer as the REST API.

### Path B — Twilio Programmable Voice

1. Buy a voice-capable U.S. number in the Twilio Console.
2. **A call comes in** → Webhook `POST https://<YOUR-DOMAIN>/api/telephony/twilio`.
3. The webhook runs the same agent engine turn-by-turn: `<Say>` speaks the reply,
   `<Gather input="speech">` listens, loops until the agent is done, then `<Hangup/>`.

For local development/review, expose the dev server with `ngrok http 3000` and use the https URL as
`<YOUR-DOMAIN>` (also set `APP_BASE_URL`).

### Deployment

**Vercel: see [Deploying to Vercel](#deploying-to-vercel-hosted-postgresql) — hosted Postgres,
env vars, automatic table provisioning + seed, and troubleshooting.**

Any Node host works (Railway, Render, Fly.io, VPS). Requirements: Bun/Node 20+, `DATABASE_URL`,
and `APP_BASE_URL` pointing at the public HTTPS origin (needed for telephony webhooks).
`GET /api/health` reports DB connectivity and live sessions for uptime checks. On any host
without a persistent filesystem, use a hosted Postgres as described in the Vercel section —
the same auto-detection applies.

---

## Observability

Every turn logs a structured JSON line to stdout (`level: "voice"`) with the caller utterance, agent
reply, current collected payload, and any rejected fields; the final `PATIENT SAVED` line contains
the complete payload. The same transcript is persisted to `call_sessions` **incrementally after each
turn**, so even a mid-call crash leaves an auditable record (status `abandoned` is reconciled lazily).
API requests log method/path/status/duration.

## Security

- No hardcoded secrets — everything comes from env (`teleska` keys never touch source or client).
- `z-ai-web-dev-sdk` is server-side only; the browser talks only to this app’s API.
- All input sanitized (control chars, whitespace collapse, length caps) + Zod-validated server-side.
- Simple in-memory rate limiting per IP (API) and per session (voice turns).
- Soft delete only — no hard deletes; demo data is fictional.

## Edge cases & resilience (rubric §5)

| Scenario | Behavior |
|---|---|
| Invalid DOB (future / 31 Feb / <1900 / >130y) | rejected server-side → agent re-asks DOB specifically, unambiguously (“month, day, then year”) |
| 3-digit / partial phone | rejected → “could you give me your full 10-digit number, starting with the area code?” |
| Corrections mid-confirmation (“actually, it’s D-A-V-I-S”) | field updated → full read-back repeated |
| Out-of-order answers / multi-field utterances | extraction merges whatever appears; missing fields still collected |
| “Start over” | collected state reset deterministically, flow restarts |
| Hang-up / connection drop mid-call | transcript row finalized as `abandoned` (lazy sweep); partial data retained for audit |
| Database write fails | caller hears a graceful apology, session stays in `confirm` for an automatic retry — never silence |
| LLM unavailable / malformed output | corrective retry → regex extraction fallback → after 3 consecutive failures a polite “call back in a few minutes” and clean session end |
| Caller speaks Spanish | language flips mid-call; prompts, read-back, and booking continue in Spanish |

## Known limitations & trade-offs

- **In-memory session store** — right-sized for one node; a multi-node deploy would back it with Redis
  (patient data is already fully persistent; transcripts are written per-turn).
- **SQLite** — chosen over Postgres for zero-ops within the time limit; Prisma makes the swap trivial.
- **Sex stored as string** — SQLite lacks native enums; constrained via the shared Zod schema.
- **Twilio TTS quality** — the TwiML path uses Twilio voices; the Vapi path (or swapping in
  ElevenLabs) is the production-grade option.
- **Mock providers/slots** for appointments, as permitted by the challenge.
- **The sandbox preview cannot place real PSTN calls** — documented per the challenge FAQ
  (“What if I can’t get a phone number provisioned in time?”): the full provisioning paths are
  included and require only provider-dashboard steps + one env var.

## Next steps (given more time)

1. Redis-backed sessions + Postgres migration; containerize for Railway/Fly.
2. Stream-audio Twilio Media Streams implementation (lower latency than the TwiML loop).
3. Call summaries via LLM on session end; operator handoff keyword.
4. Auth on the dashboard + PHI-safe logging policy for anything beyond demo data.
5. Coverage expansion: property-based tests on validators; load test the voice endpoint.
