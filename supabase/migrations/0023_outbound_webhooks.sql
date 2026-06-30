-- Outbound webhooks per business phone number.
--
-- Operators register one or more URLs against a phone number; whenever
-- an event lands on that number (inbound message of any type, status
-- update, call event, campaign progress) the app fires a fire-and-forget
-- POST to each enabled URL with an HMAC-SHA256 signature header so the
-- receiver can verify the source.
--
-- This is independent of the inbound Meta webhook (which is fixed at
-- /api/webhook). It's a *fan-out* mechanism so external automations
-- (n8n, Make, custom servers) can listen to anything that happens on a
-- given number.

create table if not exists outbound_webhooks (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null,
  label                       text,
  url                         text not null,
  -- HMAC secret. Generated server-side on insert; the receiver verifies
  -- the X-QHT-Signature header against `sha256(secret, raw_body)`.
  secret                      text not null,
  -- Fire-and-forget delivery: when off the row is kept (history) but
  -- nothing is sent.
  enabled                     boolean not null default true,
  -- Last-attempt diagnostics — useful to debug a misconfigured URL
  -- without spelunking through server logs.
  last_attempt_at             timestamptz,
  last_status_code            int,
  last_error                  text,
  delivery_count              bigint not null default 0,
  failure_count               bigint not null default 0,
  created_at                  timestamptz not null default now(),
  created_by_user_id          uuid references auth.users(id) on delete set null
);

create index if not exists outbound_webhooks_bpid_idx
  on outbound_webhooks(business_phone_number_id)
  where enabled = true;

alter table outbound_webhooks enable row level security;

-- Authenticated users (admin+ enforced at the API layer) can read all
-- webhooks. Writes are gated by the API too — RLS just stops anon /
-- direct-from-client manipulation.
create policy "outbound_webhooks read for authenticated"
  on outbound_webhooks for select
  using (auth.role() = 'authenticated');
