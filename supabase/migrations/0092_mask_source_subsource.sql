-- 0092_mask_source_subsource.sql
-- New permission: hide the lead's Source / Sub-source pills in Contact details.
-- Mirrors mask_phone_numbers / mask_emails. Default ON for teammates.

alter table public.role_permissions
  add column if not exists mask_source_subsource boolean not null default false;

-- Teammates get it ON by default (admins/superadmins/owner see everything).
update public.role_permissions
  set mask_source_subsource = true
  where role = 'teammate';

-- Per-member + per-team overrides: nullable = inherit the role default.
alter table public.team_member_permissions
  add column if not exists mask_source_subsource boolean;

alter table public.team_permissions
  add column if not exists mask_source_subsource boolean;
