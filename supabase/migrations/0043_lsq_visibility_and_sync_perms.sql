-- Adds two capability flags used by the LSQ-aware inbox flow:
--   • lsq_assigned_visibility_only — when ON for a role/member, the
--     inbox only surfaces contacts whose LSQ lead owner email matches
--     this user's email. Gives junior agents a focused queue.
--   • can_sync_lsq_owner — when ON, dashboard contact assignment also
--     pushes the new owner to LSQ so the lead owner field there stays
--     in sync with the dashboard's assigned_to_email.
--
-- Defaults mirror existing behaviour:
--   • lsq_assigned_visibility_only defaults FALSE everywhere (no
--     change to existing visibility).
--   • can_sync_lsq_owner defaults TRUE only for owner / superadmin
--     (matches how other "sync to upstream" capabilities default).
-- Operators can later flip these per-role or per-member from
-- Settings → Permissions like every other capability.

alter table role_permissions
  add column if not exists lsq_assigned_visibility_only boolean not null default false,
  add column if not exists can_sync_lsq_owner          boolean not null default false;

alter table team_member_permissions
  add column if not exists lsq_assigned_visibility_only boolean,
  add column if not exists can_sync_lsq_owner          boolean;

-- Owner + superadmin: full sync, no visibility restriction.
update role_permissions
  set can_sync_lsq_owner = true
  where role in ('owner','superadmin');

-- contacts.lsq_owner_email caches the LSQ lead owner's email so the
-- inbox visibility query (per-row filter) doesn't have to hit LSQ on
-- every page load. Refreshed by the existing LSQ ensure-lead /
-- update flows + the new sync helper.
alter table contacts
  add column if not exists lsq_owner_email text;

create index if not exists contacts_lsq_owner_email_idx
  on contacts (lsq_owner_email)
  where lsq_owner_email is not null;
