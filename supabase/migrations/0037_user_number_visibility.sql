-- Per-user "hide this number" preference. The UserMenu toggle used to
-- flip business_numbers.is_active, which is global — flipping it for one
-- operator hid the number from everyone. This column moves that toggle
-- to the team_members row so each operator controls their own inbox
-- visibility without affecting teammates.
--
-- Stored as a text[] of phone_number_ids the user has chosen to hide.
-- Empty array (default) = show everything they have access to.

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS hidden_number_ids text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS team_members_hidden_number_ids_idx
  ON public.team_members USING gin (hidden_number_ids);
