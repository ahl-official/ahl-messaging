-- Payment links + receipts.
--
-- Operators generate a Razorpay payment link from inside a chat. The
-- link is sent to the patient over WhatsApp; when they pay, Razorpay's
-- webhook hits us and we flip the row to 'paid'. Receipts can be auto-
-- sent on payment OR sent manually later from the contact details
-- panel.

create table if not exists public.payments (
  id                          uuid primary key default gen_random_uuid(),
  contact_id                  uuid not null
                              references public.contacts(id) on delete cascade,
  business_phone_number_id    text references public.business_numbers(phone_number_id)
                              on delete set null,
  -- Amount stored in MINOR units (paise for INR) to match Razorpay's
  -- API exactly and avoid float rounding when comparing.
  amount_minor                bigint not null check (amount_minor > 0),
  currency                    text not null default 'INR',
  description                 text,
  -- Razorpay's identifiers + short URL we share with the patient.
  razorpay_payment_link_id    text unique,
  short_url                   text,
  -- Lifecycle: created → sent → paid | cancelled | expired | failed
  -- 'sent' = link forwarded to the patient via WhatsApp.
  status                      text not null default 'created'
                              check (status in
                                ('created','sent','paid','cancelled',
                                 'expired','failed')),
  paid_at                     timestamptz,
  -- Razorpay-generated receipt URL (PDF). Filled by the webhook on
  -- payment_link.paid. Manual "send receipt" uses this same URL.
  receipt_url                 text,
  -- Track whether the auto-receipt WhatsApp send has fired yet so we
  -- don't double-send if the webhook retries.
  receipt_sent_at             timestamptz,
  -- Audit columns.
  created_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists payments_contact_id_idx
  on public.payments(contact_id, created_at desc);
create index if not exists payments_status_idx
  on public.payments(status);
create index if not exists payments_bpid_idx
  on public.payments(business_phone_number_id, created_at desc);

-- RLS — workspace-internal, same model as the rest of the schema.
-- Service role bypasses RLS for webhook + server-side writes; user-
-- scoped clients read via the existing dashboard auth.
alter table public.payments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments' and policyname = 'payments_all_authenticated'
  ) then
    create policy payments_all_authenticated
      on public.payments
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end$$;
