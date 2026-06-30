-- API request audit log. Every authenticated v1 endpoint hit lands a
-- row here so the API tokens page can show per-day request counts +
-- a "where are these calls actually coming from" breakdown (token
-- name, user-agent → derived platform label).
--
-- Kept lean: status code + duration + a short truncated user_agent.
-- Bodies / response payloads are NOT logged (they contain customer
-- PII / message content; the existing messages table already captures
-- the business-relevant data).
--
-- token_id is nullable because some routes (webhook callbacks, etc.)
-- might be in scope later but don't carry a token.

create table if not exists api_request_log (
  id                          uuid primary key default gen_random_uuid(),
  token_id                    uuid references api_tokens(id) on delete set null,
  token_name                  text,
  business_phone_number_id    text,
  method                      text not null,
  path                        text not null,
  status                      int  not null,
  duration_ms                 int,
  user_agent                  text,
  source_ip                   text,
  occurred_at                 timestamptz not null default now()
);

create index if not exists api_request_log_token_ts_idx
  on api_request_log (token_id, occurred_at desc);
create index if not exists api_request_log_ts_idx
  on api_request_log (occurred_at desc);
create index if not exists api_request_log_bpid_ts_idx
  on api_request_log (business_phone_number_id, occurred_at desc);
