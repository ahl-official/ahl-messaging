-- Missing columns that were added manually to QHT production DB
-- and never included in the migration files.
-- Must be run before migrations_part4.sql

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_stage TEXT,
  ADD COLUMN IF NOT EXISTS lsq_owner_name TEXT,
  ADD COLUMN IF NOT EXISTS lsq_prospect_id TEXT,
  ADD COLUMN IF NOT EXISTS lsq_lead_number TEXT,
  ADD COLUMN IF NOT EXISTS lsq_owner_email TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_bpid_lsq_stage
  ON public.contacts (business_phone_number_id, lsq_stage);

CREATE INDEX IF NOT EXISTS contacts_lsq_owner_email_idx
  ON public.contacts (lsq_owner_email)
  WHERE lsq_owner_email IS NOT NULL;
