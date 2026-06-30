-- Permission flag for the "Date Align" composer action (booking links + setting
-- a patient's date). Default ON for owner/superadmin/admin, OFF for teammate —
-- admins grant it to specific teammates via the per-member override.

alter table public.role_permissions
  add column if not exists can_align_dates boolean not null default true;
update public.role_permissions set can_align_dates = false where role = 'teammate';

-- Team + member overrides: nullable = inherit.
alter table public.team_permissions
  add column if not exists can_align_dates boolean;
alter table public.team_member_permissions
  add column if not exists can_align_dates boolean;
