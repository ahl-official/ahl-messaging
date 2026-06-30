-- Granular permission for deleting workspace contact labels.
--
-- Background: anyone can CREATE / RENAME / recolor a label (the
-- operator wanted teammates to manage labels inline without sending
-- them into Settings). DELETE is the one destructive action that
-- needed a gate — pulls the label off every contact it was assigned
-- to, irreversible.
--
-- Defaults: owner / superadmin / admin = true, teammate = false. The
-- per-member override column lets the owner exempt a specific
-- teammate (or revoke an admin's right) without changing role rules.

alter table public.role_permissions
  add column if not exists can_delete_labels boolean not null default false;

-- Seed sensible role defaults for any existing rows.
update public.role_permissions
   set can_delete_labels = true
 where role in ('owner', 'superadmin', 'admin')
   and can_delete_labels = false;

alter table public.team_member_permissions
  add column if not exists can_delete_labels boolean;
