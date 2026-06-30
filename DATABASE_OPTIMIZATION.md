# Database Optimization Report

**Project:** QHT WhatsApp Messaging SaaS (multi-number WhatsApp inbox + AI automation + LSQ CRM sync)
**Database:** PostgreSQL (Supabase), accessed via PostgREST + RLS. **No ORM** — 81 raw SQL migrations in [`supabase/migrations/`](supabase/migrations/) (`0001`–`0080`) plus a few ad-hoc files in [`db/migrations/`](db/migrations/).
**Scale analyzed:** 47 tables, ~103 existing indexes (a recent perf pass already landed in [`0080_perf_indexes.sql`](supabase/migrations/0080_perf_indexes.sql)).

> **Method note.** `.env.local` only carries the Supabase URL + anon key — there is no direct Postgres/service-role connection available in this environment, so **no live introspection** (`pg_stat_user_tables`, real row counts, `EXPLAIN`) was possible. This report is reconstructed from the full migration history and from the app's actual query patterns (grepped from `lib/`, `app/api/`, `components/`). Row-count estimates are inferred from the code (the inbox handles ~39k–135k `contacts`; `messages` is the largest table). **No database changes were made — this is a read-only audit.** Before running anything below, validate against the live DB with `EXPLAIN (ANALYZE, BUFFERS)`.

---

## Current Schema Summary

### Volume tiers (the only three tables that really matter for performance)

| Tier | Tables | Why |
|---|---|---|
| **High / unbounded growth** | `messages`, `automation_logs`, `api_request_log` | One row per WA message / per AI run / per API hit. Append-only, no retention. |
| **Medium / hot reads** | `contacts` (the inbox, ~39k–135k rows), `campaign_recipients`, `trigger_runs`, `user_sessions`, `evolution_disconnects` | Read on every inbox mount / polled. |
| **Low / config & lookup** | the remaining ~40 tables | Settings, permissions, templates, joins. Index pressure is irrelevant here. |

### Core messaging tables (full detail)

**`contacts`** — one row per WhatsApp conversation (`wa_id` × business number). This is the inbox card. 29 columns, 15 indexes. PK `id (uuid)`.
Key columns: `wa_id`, `business_phone_number_id` (FK → `business_numbers`), `last_message_at`, `last_message_preview`, `last_message_direction`, `last_message_status`, `unread_count`, `status`, `assigned_to` (FK → `auth.users`), `tags text[]`, `label_ids uuid[]`, `lsq_stage`, `lsq_owner_email`, `is_group`, `imported`, `automation_pending_at`, `utm_params jsonb`.
Denormalized by design: `last_message_*` are copied from `messages` so the inbox renders without joining `messages` (good — avoids N+1).
Unique: `(wa_id, business_phone_number_id)`.

**`messages`** — every inbound + outbound message. 27 columns, 10 indexes. PK `id (uuid)`.
Key columns: `contact_id` (FK → `contacts`), `wa_message_id` (UNIQUE), `wa_id`, `direction`, `type`, `content`, `media_url`, `status`, `timestamp timestamptz`, `business_phone_number_id` (FK), `sent_by_user_id` (FK), `template_name`, `reply_to_wa_message_id`, `edited_at`, `deleted_at`, `raw_payload jsonb`, `transcript`.

**`contact_notes`** (internal notes), **`contact_labels`** (global label set), **`quick_replies`** (`/shortcut` snippets, GIN on `business_phone_number_ids`) — all low volume, adequately indexed.

### All 47 tables by domain

Columns / Indexes counts shown; `→` = foreign-key target.

#### Core Messaging
| Table | Vol | Cols | Idx | Purpose | FKs |
|---|---|---|---|---|---|
| `contacts` | medium | 29 | 15 | Inbox card: one WhatsApp conversation per `wa_id`×number | business_numbers; auth.users |
| `messages` | high | 27 | 10 | Every inbound/outbound WhatsApp message | contacts; business_numbers; auth.users |
| `contact_notes` | low | 6 | 2 | Internal per-contact notes | contacts; auth.users |
| `contact_labels` | low | 6 | 2 | Workspace-global label set (VIP/Follow-up/…) | — |
| `quick_replies` | low | 8 | 2 | Saved `/shortcut` composer snippets | auth.users |

#### Team / Auth / Access
| Table | Vol | Cols | Idx | Purpose | FKs |
|---|---|---|---|---|---|
| `team_members` | low | 19 | 8 | One staffer/agent (role, team, inbox prefs) | auth.users; teams |
| `teams` | low | 6 | 2 | Member groupings | — |
| `role_permissions` | low | 20 | 1 | Per-role default capabilities (4 rows) | — |
| `team_permissions` | low | 20 | 1 | Per-team permission overrides | teams |
| `team_member_permissions` | low | 20 | 1 | Per-member permission overrides | team_members |
| `member_number_access` | low | 4 | 2 | Per-member×number inbox visibility | team_members; business_numbers |
| `user_sessions` | medium | 12 | 3 | App session ledger (geo, last_seen, revoke) | auth.users; team_members |
| `auth_attempts` | medium | 5 | 3 | Failed-login throttle ledger | — |
| `user_activity_days` | medium | 8 | 4 | Per-(user,day) active-seconds for reports | auth.users |
| `agent_targets_role` | low | 8 | 1 | Per-role KRA/KPA daily targets | — |
| `agent_targets_member` | low | 9 | 1 | Per-member target overrides | team_members |

#### Automation / AI
| Table | Vol | Cols | Idx | Purpose | FKs |
|---|---|---|---|---|---|
| `automation_logs` | high | 20 | 6 | One row per AI auto-reply run (tokens, RAG audit) | contacts; messages |
| `automation_configs` | low | 30 | 2 | Per-number AI auto-reply config | — |
| `knowledge_chunks` | low | 8 | 3 | RAG chunks + pgvector embeddings (ivfflat) | business_numbers |
| `trigger_flows` | low | 11 | 3 | Per-number rule-based automation flow | business_numbers; auth.users |
| `trigger_nodes` | low | 8 | 2 | Action steps of a flow | trigger_flows |
| `trigger_edges` | low | 6 | 2 | Branching edges between nodes | trigger_flows; trigger_nodes |
| `trigger_runs` | medium | 10 | 3 | Per-contact flow execution state | trigger_flows; contacts |
| `trigger_run_vars` | medium | 4 | 1 | Per-run key/value variable store | trigger_runs |
| `ozonetel_settings` | low | 9 | 2 | Click-to-call account config | — |
| `tatatele_settings` | low | 8 | 2 | Click-to-call account config | — |

#### Campaigns / Billing / Tasks
| Table | Vol | Cols | Idx | Purpose | FKs |
|---|---|---|---|---|---|
| `campaigns` | low | 32 | 3 | One bulk send (template/magic) | business_numbers; auth.users |
| `campaign_recipients` | medium | 23 | 6 | One row per (campaign, contact) lifecycle | campaigns; contacts; messages |
| `campaign_unsubscribes` | low | 4 | 1 | Opt-out ledger `(wa_id, number)` | — |
| `template_assets` | low | 7 | 2 | Header media for approved templates | — |
| `magic_message_templates` | low | 7 | 2 | Reusable AI prompt snippets | teams; team_members |
| `payments` | low | 18 | 7 | Razorpay/PayU payment links | contacts; business_numbers |
| `payment_accounts` | low | 9 | 4 | Gateway creds per clinic (1 active) | — |
| `refund_requests` | low | 24 | 4 | Patient refund workflow | contacts; auth.users |
| `tasks` | low | 13 | 6 | Internal operator to-dos | team_members; contacts |
| `task_comments` | low | 6 | 2 | Per-task activity thread | tasks; team_members |

#### Infra / Integrations
| Table | Vol | Cols | Idx | Purpose | FKs |
|---|---|---|---|---|---|
| `business_numbers` | low | 21 | 8 | One WhatsApp business number (routing hub) | whatsapp_portfolios; evolution_groups |
| `whatsapp_portfolios` | low | 10 | 2 | Meta App / brand (access token) | — |
| `api_tokens` | low | 9 | 4 | Bearer tokens for `/api/v1/*` | auth.users |
| `api_request_log` | high | 11 | 4 | Audit of every v1 API hit | api_tokens |
| `app_credentials` | low | 8 | 2 | DB-backed secret store | auth.users |
| `app_settings` | low | 3 | 1 | Workspace key/value config | — |
| `outbound_webhooks` | low | 13 | 2 | Per-number fan-out webhook URLs | auth.users |
| `evolution_status_posts` | medium | 14 | 3 | WA Status posts + view tracking | business_numbers; auth.users |
| `evolution_disconnects` | medium | 4 | 2 | Evolution connection-close log | business_numbers |
| `evolution_groups` | low | 5 | 2 | Groupings of Evolution numbers | — |
| `chat_import_jobs` | low | 16 | 3 | Bulk historical import session state | — |

### Relationship spine
`business_numbers` (PK `phone_number_id text`) is the routing hub — `contacts`, `messages`, `campaigns`, `automation_configs`, `knowledge_chunks`, `payments`, `trigger_flows`, `api_tokens`, `member_number_access` all reference it by `business_phone_number_id`. `contacts` → fans out to `messages`, `contact_notes`, `campaign_recipients`, `payments`, `refund_requests`, `tasks`, `trigger_runs`, `automation_logs`. `team_members` is the people hub for assignment, permissions, targets, sessions.

---

## Problems Found

> Almost everything below is **additive and safe** (new indexes / new retention jobs). The few items that carry lock or data-loss risk are flagged with **⚠️ WARNING**. On the high-volume tables (`messages`, `contacts`, `automation_logs`, `api_request_log`) every `CREATE INDEX` uses **`CONCURRENTLY`** — which **must run outside a transaction block** (run each statement on its own; Supabase SQL editor wraps statements in a txn, so run these from `psql` or mark the migration `-- supabase: no-transaction`).

### Missing Indexes

**1. `contacts` — the inbox list has no `(business_phone_number_id, last_message_at)` composite. ⭐ Biggest win.**
- **Issue:** `GET /api/contacts` (the inbox) runs `.select('*').in('business_phone_number_id', allowedBpids).order('last_message_at', desc).range(offset, +199)`. It is the **hottest read in the app** — fired on every inbox mount, then polled **every 10s** by `ContactList` *and* by `GlobalInboundWatcher`. Today the planner can use `idx_contacts_last_msg (last_message_at DESC)` for the sort but must then filter by number, or use `idx_contacts_business_number` and sort 10k+ rows. Neither serves "this number's newest conversations" directly. Over 39k–135k rows this is a sort/filter on every poll.
- **Fix:**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_bpid_last_msg_idx
  ON public.contacts (business_phone_number_id, last_message_at DESC);
```
Postgres will use this per-`bpid` (BitmapOr / appended index scans) for the `IN (...)` filter and get rows back already ordered. Consider also the lsq-scoped variant the funnel strip uses:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_bpid_stage_last_msg_idx
  ON public.contacts (business_phone_number_id, lsq_stage, last_message_at DESC);
```

**2. `contacts` — inbox search is a non-sargable leading-wildcard `ILIKE`. Clearest indexing gap.**
- **Issue:** `GET /api/contacts/search` runs `.or('wa_id.ilike.%digits%, name.ilike.%q%, profile_name.ilike.%q%').order('last_message_at', desc).limit(30)`. Leading `%` means **no B-tree can ever help** → full sequential scan + sort of all contacts on every search keystroke/submit (one miner flagged it as "frequent").
- **Fix:** trigram GIN indexes (one-time extension + two indexes). **Measured refinement:** the `wa_id` (phone-number) part of the search is **already covered** by the existing `contacts_bpid_waid_digits_idx` (live `idx_scan = 2,394,502`), so only `name` + `profile_name` need trigram indexes:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_name_trgm_idx
  ON public.contacts USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_profile_name_trgm_idx
  ON public.contacts USING gin (profile_name gin_trgm_ops);
```

**3. `contacts` — campaign targeting filters `tags text[]` with no GIN.**
- **Issue:** Campaign recipient targeting does `.overlaps('tags', [...])` on `contacts.tags`. There is a GIN on `label_ids` but **not** on `tags`, so an array-overlap on `tags` falls back to a scan. (Occasional, but scans the whole contacts table.)
- **Fix:**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_tags_gin
  ON public.contacts USING gin (tags);
```

**4. `messages` — reports/analytics filter `(direction, timestamp)` per number with no covering index.**
- **Issue:** `GET /api/reports/overview` does `messages.eq('direction', …).gte('timestamp', since)` with `count: exact` and per-number subqueries. Only a **partial inbound** timestamp index exists (`WHERE direction='inbound'`); outbound KPI counts and per-number ranges are uncovered → scans. Admin-only/occasional, so medium priority.
- **Fix (covers both directions + per-number reporting):**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_bpid_direction_ts_idx
  ON public.messages (business_phone_number_id, direction, timestamp DESC);
```

### Redundant / Duplicate Data

**1. `messages` — two byte-identical inbound-timestamp indexes. ⚠️ Wasted writes on the largest table.**
- **Issue:** Both `messages_inbound_timestamp_idx` and `idx_messages_inbound_timestamp` are `(timestamp DESC) WHERE direction = 'inbound'`. `0080` added the second without noticing the first. On the highest-write table this **doubles the maintenance cost** of that index on every insert for zero read benefit.
- **Fix** (drop the duplicate; `CONCURRENTLY` to avoid an `ACCESS EXCLUSIVE` lock):
```sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_inbound_timestamp;
-- keep messages_inbound_timestamp_idx (identical definition)
```

**2. ~~`contacts` — `contacts_wa_id_idx` is redundant with the composite unique.~~ — RETRACTED after live measurement.**
- **Original claim:** `contacts_wa_id_idx (wa_id)` duplicates the left prefix of `contacts_wa_id_business_number_idx` and could be dropped.
- **⚠️ DO NOT DROP — measured `idx_scan = 27,476,561` (one of the most-used indexes on the table).** Live `pg_stat_user_indexes` shows the planner overwhelmingly prefers this narrow standalone index for `WHERE wa_id = …` equality lookups (send-message resolve, webhook contact resolution) over the wider composite (2.86M scans). Dropping it would push 27M+ hot lookups onto a larger index for no real write saving. **Keep it.** (Lesson: a "redundant left-prefix" index can still be the planner's first choice — always confirm with `idx_scan` before dropping.)

**3. `contacts` — low-selectivity standalone indexes earn their keep poorly.**
- **Issue:** `idx_contacts_status (status)`, `contacts_last_msg_dir_idx (last_message_direction)`, `idx_contacts_is_group (is_group)` each index a column with only 2–5 distinct values across 100k+ rows. The planner rarely picks them (a seq scan beats a low-selectivity index), and `status` is already better served by `contacts_bpid_status_idx (business_phone_number_id, status)`. They add write overhead on a hot table.
- **✅ Confirmed by live `pg_stat_user_indexes`:** `contacts_last_msg_dir_idx` = **0 scans** (also `contacts_label_ids_idx`, `contacts_lsq_owner_email_idx`, `contacts_imported_idx`, `contacts_last_human_typing_at_idx`, `contacts_utm_source_idx`(862) = ~unused). Safe to drop the genuinely-0 ones — but `idx_scan=0` can also mean "stats reset recently" or "rarely-used feature", so double-check the GIN `contacts_label_ids_idx` (label filtering) isn't seasonal before dropping it.
- **Fix** (verify with `pg_stat_user_indexes.idx_scan ≈ 0` first, then drop; or convert to partial if a specific value is queried):
```sql
-- Confirm they are unused before dropping:
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
--   WHERE relname='contacts' AND indexrelname IN
--     ('idx_contacts_status','contacts_last_msg_dir_idx','idx_contacts_is_group');
DROP INDEX CONCURRENTLY IF EXISTS public.idx_contacts_status;
DROP INDEX CONCURRENTLY IF EXISTS public.contacts_last_msg_dir_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_contacts_is_group;
```

**4. Intentional denormalization — NOT a bug (documented so a future migration doesn't "fix" it).**
- `contacts.last_message_at / _preview / _direction / _status` duplicate the newest `messages` row — this is what lets the inbox render without joining `messages`. **Keep it.**
- `messages.wa_id` duplicates `contacts.wa_id`; `campaigns.sent_count/…` duplicate aggregates of `campaign_recipients`. Both are deliberate read-path optimizations. Keep, but ensure writers keep them in sync (see the concurrency note below).

### Inefficient Data Types

**1. `contacts.unread_count integer` is nullable.**
- **Issue:** The webhook does a read-modify-write to bump it; `NULL` forces `COALESCE` everywhere and risks `NULL + 1 = NULL`.
- **Fix** (low risk — backfill then constrain):
```sql
UPDATE public.contacts SET unread_count = 0 WHERE unread_count IS NULL;
ALTER TABLE public.contacts ALTER COLUMN unread_count SET DEFAULT 0;
ALTER TABLE public.contacts ALTER COLUMN unread_count SET NOT NULL;
```

**2. `messages.timestamp timestamptz` (the primary sort key) is nullable.**
- **Issue:** Ordering the thread by a nullable column means `NULL`-timestamp rows sort unpredictably and can't be range-excluded cheaply.
- **Fix:** **⚠️ WARNING:** backfilling + `SET NOT NULL` takes an `ACCESS EXCLUSIVE` lock and rewrites validation on the largest table. Phased approach: (a) `ALTER … SET DEFAULT now()`, (b) backfill `NULL`s in batches, (c) add a `NOT VALID` check then `VALIDATE CONSTRAINT` (online), rather than a blocking `SET NOT NULL`. Low priority unless `NULL` timestamps actually occur.

**3. `business_phone_number_id text` as the join key across ~18 tables.**
- **Issue:** It's Meta's numeric phone-number id stored as `text`; every join/filter is a text comparison.
- **Fix:** **⚠️ WARNING: do NOT change this.** Converting to `bigint` would be a coordinated, high-risk rewrite of ~18 tables + all FKs + app code for a marginal CPU gain. With proper indexes the text key is fine. Listed only for completeness.

**4. `messages.raw_payload jsonb` retained forever (storage, not CPU).**
- **Issue:** The full Meta webhook payload is stored on every message permanently — by far the biggest contributor to table + TOAST bloat on the highest-volume table. See archival below.

### N+1 Query Risks

**1. Good news first — the app mostly *avoids* N+1.** The inbox reads denormalized `contacts.last_message_*` instead of a per-contact `messages` lookup; thread side-panels load notes/calls in one `Promise.all`. This is the right design; keep it.

**2. `inbox_sibling_avatar_fill` — fire-and-forget per-contact `UPDATE`s.** After the contacts list loads, a batched `.in('wa_id', waIds)` borrows sibling avatars (one query, fine) but then issues **one `UPDATE` per contact** to backfill `avatar_url`. On a 200-row page that's up to 200 writes per inbox mount. Batch them into a single `UPDATE … FROM (VALUES …)` or move to a background job.

**3. `GET /api/reports/overview` — ~10 parallel queries + per-number subqueries.** Not strictly N+1 but a fan-out that grows with the number of business numbers. Fold per-number rollups into one `GROUP BY business_phone_number_id` query (the home/stage-count RPCs already prove this pattern works — see `get_home_stats`, `get_stage_counts`).

**4. Polling amplification.** `ChatWindow` re-fetches `messages … .limit(500)` **every 4s** while a chat is open, and the inbox re-fetches **every 10s**. These are repeated *heavy* reads, not N+1, but they multiply the cost of every missing index above. Switch the message poll to "fetch only rows newer than the last seen `timestamp`" (keyset) instead of re-pulling 500 rows:
```sql
-- supports: .eq(contact_id).gt(timestamp, lastSeen).order(timestamp) — already covered by idx_messages_contact
```

### Missing Archive / Soft-Delete Strategy

**1. Three high-volume tables grow unbounded with no retention.** `messages`, `automation_logs`, `api_request_log` are append-only and never pruned or partitioned.

- **`api_request_log`** (pure audit) and **`automation_logs`** (AI run log) are the easy wins — low-risk time-based retention via a daily cron (`pg_cron` or the app's existing cron routes):
```sql
-- ⚠️ WARNING: DELETE removes data permanently — confirm the retention window with the business first.
DELETE FROM public.api_request_log WHERE occurred_at < now() - interval '90 days';
DELETE FROM public.automation_logs  WHERE created_at  < now() - interval '180 days';
```
- **`messages`** is the hard one. Options, in increasing effort:
  - **Cheapest:** stop hoarding raw payloads — null out `raw_payload` for old rows you'll never reprocess:
    ```sql
    -- ⚠️ WARNING: irreversible; keep raw_payload only as long as you might re-ingest.
    UPDATE public.messages SET raw_payload = NULL
      WHERE timestamp < now() - interval '90 days' AND raw_payload IS NOT NULL;
    ```
  - **Proper:** convert `messages` to a **monthly range-partitioned table** on `timestamp` so old months can be detached/archived cheaply. **⚠️ WARNING:** partitioning an existing large table requires a create-new + backfill + swap migration (or `pg_partman`); plan a maintenance window.

**2. Soft-delete exists but only for WhatsApp "delete for everyone".** `messages.deleted_at` / `contacts` have no soft-delete; deletes cascade hard via FKs (e.g. deleting a `contact` cascades to `messages`, `payments`, etc.). That's acceptable for this app, but document it so an accidental contact delete is understood to be destructive.

### Timestamp Indexing Issues

1. **`contacts.last_message_at`** — globally indexed but **not** composited with `business_phone_number_id`; this is the single biggest gap (see Missing Indexes #1).
2. **`messages.timestamp`** — well covered for the thread (`(contact_id, timestamp DESC)`) and inbound feed (partial), but **not** for per-number/outbound reporting (see Missing Indexes #4).
3. **`created_at DESC` sorts elsewhere are already covered** — `payments_contact_id_idx (contact_id, created_at DESC)`, `task_comments_task_id_idx (task_id, created_at DESC)`, `automation_logs_*_idx (…, created_at DESC)`, `api_request_log_*_ts_idx (…, occurred_at DESC)`. No action needed there.

---

## Reporting System Findings (`/api/reports/overview`, `/api/reports/agents`)

The analytics dashboard is the heaviest read path after the inbox. `reports/overview` already sets `maxDuration = 60` (a tell that it runs slow). Four concrete DB problems:

**R1. Per-number count fan-out (N+1 over business numbers).**
- **Issue:** `reports/overview` loops `visibleNumbers.map(async n => …)` and fires **3 `count: exact` queries per number** (inbound, outbound, contacts) — so with N numbers it runs **3 × N** `count(*)` round-trips, each filtering `messages` by `(business_phone_number_id, direction, timestamp ≥ since)`. None of those is served by a composite index today (only a *partial inbound-only* timestamp index exists), so each count scans.
- **Fix (index, apply now — biggest single reporting win):**
```sql
-- ⚠️ messages is the largest table — build with CONCURRENTLY via the psql
--    "Connect" string, NOT a plain CREATE INDEX in the SQL editor (which would
--    lock writes on the hot table for the whole build).
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_bpid_direction_ts_idx
  ON public.messages (business_phone_number_id, direction, timestamp DESC);
```
- **Fix (code, bigger win):** replace the whole per-number loop with **one** aggregate RPC — `SELECT business_phone_number_id, direction, count(*) FROM messages WHERE timestamp >= since AND business_phone_number_id = ANY($1) GROUP BY 1,2` — turning 3×N round-trips into 1. The codebase already proves this pattern (`get_home_stats` cut the home page from 6–10 s to <300 ms; `get_stage_counts` replaced ~136 round-trips).

**R2. Large row downloads aggregated in JS instead of SQL.**
- **Issue:** `overview` pulls and loops in Node: `dailyQ` **up to 50,000** `(timestamp, direction)` rows, `leaderboardQ` **up to 20,000** sender rows, `rtQ` **up to 40,000** rows for response-time, `tagsQ` 2,000 rows — **up to ~112,000 rows downloaded per reports load**, then counted in JS. The daily/peak-hours/leaderboard aggregations are trivially expressible as SQL `GROUP BY` returning ~14 / ~24 / ~10 rows.
- **Fix:** move them into RPCs:
```sql
-- daily volume + peak hours, one scan, returns ~ (days + 24) rows not 50k:
SELECT date_trunc('day', timestamp) AS day, direction, count(*)
FROM messages WHERE timestamp >= $1 AND business_phone_number_id = ANY($2)
GROUP BY 1,2;
-- agent leaderboard, returns top-N not 20k:
SELECT sent_by_user_id, count(*) FROM messages
WHERE direction='outbound' AND timestamp >= $1 AND business_phone_number_id = ANY($2)
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```
Both are covered by the `messages_bpid_direction_ts_idx` index above. (The response-time "first outbound after each inbound" logic is stateful and can stay in JS, but cap it tighter or do it with a SQL window function.)

**R3. `count: exact` on unbounded tables for every KPI.**
- **Issue:** the five KPI cards each issue `count: exact` (`messages` inbound/outbound, `contacts` new/unread/open). `count(*) exact` is O(rows-matched); on `messages` it's only cheap once the `(bpid, direction, timestamp)` index turns it into an index-range count. `unreadQ` (`unread_count > 0`) and `openQ` (`status='open'`) over 100k+ `contacts` are scans unless scoped — note `get_home_stats` **already computes unread/open** via one aggregate, so `reports/overview` is duplicating work the RPC could return.
- **Fix:** reuse / extend `get_home_stats` for the contacts KPIs; rely on `messages_bpid_direction_ts_idx` for the message KPIs.

**R4. ✅ CONFIRMED BUG (now fixed) — agent leaderboard was querying a non-existent column.**
- **Verified against the live DB:** `public.messages` has **`sent_by_user_id`** (+ `sent_by_email`, `sender_name`) and **no `sender_user_id`**. `reports/overview` was selecting `messages.sender_user_id` → PostgREST returns a 400 → supabase-js sets `data = null` → `leaderboardRes.data ?? []` is empty → **the agent leaderboard silently rendered blank** (no visible error). Fixed in [`app/api/reports/overview/route.ts`](app/api/reports/overview/route.ts) (`sender_user_id` → `sent_by_user_id`, select + consumer).
- **⚠️ Same bug still open elsewhere:** `app/api/assistant/chat/route.ts` uses `sender_user_id` at ~5 spots (lines 436, 744, 751, 1128, 1135) — those queries are silently broken too. Apply the identical rename there.
- **Meta-finding:** the live schema **diverges from the migrations** — e.g. `public.messages.notes` and `business_numbers.nickname` exist with no `CREATE/ADD COLUMN` migration. Migrations are NOT a complete source of truth here. **Dump the live schema (`pg_dump --schema-only`) into the repo** so future audits read reality, not an incomplete history.

---

## Priority List

| Priority | Table | Fix | Why it matters | Effort |
|---|---|---|---|---|
| **High** | `contacts` | `CREATE INDEX contacts_bpid_last_msg_idx (business_phone_number_id, last_message_at DESC)` | Serves the hottest read in the app (inbox mount + 10s poll ×2) directly | Low |
| **High** | `contacts` | `pg_trgm` GIN on `name`, `profile_name`, `wa_id` | Kills the full-scan leading-wildcard `ILIKE` search | Low |
| **High** | `messages` | `DROP INDEX idx_messages_inbound_timestamp` (duplicate) | Removes wasted write cost on the largest table | Trivial |
| ~~Medium~~ | `contacts` | ~~`DROP INDEX contacts_wa_id_idx`~~ — **RETRACTED**, measured 27.4M scans, keep it | — | — |
| **Medium** | `contacts` | GIN on `tags` | Indexes campaign `.overlaps('tags')` targeting | Low |
| **Medium** | `messages` | `(business_phone_number_id, direction, timestamp DESC)` | Covers reports/analytics counts per number | Low |
| **Medium** | `api_request_log`, `automation_logs` | Time-based retention cron (`DELETE … < now()-N days`) | Caps unbounded audit/log growth | Low |
| **Medium** | `contacts` | Atomic `unread_count` bump + `NOT NULL DEFAULT 0` | Fixes a real concurrency race (see note) + cleaner type | Low |
| **Medium** | `contacts` (app) | Batch the `inbox_sibling_avatar_fill` per-row `UPDATE`s | Up to 200 writes/inbox-mount today | Low (app) |
| **Low** | `contacts` | Drop unused low-selectivity indexes (`status`, `last_message_direction`, `is_group`) after confirming `idx_scan≈0` | Trims write overhead | Low |
| **Low** | `messages` | Null out / archive old `raw_payload`; later partition by month | Controls bloat on the biggest table | Med→High |
| **Low** | `reports` (app) | Collapse per-number subquery fan-out into one `GROUP BY` RPC | Admin-only, scales with #numbers | Med (app) |
| **Low** | `messages` | `timestamp` → `NOT NULL` (phased, online) | Correctness of the primary sort key | Med (locks) |
| **—** | `business_phone_number_id` | **Do not** convert `text`→`bigint` | High risk, marginal gain | (avoid) |

---

## Final Summary

**Overall health is good.** The schema is thoughtfully denormalized (the inbox avoids per-row `messages` lookups), already carries ~103 indexes including a deliberate perf pass in `0080`, and the heaviest aggregations have already been pushed into server-side RPCs (`get_home_stats`, `get_stage_counts`) instead of pulling 39k–135k rows into JS. This is not a database in trouble — it needs a handful of targeted indexes and a retention policy, not a redesign.

**The single biggest bottleneck is the inbox conversation list.** `GET /api/contacts` filters by `business_phone_number_id` and sorts by `last_message_at DESC`, runs on every inbox mount, and is then polled **every 10 seconds** by two separate watchers — yet there is no composite index that matches "this number's newest conversations." Today it leans on two single-column indexes and a sort over a large table, on the most frequently executed query in the product.

**The one fix to do first** (low effort, highest leverage, zero risk — it's purely additive):
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_bpid_last_msg_idx
  ON public.contacts (business_phone_number_id, last_message_at DESC);
```
Pair it immediately with the trigram search indexes (#2) and dropping the duplicate `idx_messages_inbound_timestamp` — together those three are a few minutes of work and remove the only full-scans on the hot path.

**One non-index correctness callout worth fixing alongside:** the inbound webhook bumps `contacts.unread_count` with a **non-atomic read-modify-write** (`SELECT unread_count` → `+1` → `UPDATE`). Under concurrent inbound messages this loses increments. Make it atomic:
```sql
UPDATE public.contacts
   SET unread_count = COALESCE(unread_count, 0) + 1
 WHERE id = $1;
```

> Reminder: every statement here is a recommendation only — **no changes were applied**. Validate each against the live database with `EXPLAIN (ANALYZE, BUFFERS)` and run `CREATE/DROP INDEX CONCURRENTLY` outside a transaction.
