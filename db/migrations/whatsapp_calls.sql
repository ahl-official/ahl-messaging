-- WhatsApp Cloud Calling — call records table.
--
-- One row per call leg (inbound or outbound). The webhook handler
-- creates the row on `ringing` and updates it through the lifecycle
-- (accepted / rejected / terminated). Operators see calls in the
-- chat thread via this table; the UI joins on contact_id to surface
-- "Call started", "Missed call", etc. in-line with messages.

create table if not exists public.whatsapp_calls (
  id uuid primary key default gen_random_uuid(),
  /** Meta's call_id from the calls[] webhook entry. */
  wa_call_id text unique,
  contact_id uuid references public.contacts(id) on delete cascade,
  business_phone_number_id text,
  /** "inbound" = user called us; "outbound" = we called the user. */
  direction text not null check (direction in ('inbound', 'outbound')),
  /** Latest event seen for this call: ringing → accepted / rejected
   *  / terminated / missed. */
  status text not null default 'ringing'
    check (status in ('ringing', 'accepted', 'rejected', 'terminated', 'missed', 'failed')),
  /** SDP offer from Meta (WebRTC route) — null when SIP is used. */
  sdp_offer text,
  /** SDP answer we sent back. */
  sdp_answer text,
  /** Permission state for outbound: pending → granted / denied / expired. */
  permission_state text,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  duration_seconds int,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_calls_contact_idx
  on public.whatsapp_calls (contact_id, start_at desc);
create index if not exists whatsapp_calls_status_idx
  on public.whatsapp_calls (status)
  where status in ('ringing', 'accepted');

-- Track call-permission grants per user — Meta requires explicit
-- consent before a business can place outbound calls.
create table if not exists public.whatsapp_call_permissions (
  contact_id uuid primary key references public.contacts(id) on delete cascade,
  /** "granted" | "denied" | "pending" */
  state text not null default 'pending',
  granted_at timestamptz,
  /** Meta's CPR is single-use OR limited-time — we cache the expiry
   *  so the UI knows when to re-request consent. */
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
