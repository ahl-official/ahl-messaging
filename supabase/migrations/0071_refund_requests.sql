-- =====================================================================
-- 0071 — refund_requests
-- ---------------------------------------------------------------------
-- Operator-submitted refund requests, raised from the contact-details
-- panel. The form pre-fills agent + patient + lead from session/LSQ and
-- the operator types in the package + amount fields (which live in
-- LSQ as AI-summary text today, so they're freeform).
--
-- Each row references the chat (`contact_id`) so the admin queue can
-- jump straight back to the conversation. `payment_screenshot_url`
-- points at a Supabase Storage object uploaded at form-submit time.
-- =====================================================================

create table if not exists public.refund_requests (
  id                        uuid primary key default gen_random_uuid(),

  -- Who raised the request + which chat it came from
  contact_id                uuid not null references public.contacts(id) on delete cascade,
  requested_by_user_id      uuid references auth.users(id) on delete set null,
  requested_by_email        text,            -- cached agent email for display
  requested_by_name         text,            -- cached agent display name

  -- Patient / lead identifiers (auto-filled from LSQ at form-fill time
  -- but stored on the row so a later LSQ change doesn't rewrite history)
  lsq_lead_number           text,            -- "#432029"
  lsq_prospect_id           text,            -- LSQ ProspectAutoId
  patient_name              text,

  -- Package fields (typed by operator from the AI Package-Shared summary)
  booking_date              date,
  per_graft_rate            numeric(10, 2),  -- ₹ per graft
  estimated_grafts          integer,
  booking_amount            numeric(12, 2),
  refundable_amount         numeric(12, 2),

  -- Reason (dropdown choice + optional free-text "Other" detail)
  reason_code               text not null,
  reason_other              text,

  -- Supporting evidence — uploaded at submit time to Supabase Storage
  payment_screenshot_url    text,
  payment_screenshot_path   text,            -- bucket path for delete-on-undo

  -- Admin workflow
  status                    text not null default 'pending'
                              check (status in ('pending','approved','rejected','paid','cancelled')),
  admin_notes               text,
  processed_by_user_id      uuid references auth.users(id) on delete set null,
  processed_by_email        text,
  processed_at              timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists refund_requests_contact_id_idx
  on public.refund_requests (contact_id);
create index if not exists refund_requests_status_created_idx
  on public.refund_requests (status, created_at desc);
create index if not exists refund_requests_lead_number_idx
  on public.refund_requests (lsq_lead_number)
  where lsq_lead_number is not null;

-- Updated-at trigger
create or replace function public.refund_requests_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists refund_requests_set_updated_at on public.refund_requests;
create trigger refund_requests_set_updated_at
  before update on public.refund_requests
  for each row execute function public.refund_requests_set_updated_at();

-- RLS — same model as the rest of the dashboard: authenticated users
-- can read + create; admin role gates write of admin workflow fields
-- at the API layer (this table doesn't have its own role model).
alter table public.refund_requests enable row level security;

drop policy if exists "auth read refund_requests" on public.refund_requests;
create policy "auth read refund_requests"
  on public.refund_requests for select
  to authenticated
  using (true);

drop policy if exists "auth insert refund_requests" on public.refund_requests;
create policy "auth insert refund_requests"
  on public.refund_requests for insert
  to authenticated
  with check (true);

drop policy if exists "auth update refund_requests" on public.refund_requests;
create policy "auth update refund_requests"
  on public.refund_requests for update
  to authenticated
  using (true)
  with check (true);

grant select, insert, update on public.refund_requests to authenticated;
