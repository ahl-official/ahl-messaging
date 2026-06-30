-- ============================================================================
-- 0007_template_metadata.sql — richer template message rendering
-- ----------------------------------------------------------------------------
-- Adds columns so the dashboard can render a faithful card view of an
-- outgoing template message:
--   - template_footer:  the small print line ("Type STOP to Unsubscribe")
--   - template_buttons: the buttons array (Reply Now / URL / Phone / etc.)
--   - sent_by_user_id:  which agent sent this message (FK to auth.users)
--   - sent_by_email:    cached email for hover tooltip / display
-- All four are nullable + additive — existing rows are unaffected.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS template_footer  text,
  ADD COLUMN IF NOT EXISTS template_buttons jsonb,
  ADD COLUMN IF NOT EXISTS sent_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_by_email    text;

CREATE INDEX IF NOT EXISTS messages_sent_by_user_id_idx
  ON public.messages (sent_by_user_id);
