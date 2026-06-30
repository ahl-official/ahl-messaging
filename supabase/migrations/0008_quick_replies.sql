-- ============================================================================
-- 0008_quick_replies.sql — saved snippets agents insert via /shortcut
-- ----------------------------------------------------------------------------
-- Quick replies are short text snippets the team can insert into the chat
-- composer by typing a /shortcut (e.g. typing "/hours" inserts the clinic's
-- working-hours blurb). Created and managed from the Templates page; shared
-- across all team members.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quick_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The /shortcut name (without the leading slash). Lowercase, alphanumeric,
  -- underscores/hyphens. Unique per workspace so two agents don't define the
  -- same shortcut to mean two different things.
  shortcut    text NOT NULL,
  body        text NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_email text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_shortcut_format CHECK (shortcut ~ '^[a-z0-9_-]{1,40}$'),
  CONSTRAINT quick_replies_body_len CHECK (char_length(body) BETWEEN 1 AND 4096)
);

CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_shortcut_uidx
  ON public.quick_replies (shortcut);

-- Keep updated_at fresh on edits.
CREATE OR REPLACE FUNCTION public.quick_replies_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quick_replies_touch_updated_at ON public.quick_replies;
CREATE TRIGGER quick_replies_touch_updated_at
  BEFORE UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.quick_replies_touch_updated_at();
