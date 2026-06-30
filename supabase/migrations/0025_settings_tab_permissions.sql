-- Fine-grained per-tab access for /settings/* (Team, Permissions,
-- Numbers, Capabilities, Notice, Portfolios, API, Data).
--
-- Storage convention matches the existing `allowed_panels` /
-- `allowed_number_ids` columns:
--   NULL       → unrestricted (all settings tabs visible)
--   '{}'::text[] → explicitly NO tabs (the role/member has zero access
--                  to the Settings area)
--   '{team,permissions,…}' → only the listed tabs are visible
--
-- Owner always gets unrestricted access regardless of this column
-- (enforced in lib/permission-types.ts → ownerPermissions()).

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS allowed_settings_tabs text[] DEFAULT NULL;

ALTER TABLE public.team_member_permissions
  ADD COLUMN IF NOT EXISTS allowed_settings_tabs text[] DEFAULT NULL;
