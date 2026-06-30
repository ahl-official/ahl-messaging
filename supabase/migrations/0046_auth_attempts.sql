-- Failed-login throttling. Records each email/password attempt (success
-- or fail) so the login action can lock out an email OR IP after too
-- many failures in a short window.
--
-- Lockout policy (enforced in app code, not SQL):
--   - 5 failed attempts in the last 15 minutes for the same email  → blocked
--   - 5 failed attempts in the last 15 minutes for the same IP     → blocked
-- A successful login does NOT reset the count — we just stop counting
-- because the user is in. Old rows age out via the time-window query.

create table if not exists auth_attempts (
  id          bigserial primary key,
  email       text,
  ip          text,
  success     boolean not null,
  created_at  timestamptz not null default now()
);

create index if not exists auth_attempts_email_recent_idx
  on auth_attempts (email, created_at desc) where success = false;

create index if not exists auth_attempts_ip_recent_idx
  on auth_attempts (ip, created_at desc) where success = false;

-- Keep the table small — drop anything older than 24 hours daily. We
-- only look at the last 15 min so older rows are pure dead weight.
-- Run this via a Supabase scheduled function or a cron in the host; the
-- statement is idempotent and cheap.
--   delete from auth_attempts where created_at < now() - interval '24 hours';

-- Service-role only. The login server action uses the service-role
-- client (or a server-side client with insert/select grants) — no row
-- the end user should ever read.
alter table auth_attempts enable row level security;
-- No policies = no anon/authenticated access. Service role bypasses RLS.
