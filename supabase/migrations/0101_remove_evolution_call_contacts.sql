-- 0101_remove_evolution_call_contacts.sql
--
-- Evolution call events are now DISABLED in the webhook (they created a
-- contact for every @lid / WhatsApp-privacy caller — non-real "numbers" that
-- cluttered the inbox). This one-off cleanup removes the rows those call
-- events already created:
--
--   1. Contacts that exist ONLY because of a call log (no real message) —
--      these are the weird call-only numbers. FK cascade drops their
--      messages / whatsapp_calls / payments automatically.
--   2. The leftover "📞 voice/video call" log rows on contacts that DID have
--      a real conversation (keep the contact, drop the noisy call rows).
--
-- Re-running is harmless (idempotent).

BEGIN;

-- 1. Drop contacts whose every message is an Evolution call log.
DELETE FROM public.contacts c
WHERE EXISTS (
  SELECT 1 FROM public.messages m
  WHERE m.contact_id = c.id
    AND m.wa_message_id LIKE 'evo-call-%'
)
AND NOT EXISTS (
  SELECT 1 FROM public.messages m
  WHERE m.contact_id = c.id
    AND (m.wa_message_id IS NULL OR m.wa_message_id NOT LIKE 'evo-call-%')
);

-- 2. Remove the remaining call-log rows (on contacts kept above).
DELETE FROM public.messages WHERE wa_message_id LIKE 'evo-call-%';

COMMIT;
