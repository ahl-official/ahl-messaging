-- Team-group permission overrides.
--
-- Each row mirrors the shape of `team_member_permissions` but is
-- keyed by team_id, so an admin can say "everyone in the Sales team
-- gets these capabilities" without touching individual members. All
-- fields are nullable; NULL means "inherit role default", same
-- semantics as the per-member override table.
--
-- Resolution order (enforced in lib/permissions.ts):
--   1. Role default
--   2. Team override   (member.team_id  → team_permissions[team_id])
--   3. Member override (team_member_permissions row for the member)
--
-- A NULL field in a layer means "pass through" to the previous layer.

create table if not exists team_permissions (
  team_id                       uuid primary key references teams(id) on delete cascade,
  allowed_number_ids            text[],
  allowed_panels                text[],
  allowed_settings_tabs         text[],
  mask_phone_numbers            boolean,
  mask_emails                   boolean,
  can_send_messages             boolean,
  can_use_magic_message         boolean,
  can_export_data               boolean,
  can_assign_contacts           boolean,
  can_manage_templates          boolean,
  can_manage_automation         boolean,
  can_make_calls                boolean,
  can_view_call_history         boolean,
  can_manage_team               boolean,
  can_manage_numbers            boolean,
  can_delete_labels             boolean,
  lsq_assigned_visibility_only  boolean,
  can_sync_lsq_owner            boolean,
  updated_at                    timestamptz not null default now()
);

alter table team_permissions enable row level security;
-- Service role only. The team-permissions API uses the service-role
-- client (same as the member override path).
