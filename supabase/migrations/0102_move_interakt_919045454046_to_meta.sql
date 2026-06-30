-- 0102_move_interakt_919045454046_to_meta.sql
--
-- ONE-OFF data merge (run once in the Supabase SQL editor — NOT a schema
-- change). The number +91 90454 54046 exists twice:
--   SOURCE (retire) : business_phone_number_id = 'interakt:919045454046'  (75 chats / 179 msgs, old Interakt connection)
--   TARGET (keep)   : business_phone_number_id = '1131773160025041'        (real Meta number, WABA 1430966558794990)
--
-- This moves every chat + message from the Interakt number onto the Meta
-- number so nothing is lost. AFTER running this (and verifying the counts
-- below), remove the now-empty Interakt number from the UI
-- (Numbers → that card → "Danger zone — remove this number").
--
-- Safe to re-run: every statement is guarded by the source id, so a second
-- run finds nothing and no-ops.

BEGIN;

-- 1. Conflicts — a wa_id that already exists on the Meta number too (e.g. the
--    Meta number's test chat is the same customer). Move that Meta-side
--    contact's messages onto the Interakt-side contact (lossless), then drop
--    the now-empty Meta-side duplicate so the flip in step 2 doesn't trip the
--    unique (wa_id, business_phone_number_id) constraint. (A freshly-connected
--    Meta number's test contact has only messages — no notes/payments — so the
--    delete loses nothing but the duplicate row itself.)
UPDATE public.messages m
   SET contact_id = src.id
  FROM public.contacts src
  JOIN public.contacts tgt
    ON tgt.wa_id = src.wa_id
 WHERE src.business_phone_number_id = 'interakt:919045454046'
   AND tgt.business_phone_number_id = '1131773160025041'
   AND m.contact_id = tgt.id;

DELETE FROM public.contacts tgt
 WHERE tgt.business_phone_number_id = '1131773160025041'
   AND tgt.wa_id IN (
     SELECT wa_id
       FROM public.contacts
      WHERE business_phone_number_id = 'interakt:919045454046'
   );

-- 2. Flip every remaining Interakt contact + message onto the Meta number.
UPDATE public.contacts
   SET business_phone_number_id = '1131773160025041'
 WHERE business_phone_number_id = 'interakt:919045454046';

UPDATE public.messages
   SET business_phone_number_id = '1131773160025041'
 WHERE business_phone_number_id = 'interakt:919045454046';

COMMIT;

-- 3. Verify — SOURCE should now be 0, TARGET should hold the merged total.
SELECT business_phone_number_id,
       count(*) AS chats
  FROM public.contacts
 WHERE business_phone_number_id IN ('interakt:919045454046', '1131773160025041')
 GROUP BY business_phone_number_id;
