-- =====================================================================
-- 0015 — Per-role + per-member permission overrides
-- ---------------------------------------------------------------------
-- Two tables drive the "fully customizable" access model:
--   role_permissions          → defaults per role (4 rows, editable)
--   team_member_permissions   → sparse overrides per member (NULL = inherit)
-- Effective perms = override IS NOT NULL ? override : role default.
-- Owner role is kept fully open by default; UI also short-circuits owners
-- to "all access" so they can never lock themselves out.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) role_permissions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role                  text PRIMARY KEY
                          CHECK (role IN ('owner','superadmin','admin','teammate')),
  -- access scopes (NULL = unrestricted / all)
  allowed_number_ids    text[],
  allowed_panels        text[],
  -- privacy masks
  mask_phone_numbers    boolean NOT NULL DEFAULT false,
  mask_emails           boolean NOT NULL DEFAULT false,
  -- capabilities
  can_send_messages     boolean NOT NULL DEFAULT true,
  can_use_magic_message boolean NOT NULL DEFAULT true,
  can_export_data       boolean NOT NULL DEFAULT false,
  can_assign_contacts   boolean NOT NULL DEFAULT true,
  can_manage_templates  boolean NOT NULL DEFAULT false,
  can_manage_automation boolean NOT NULL DEFAULT false,
  can_make_calls        boolean NOT NULL DEFAULT true,
  can_view_call_history boolean NOT NULL DEFAULT true,
  can_manage_team       boolean NOT NULL DEFAULT false,
  can_manage_numbers    boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Seed defaults — sensible starting point per role.
INSERT INTO public.role_permissions
  (role,         mask_phone_numbers, mask_emails, can_send_messages, can_use_magic_message,
   can_export_data, can_assign_contacts, can_manage_templates, can_manage_automation,
   can_make_calls, can_view_call_history, can_manage_team, can_manage_numbers)
VALUES
  ('owner',      false, false, true, true,  true,  true,  true,  true,  true, true, true,  true),
  ('superadmin', false, false, true, true,  true,  true,  true,  true,  true, true, true,  true),
  ('admin',      false, false, true, true,  false, true,  true,  true,  true, true, true,  false),
  ('teammate',   true,  true,  true, true,  false, false, false, false, true, true, false, false)
ON CONFLICT (role) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2) team_member_permissions — sparse override per member
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_member_permissions (
  member_id             uuid PRIMARY KEY
                          REFERENCES public.team_members(id) ON DELETE CASCADE,
  allowed_number_ids    text[],
  allowed_panels        text[],
  mask_phone_numbers    boolean,
  mask_emails           boolean,
  can_send_messages     boolean,
  can_use_magic_message boolean,
  can_export_data       boolean,
  can_assign_contacts   boolean,
  can_manage_templates  boolean,
  can_manage_automation boolean,
  can_make_calls        boolean,
  can_view_call_history boolean,
  can_manage_team       boolean,
  can_manage_numbers    boolean,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 3) updated_at triggers (reuse public.set_updated_at from 0005)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS role_permissions_set_updated_at ON public.role_permissions;
CREATE TRIGGER role_permissions_set_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS team_member_permissions_set_updated_at ON public.team_member_permissions;
CREATE TRIGGER team_member_permissions_set_updated_at
  BEFORE UPDATE ON public.team_member_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4) RLS — active members can read; writes go through service role only
-- ---------------------------------------------------------------------
ALTER TABLE public.role_permissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_select ON public.role_permissions;
CREATE POLICY role_permissions_select ON public.role_permissions
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());

DROP POLICY IF EXISTS team_member_permissions_select ON public.team_member_permissions;
CREATE POLICY team_member_permissions_select ON public.team_member_permissions
  FOR SELECT TO authenticated
  USING (public.current_member_is_active());
