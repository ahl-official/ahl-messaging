-- GST tax invoices (Tally-synced).
--
-- Operators raise a GST tax invoice from a contact/booking. The flow:
--   draft  -> we compute the GST breakup (inclusive total -> taxable +
--             CGST/SGST or IGST) and freeze a party snapshot.
--   syncing-> the voucher is pushed to Tally (cloud gateway over HTTPS).
--   synced -> Tally assigns + returns the official invoice number; we
--             stamp it, render the branded PDF and send it to the
--             patient on WhatsApp (same document rail as receipts).
--   failed -> Tally import errored; tally_error holds the reason, the
--             operator can retry.
--
-- Tally connection details + ledger names live in app_settings (see
-- lib/tally) so they can be reconfigured without a migration. The
-- supplier (QHT Mediways, Haridwar — single GSTIN) is constant in the
-- PDF builder.

create table if not exists public.tax_invoices (
  id                          uuid primary key default gen_random_uuid(),
  contact_id                  uuid references public.contacts(id) on delete set null,
  business_phone_number_id    text references public.business_numbers(phone_number_id)
                              on delete set null,
  -- Optional linkage if the invoice was raised off a payment/booking.
  payment_id                  uuid references public.payments(id) on delete set null,

  -- Official Tally voucher number. NULL until the voucher is imported
  -- and Tally assigns + returns it (number-first flow).
  invoice_number              text,
  -- IST calendar date the invoice is dated for.
  invoice_date                date not null
                              default (now() at time zone 'Asia/Kolkata')::date,

  -- Party (patient) snapshot — frozen on the invoice so later edits to
  -- the contact never mutate an issued tax document.
  party_name                  text not null,
  party_address               text,
  party_state                 text not null default 'Uttarakhand',
  party_state_code            text not null default '05',
  party_gstin                 text,
  place_of_supply             text not null default 'Uttarakhand',
  place_of_supply_code        text not null default '05',

  -- Single-line booking invoice mirroring sample #528.
  description                 text not null default 'BOOKING FOR HAIR TRANSPLANT',
  hsn_sac                     text not null default '999722',
  gst_rate                    numeric(5,2) not null default 5,

  -- Money in rupees, 2 dp. taxable + cgst + sgst + igst + round_off = total.
  taxable_value               numeric(12,2) not null,
  cgst                        numeric(12,2) not null default 0,
  sgst                        numeric(12,2) not null default 0,
  igst                        numeric(12,2) not null default 0,
  round_off                   numeric(12,2) not null default 0,
  total                       numeric(12,2) not null,
  amount_in_words             text not null,

  -- Lifecycle.
  status                      text not null default 'draft'
                              check (status in
                                ('draft','syncing','synced','failed')),
  tally_voucher_id            text,   -- Tally MASTERID/GUID of the voucher
  tally_company               text,   -- SVCURRENTCOMPANY used at import
  tally_synced_at             timestamptz,
  tally_error                 text,   -- last import error, for retry UX

  -- Patient delivery.
  pdf_url                     text,
  pdf_path                    text,
  whatsapp_message_id         text,
  whatsapp_sent_at            timestamptz,

  -- Audit.
  created_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists tax_invoices_contact_idx
  on public.tax_invoices(contact_id, created_at desc);
create index if not exists tax_invoices_status_idx
  on public.tax_invoices(status, created_at desc);
-- An issued invoice number must be unique once assigned (NULLs allowed
-- while draft/syncing).
create unique index if not exists tax_invoices_number_uidx
  on public.tax_invoices(invoice_number)
  where invoice_number is not null;

-- RLS — same workspace-internal model as payments/bookings. Service
-- role bypasses for server-side writes (Tally sync, PDF send).
alter table public.tax_invoices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tax_invoices'
      and policyname = 'tax_invoices_all_authenticated'
  ) then
    create policy tax_invoices_all_authenticated
      on public.tax_invoices
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end$$;
