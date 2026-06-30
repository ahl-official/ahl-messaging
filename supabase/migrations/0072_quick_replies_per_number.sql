-- =====================================================================
-- 0072 — Per-business-number quick replies
-- ---------------------------------------------------------------------
-- Quick replies used to be global across the workspace. We now scope
-- each row to a list of business phone numbers — empty array means
-- "all numbers" (the prior behaviour, preserved for existing rows).
--
-- The old `(shortcut)` UNIQUE index becomes invalid once two numbers
-- can each have their own "/hours" snippet. Drop it; the API is the
-- one enforcing uniqueness within the per-number scope.
-- =====================================================================

alter table public.quick_replies
  add column if not exists business_phone_number_ids text[] not null default '{}';

-- Drop the old single-column shortcut uniqueness. Two numbers' snippets
-- routinely collide (e.g. /hours for both clinic numbers) — operator
-- picks which numbers a snippet covers when creating it.
drop index if exists quick_replies_shortcut_uidx;

-- Fast-path filter: contains-any on business_phone_number_ids. Used by
-- the GET endpoint to scope the list to the active number tab.
create index if not exists quick_replies_bpids_gin
  on public.quick_replies using gin (business_phone_number_ids);
