-- Per-member, per-number inbox visibility mode.
--
-- The existing `team_member_permissions.lsq_assigned_visibility_only`
-- flag is GLOBAL: ON means the user sees only LSQ-assigned chats
-- across every number they have access to. Operators wanted finer
-- control — "for number A give Riya FULL access, but for number B
-- only the leads LSQ owner = riya@qhtclinic.com". That can't be
-- expressed by a single per-user boolean, so we side-table it here.
--
-- Resolution rule (enforced in lib/permissions.ts):
--   1. If a row exists for (member_id, bpid) → use its `mode`.
--   2. Else → fall back to the global lsq_assigned_visibility_only:
--      true  → 'assigned_only'
--      false → 'full'
--   3. Owners always get 'full' regardless.
--
-- Zero rows = current behavior preserved. App ALSO behaves correctly
-- when this migration hasn't been run yet — the resolver swallows the
-- "relation does not exist" error and returns an empty map.

create table if not exists member_number_access (
  member_id                   uuid not null
    references team_members(id) on delete cascade,
  business_phone_number_id    text not null
    references business_numbers(phone_number_id) on delete cascade,
  mode                        text not null
    check (mode in ('full', 'assigned_only'))
    default 'full',
  created_at                  timestamptz not null default now(),
  primary key (member_id, business_phone_number_id)
);

create index if not exists member_number_access_member_idx
  on member_number_access (member_id);

alter table member_number_access enable row level security;
-- No policies = service role only. The team-permissions API uses the
-- service role client (same as every other team_member_permissions write).
