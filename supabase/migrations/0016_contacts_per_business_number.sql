-- =====================================================================
-- 0016 — One contact row per (wa_id, business_phone_number_id)
-- ---------------------------------------------------------------------
-- Until now, `contacts.wa_id` was UNIQUE. That meant if the same patient
-- messaged two of our business numbers (e.g. URoots + QHT Clinic), they
-- collapsed into one row and the inbox showed a single chat card with
-- merged history — confusing for agents who need to see which number
-- each conversation is on.
--
-- This migration moves uniqueness onto (wa_id, business_phone_number_id)
-- so each business number gets its own card per patient.
-- =====================================================================

-- 1) Backfill any rows where business_phone_number_id is NULL (shouldn't
--    happen post-0002, but defensive — a NULL would let the new unique
--    constraint allow duplicates since NULL != NULL in PG).
UPDATE public.contacts
   SET business_phone_number_id = (
     SELECT phone_number_id FROM public.business_numbers
      ORDER BY created_at ASC
      LIMIT 1
   )
 WHERE business_phone_number_id IS NULL
   AND EXISTS (SELECT 1 FROM public.business_numbers);

-- 2) Drop the old single-column unique. Constraint name varies by Postgres
--    version + how the table was created — find it dynamically.
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.contacts'::regclass
     AND contype  = 'u'
     AND pg_get_constraintdef(oid) ILIKE '%(wa_id)%'
   LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.contacts DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

-- Drop the implicit unique index too if it exists separately.
DROP INDEX IF EXISTS public.contacts_wa_id_key;

-- 3) Add the composite unique constraint. We use a UNIQUE INDEX rather
--    than a constraint so it survives the rare case where the column
--    is NULL (matches existing tooling that uses ON CONFLICT against
--    indexes).
CREATE UNIQUE INDEX IF NOT EXISTS contacts_wa_id_business_number_idx
  ON public.contacts (wa_id, business_phone_number_id);

-- 4) Keep wa_id indexed standalone for fast lookups + LSQ-by-mobile joins.
CREATE INDEX IF NOT EXISTS contacts_wa_id_idx ON public.contacts (wa_id);
