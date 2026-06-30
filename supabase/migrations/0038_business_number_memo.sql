-- Free-form "memo" / operator note per business number. Kept separate
-- from `nickname` (which is the display label across the dashboard).
-- Memo is purely a memory aid — "what is this number for" — and shows
-- up as a subtitle on the Numbers settings card + the user-menu list.

ALTER TABLE public.business_numbers
  ADD COLUMN IF NOT EXISTS memo text;
