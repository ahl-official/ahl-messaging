-- Per-number WABA id.
--
-- One Meta business portfolio can own MULTIPLE WhatsApp Business
-- Accounts (WABAs), and templates live at the WABA level — so two
-- numbers under the same portfolio can have completely different
-- template libraries.
--
-- The portfolio config in .env.local only carries ONE
-- business_account_id, which is wrong for any number whose WABA
-- differs. Storing waba_id on the number lets the templates API fetch
-- the correct library: it uses business_numbers.waba_id for the WABA
-- and the owning portfolio's access_token for auth.
--
-- NULL = fall back to the portfolio's business_account_id (single-WABA
-- portfolios keep working with no change).

alter table public.business_numbers
  add column if not exists waba_id text;
