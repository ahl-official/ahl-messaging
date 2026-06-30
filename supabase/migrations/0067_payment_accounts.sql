-- Multi-account payment gateway storage.
--
-- Up to this migration the workspace had exactly ONE Razorpay + ONE
-- PayU account, both read straight out of .env.local. Operators with
-- multiple sub-brands or test/live keys want to store several accounts,
-- label them, and flip the active one from the UI.
--
-- Schema:
--   provider     — 'razorpay' | 'payu'
--   label        — operator-supplied display name (e.g. "QHT Main",
--                  "Hairmed Live"). Required so the dashboard can
--                  show "which account am I about to send from".
--   credentials  — JSONB of the provider-specific keys. Razorpay:
--                  { key_id, key_secret, webhook_secret }. PayU:
--                  { merchant_key, merchant_salt, env? }.
--   is_active    — exactly one row across the whole table may be true.
--                  A partial unique index enforces that — flipping
--                  a different row to active requires the caller to
--                  unset the previous winner inside the same txn.
--
-- Secrets are stored unencrypted; access is service-role only.
-- Owner/superadmin-only routes are the only callers. Add column-level
-- encryption later if we go multi-tenant.

create table if not exists public.payment_accounts (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('razorpay', 'payu')),
  label        text not null,
  credentials  jsonb not null default '{}'::jsonb,
  is_active    boolean not null default false,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists payment_accounts_provider_idx
  on public.payment_accounts(provider);

-- Only one active account workspace-wide. Partial unique = lets us
-- have many is_active=false rows alongside the single active winner.
create unique index if not exists payment_accounts_one_active
  on public.payment_accounts((true))
  where is_active = true;

alter table public.payment_accounts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payment_accounts'
      and policyname = 'payment_accounts_authenticated_select'
  ) then
    create policy payment_accounts_authenticated_select
      on public.payment_accounts
      for select
      to authenticated
      using (true);
  end if;
end$$;
