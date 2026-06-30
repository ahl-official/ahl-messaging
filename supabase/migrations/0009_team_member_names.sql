-- ============================================================================
-- 0009_team_member_names.sql — split agent display name into first + last
-- ----------------------------------------------------------------------------
-- The Magic Message card renders "Replied By {Name}" using the agent who
-- actually sent the message. We need a stable, agent-specific name that the
-- dashboard owns, so the message bubble doesn't accidentally credit the
-- patient (which used to happen because the n8n workflow that prototyped
-- this server populated `agentName` from `Push Name` — a WhatsApp
-- customer-side concept).
--
-- Adds first_name + last_name columns. Both are NULLABLE for now so existing
-- rows aren't broken; the dashboard will gate Magic Message sending on a
-- "complete your profile" check until the agent fills both in.
--
-- Backfill rule: if `full_name` already has a value, split on the first
-- whitespace into first + rest (single-word names land entirely in first_name).
-- ============================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text;

UPDATE public.team_members
SET
  first_name = COALESCE(
    first_name,
    NULLIF(split_part(trim(full_name), ' ', 1), '')
  ),
  last_name = COALESCE(
    last_name,
    NULLIF(
      btrim(substring(trim(full_name) FROM position(' ' in trim(full_name)) + 1)),
      ''
    )
  )
WHERE full_name IS NOT NULL AND trim(full_name) <> '';

CREATE INDEX IF NOT EXISTS team_members_first_last_idx
  ON public.team_members (first_name, last_name);
