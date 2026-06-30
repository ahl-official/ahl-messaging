-- 0088_rls_hardening.sql
-- Security audit remediation (see SECURITY_AUDIT.md — C2, C3, H2).
--
-- Closes direct public-anon-key access to sensitive tables via PostgREST.
-- The app writes everything through the service role (which BYPASSES RLS),
-- and the dashboard reads some tables directly with the anon key + the
-- logged-in user's JWT (role = 'authenticated'). So the pattern below is:
--   * enable RLS                                  -> blocks the anon role
--   * add a SELECT policy "to authenticated"      -> keeps dashboard reads
--   * add NO insert/update/delete policy          -> writes stay service-role
-- This is non-breaking: anon (no login) is denied; logged-in reads keep
-- working; all writes continue through the server.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj). Idempotent.

-- ---------------------------------------------------------------------------
-- C2 — 11 tables that never enabled RLS (were anon-readable AND anon-writable)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'automation_configs',
    'automation_logs',
    'bookings',
    'whatsapp_calls',
    'whatsapp_call_permissions',
    'quick_replies',
    'api_request_log',
    'evolution_disconnects',
    'evolution_status_posts',
    'ozonetel_settings',
    'tatatele_settings'
  ];
begin
  foreach t in array tables loop
    -- Skip any table that doesn't exist in this database (defensive).
    if to_regclass('public.' || t) is null then
      raise notice 'skip: table public.% does not exist', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );
    raise notice 'RLS enabled + authenticated SELECT policy on public.%', t;
  end loop;
end$$;

-- NOTE: tables that are purely server-mediated (api_request_log,
-- automation_logs, evolution_disconnects, evolution_status_posts,
-- ozonetel_settings, tatatele_settings, whatsapp_call_permissions) do not
-- actually need the authenticated SELECT policy — they can be tightened to
-- service-role-only by dropping their *_select_authenticated policy once you
-- confirm nothing in the dashboard reads them directly with the anon key.

-- ---------------------------------------------------------------------------
-- C3 — payments: replace FOR ALL/using(true) with read-only for authenticated.
-- Any authenticated user could previously INSERT/UPDATE/DELETE every payment
-- straight through PostgREST. Writes must go through the server (service role).
-- ---------------------------------------------------------------------------
drop policy if exists payments_all_authenticated on public.payments;
drop policy if exists payments_select_authenticated on public.payments;
create policy payments_select_authenticated
  on public.payments
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- H2 — api_tokens: plaintext bearer tokens were readable by ANY authenticated
-- user. Restrict reads to admin/superadmin/owner. (Writes already go through
-- admin-gated API routes using the service role.)
-- ---------------------------------------------------------------------------
drop policy if exists "api_tokens read for authenticated" on public.api_tokens;
drop policy if exists api_tokens_admin_read on public.api_tokens;
create policy api_tokens_admin_read
  on public.api_tokens
  for select
  to authenticated
  using (public.current_member_role() in ('owner', 'superadmin', 'admin'));

-- ---------------------------------------------------------------------------
-- Verify (optional): each should return 'true' for relrowsecurity.
--   select relname, relrowsecurity from pg_class
--    where relname in ('payments','api_tokens','bookings','whatsapp_calls',
--      'automation_configs','automation_logs','quick_replies','api_request_log',
--      'evolution_disconnects','evolution_status_posts','ozonetel_settings',
--      'tatatele_settings','whatsapp_call_permissions');
-- ---------------------------------------------------------------------------
