-- =====================================================================
-- 0100 — Booking value on contacts (campaign "Booked" conversions)
-- ---------------------------------------------------------------------
-- The conversions card also shows WHO booked — any recipient with a
-- Booking Amount (mx_Booking_Amount) / Booking Date, regardless of stage.
-- Stored locally so the card reads all recipients cheaply + auto-syncs.
-- =====================================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lsq_booking_amount numeric,
  ADD COLUMN IF NOT EXISTS lsq_booking_date   text;
