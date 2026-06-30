-- API tokens per business phone number.
--
-- An API token is the authorisation an external automation (n8n, Make,
-- a custom server) presents to our /api/v1/* endpoints. The token maps
-- to exactly one business_phone_number_id; the relay then uses that
-- portfolio's Meta access token (which never leaves the server) to
-- actually call Meta. So integrators never see Meta credentials.
--
-- Distinct from `outbound_webhooks.secret`:
--   • outbound_webhooks.secret       — HMAC key, used to VERIFY messages we send out
--   • api_tokens.token               — Bearer token, used to AUTHENTICATE inbound API calls
--
-- Separating the two means rotating one doesn't break the other.

create table if not exists api_tokens (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null,
  name                        text not null,
  -- The actual Bearer value. Plain so the operator can reveal+copy it
  -- from the UI (we don't have a "show only at creation" flow yet).
  -- Lookup is by exact string match — see the index below.
  token                       text not null unique,
  enabled                     boolean not null default true,
  last_used_at                timestamptz,
  request_count               bigint not null default 0,
  created_at                  timestamptz not null default now(),
  created_by_user_id          uuid references auth.users(id) on delete set null
);

create index if not exists api_tokens_token_idx
  on api_tokens(token)
  where enabled = true;

create index if not exists api_tokens_bpid_idx
  on api_tokens(business_phone_number_id);

alter table api_tokens enable row level security;

-- Authenticated users can read; admin+ writes are gated by the API
-- routes themselves. RLS just blocks anon / direct-from-client edits.
create policy "api_tokens read for authenticated"
  on api_tokens for select
  using (auth.role() = 'authenticated');
