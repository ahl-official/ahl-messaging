-- Track how many recipients have viewed each posted WhatsApp Status.
--
-- WhatsApp returns "seen" receipts per status broadcast (the eye icon
-- in Status → Seen by). Evolution surfaces these via the userReceipt
-- array on the underlying message row. We fetch and cache the
-- aggregate count here so the dashboard can show "X views" without
-- round-tripping for every render.
--
-- seen_by holds the JIDs that viewed, so a future "who viewed this?"
-- detail view can render names without another fetch.

alter table evolution_status_posts
  add column if not exists seen_count int not null default 0,
  add column if not exists seen_by jsonb not null default '[]'::jsonb,
  add column if not exists last_views_synced_at timestamptz;

-- Speed up the "most-recently-synced first" panel ordering.
create index if not exists evolution_status_posts_posted_at_idx
  on evolution_status_posts (posted_at desc);
