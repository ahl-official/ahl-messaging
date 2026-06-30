-- Make the payments table provider-agnostic. The original 0065 design
-- assumed Razorpay; we now also support PayU. Each row records which
-- gateway minted it so the webhook + manual receipt path can dispatch
-- correctly.
--
--   provider              — 'razorpay' | 'payu'. Required going
--                            forward; backfilled to 'razorpay' for
--                            rows created before the rename.
--   provider_link_id      — generic name for the gateway link id.
--                            Already populated for Razorpay via
--                            razorpay_payment_link_id; we keep that
--                            old column for backward compat and copy
--                            its value into the new one.
--   provider_txnid        — for PayU we generate our own txnid and
--                            send it along; PayU returns mihpayid on
--                            payment which we'll stash in
--                            razorpay_payment_link_id too (since the
--                            semantics align: gateway's internal id).
--
-- Existing rows: their provider stays 'razorpay' and provider_link_id
-- copies from razorpay_payment_link_id, so the dashboard + webhook
-- handlers can immediately switch to the new columns without losing
-- history.

alter table public.payments
  add column if not exists provider text;

update public.payments
  set provider = 'razorpay'
  where provider is null;

alter table public.payments
  alter column provider set not null,
  alter column provider set default 'razorpay';

-- Replace the CHECK on Razorpay-only with a generic enum.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_provider_check'
  ) then
    alter table public.payments
      add constraint payments_provider_check
        check (provider in ('razorpay', 'payu'));
  end if;
end$$;

alter table public.payments
  add column if not exists provider_link_id text,
  add column if not exists provider_txnid   text;

-- Backfill provider_link_id from razorpay_payment_link_id for old rows.
update public.payments
  set provider_link_id = razorpay_payment_link_id
  where provider_link_id is null
    and razorpay_payment_link_id is not null;

create index if not exists payments_provider_link_id_idx
  on public.payments(provider, provider_link_id);
create index if not exists payments_provider_txnid_idx
  on public.payments(provider, provider_txnid);
