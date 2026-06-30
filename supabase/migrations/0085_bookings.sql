-- Calendar booking / "Date Align" feature.
--   • Agent opens a contact → picks an available date directly, OR shares a
--     public link (/book/<token>) so the patient picks one themselves.
--   • Availability is read from the clinic's Google Calendar (all-day
--     holiday/closed events block a day) + a per-day capacity enforced here.
--   • On confirm: a Google Calendar event is created, the date is pushed to
--     LSQ, and an approved WhatsApp template is sent to the patient.
--
-- Google creds, capacity, booking window, template name and the LSQ
-- field/stage all live in app_settings (see lib/bookings) so they can be
-- configured without a migration.

create table if not exists public.bookings (
  id                        uuid primary key default gen_random_uuid(),
  -- Opaque public-link token. The patient opens /book/<token>.
  token                     text not null unique,
  contact_id                uuid references public.contacts(id) on delete cascade,
  business_phone_number_id  text,
  wa_id                     text,
  patient_name              text,
  -- NULL until a date is actually chosen.
  booking_date              date,
  status                    text not null default 'pending'
                              check (status in ('pending','confirmed','cancelled','expired')),
  -- Who chose the date — the agent (aligned directly) or the patient (link).
  source                    text check (source in ('agent','patient')),
  created_by_user_id        uuid,
  created_by_email          text,
  -- Google Calendar event id, once the event is written.
  gcal_event_id             text,
  lsq_synced                boolean not null default false,
  confirmed_at              timestamptz,
  -- Pending link expiry (e.g. 7 days) so stale links don't linger.
  expires_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists bookings_contact_idx on public.bookings (contact_id, created_at desc);
-- Per-day capacity counting reads confirmed bookings by date.
create index if not exists bookings_date_idx
  on public.bookings (booking_date) where status = 'confirmed';
create index if not exists bookings_status_idx on public.bookings (status, created_at desc);
