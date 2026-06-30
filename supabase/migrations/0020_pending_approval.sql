-- =====================================================================
-- 0020 — Owner approval flow for new signups
-- ---------------------------------------------------------------------
-- Until now any auth.users insert (Google sign-in OR email signup) ran
-- the handle_new_auth_user trigger, which auto-created an active
-- team_members row. That meant strangers could create their own
-- accounts and walk into the workspace.
--
-- New flow:
--   1. New auth user → row created with is_active=FALSE, pending_approval=TRUE
--      (UNLESS they match a pre-invite — those still go through, since
--      the owner already vouched for them by email when they invited.)
--   2. Login is blocked for pending rows (UI shows "awaiting approval").
--   3. Owner / superadmin sees the pending row at the top of Settings →
--      Team and clicks Approve (sets is_active=true, pending_approval=
--      false) or Reject (deletes the row + the auth user can sign up
--      again later if invited).
-- =====================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false;

-- Re-create the trigger function with the new branch.
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

  -- Pre-invited path: owner / admin already invited this email via the
  -- Team UI. Link the auth user to that row and keep it active — the
  -- approval was implicit at invite time.
  SELECT id INTO v_existing_id
    FROM public.team_members
   WHERE lower(email) = v_email
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.team_members
       SET user_id          = NEW.id,
           full_name        = COALESCE(NULLIF(full_name, ''), v_full_name),
           is_active        = true,
           pending_approval = false
     WHERE id = v_existing_id;
  ELSE
    -- Fresh signup. Owner email is auto-approved (bootstrapping the
    -- workspace would be impossible otherwise). Everyone else lands in
    -- the "pending approval" queue.
    INSERT INTO public.team_members (
      user_id, email, full_name, role, is_active, pending_approval
    )
    VALUES (
      NEW.id,
      v_email,
      v_full_name,
      CASE WHEN v_email = v_owner_email THEN 'owner' ELSE 'teammate' END,
      CASE WHEN v_email = v_owner_email THEN true   ELSE false END,
      CASE WHEN v_email = v_owner_email THEN false  ELSE true  END
    );
  END IF;

  RETURN NEW;
END;
$$;
