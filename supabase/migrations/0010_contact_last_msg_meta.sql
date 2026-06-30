-- ============================================================================
-- 0010_contact_last_msg_meta.sql — denormalize last-message direction + status
-- ----------------------------------------------------------------------------
-- The contact list panel shows per-row hints that need the latest message's
-- direction and delivery status:
--   - Outbound + read   → render emerald ✓✓ next to the preview
--   - Outbound + sent/delivered → render gray ✓ / ✓✓
--   - Inbound (unread)  → render an inline "Reply" CTA chip
--
-- Computing these from the messages table on every poll would mean N
-- subqueries per contact, so we denormalize onto the contact row instead.
-- The webhook + send-message + magic-message routes write these whenever
-- they touch `last_message_preview`. Backfill below seeds existing rows.
-- ============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_message_direction text
    CHECK (last_message_direction IN ('inbound', 'outbound')),
  ADD COLUMN IF NOT EXISTS last_message_status    text
    CHECK (last_message_status IN ('sent', 'delivered', 'read', 'failed', 'received'));

-- Backfill: pull the most-recent message per contact and copy its metadata
-- onto the contact row. DISTINCT ON gives us the latest per contact in one
-- pass without a window function.
WITH latest AS (
  SELECT DISTINCT ON (contact_id)
    contact_id,
    direction,
    status,
    type
  FROM public.messages
  ORDER BY contact_id, timestamp DESC
)
UPDATE public.contacts c
SET
  last_message_direction = latest.direction,
  last_message_status =
    CASE
      WHEN latest.direction = 'inbound' THEN 'received'
      ELSE latest.status
    END
FROM latest
WHERE c.id = latest.contact_id;

CREATE INDEX IF NOT EXISTS contacts_last_msg_dir_idx
  ON public.contacts (last_message_direction);
