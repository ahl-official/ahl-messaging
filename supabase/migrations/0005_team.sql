-- ============================================================================
-- 0005_team.sql — team_members + role-based access foundation
-- ----------------------------------------------------------------------------
-- ⚠️  BEFORE RUNNING: replace 'info@americanhairline.com' on line 60 with the email
--     that should auto-promote to 'owner' when they first sign in via Google.
-- ----------------------------------------------------------------------------
-- What this migration does:
--   1. Creates `team_members` (one row per QHT staffer) with a role.
--   2. Adds a trigger that fires when a new auth.users row is inserted (i.e.
--      first Google sign-in) — it links a pre-invited row by email if one
--      exists, otherwise creates a new row with role 'teammate'. The
--      designated OWNER_EMAIL is auto-promoted to 'owner'.
--   3. Backfills any existing auth.users so they appear in team_members.
--   4. Enables RLS on team_members + adds a non-recursive read policy via a
--      SECURITY DEFINER helper function. Writes go through server actions
--      using the service role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text        NOT NULL,
  full_name       text,
  role            text        NOT NULL DEFAULT 'teammate'
                                CHECK (role IN ('owner', 'superadmin', 'admin', 'teammate')),
  is_active       boolean     NOT NULL DEFAULT true,
  invited_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  last_active_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_members_user_id_unique UNIQUE (user_id)
);

-- Case-insensitive uniqueness on email.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_email_lower_idx
  ON public.team_members (lower(email));

CREATE INDEX IF NOT EXISTS team_members_role_idx     ON public.team_members (role);
CREATE INDEX IF NOT EXISTS team_members_active_idx   ON public.team_members (is_active);

-- ---------------------------------------------------------------------------
-- 2. updated_at auto-touch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_members_set_updated_at ON public.team_members;
CREATE TRIGGER team_members_set_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. New-user trigger — auto-link or auto-create on first sign-in
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- ⚠️ Replace with the email that should be auto-promoted to 'owner'.
  v_owner_email text := lower('info@americanhairline.com');
  v_email       text := lower(NEW.email);
  v_full_name   text := COALESCE(NEW.raw_user_meta_data->>'full_name',
                                 NEW.raw_user_meta_data->>'name');
  v_existing_id uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NEW;
  END IF;

  -- If admin pre-invited this email, link the auth user to that row.
  SELECT id INTO v_existing_id
    FROM public.team_members
   WHERE lower(email) = v_email
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.team_members
       SET user_id   = NEW.id,
           full_name = COALESCE(NULLIF(full_name, ''), v_full_name),
           is_active = true
     WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.team_members (user_id, email, full_name, role)
    VALUES (
      NEW.id,
      v_email,
      v_full_name,
      CASE WHEN v_email = v_owner_email THEN 'owner' ELSE 'teammate' END
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 4. Backfill any existing auth.users (so the trigger doesn't miss them)
-- ---------------------------------------------------------------------------
INSERT INTO public.team_members (user_id, email, full_name, role)
SELECT
  u.id,
  lower(u.email),
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  CASE WHEN lower(u.email) = lower('info@americanhairline.com')  -- ⚠️ same email as above
       THEN 'owner' ELSE 'teammate' END
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.team_members WHERE user_id = u.id
  );

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Helper: is the calling user an active team member?  Used by RLS policies
-- across this and other tables.  SECURITY DEFINER avoids RLS recursion.
CREATE OR REPLACE FUNCTION public.current_member_is_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
     WHERE user_id = auth.uid() AND is_active = true
  );
$$;

-- Helper: returns the calling user's role, or NULL if not a member.
CREATE OR REPLACE FUNCTION public.current_member_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.team_members
   WHERE user_id = auth.uid() AND is_active = true
   LIMIT 1;
$$;

-- Active members can read the whole roster (UI shows colleagues).
DROP POLICY IF EXISTS team_members_select_active ON public.team_members;
CREATE POLICY team_members_select_active ON public.team_members
  FOR SELECT
  TO authenticated
  USING (public.current_member_is_active());

-- All writes go through server actions using the service role
-- (which bypasses RLS), so we deliberately add no INSERT/UPDATE/DELETE
-- policies here.

-- ---------------------------------------------------------------------------
-- 6. Sanity check (read-only, optional — uncomment to verify after running)
-- ---------------------------------------------------------------------------
-- SELECT id, email, role, is_active, user_id IS NOT NULL AS linked, created_at
--   FROM public.team_members
--  ORDER BY created_at DESC;
