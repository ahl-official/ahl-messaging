-- Scope payment_accounts per clinic (American Hairline, Alchemane, …).
--
-- Up to this migration every account was workspace-global — exactly
-- one row could be `is_active = true` across the whole table. Now that
-- the composer's clinic chooser supports American Hairline + Alchemane, each clinic
-- needs its own active Razorpay / PayU binding.
--
--   clinic       — 'americanhairline' | 'alchemane'. NOT NULL, defaults to 'americanhairline' so
--                  every existing row backfills cleanly.
--   active scope — replaces the workspace-global partial unique index
--                  with one scoped to (clinic) so each clinic can have
--                  its own active winner independently.

alter table public.payment_accounts
  add column if not exists clinic text;

update public.payment_accounts
  set clinic = 'americanhairline'
  where clinic is null;

alter table public.payment_accounts
  alter column clinic set not null,
  alter column clinic set default 'americanhairline';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_accounts_clinic_check'
  ) then
    alter table public.payment_accounts
      add constraint payment_accounts_clinic_check
        check (clinic in ('americanhairline', 'alchemane'));
  end if;
end$$;

create index if not exists payment_accounts_clinic_idx
  on public.payment_accounts(clinic);

-- Replace the workspace-global one-active index with a per-clinic one.
drop index if exists payment_accounts_one_active;

create unique index if not exists payment_accounts_one_active_per_clinic
  on public.payment_accounts(clinic)
  where is_active = true;
