-- =====================================================================
-- 0057 — contacts.imported flag
-- ---------------------------------------------------------------------
-- Chats brought in through the chat-import tool are historical: they're
-- a one-time dump of a WhatsApp export, not a live conversation. The
-- inbox should mark these so agents instantly know "this is a past
-- chat, not an active thread".
--
-- Going forward the import batch route sets `imported = true` on the
-- contacts it upserts. The backfill below catches everything already
-- imported: a contact counts as imported when it HAS messages and
-- every one of them carries a synthesised `import:<sha>` wa_message_id
-- (the id the batch route generates when the export had no real wamid).
-- A contact with even one live message is left alone.
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;

UPDATE public.contacts c
   SET imported = true
 WHERE EXISTS (
         SELECT 1 FROM public.messages m WHERE m.contact_id = c.id
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.contact_id = c.id
            AND COALESCE(m.wa_message_id, '') NOT LIKE 'import:%'
       );

-- Partial index — the inbox only ever asks "is this one imported?".
CREATE INDEX IF NOT EXISTS contacts_imported_idx
  ON public.contacts (imported) WHERE imported;
