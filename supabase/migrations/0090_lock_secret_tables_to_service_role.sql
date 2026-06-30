-- 0090_lock_secret_tables_to_service_role.sql
-- Follow-up to the security audit. Three tables hold provider secrets and are
-- read by the app ONLY via the service role (verified: lib/payment-accounts.ts,
-- lib/ozonetel.ts, lib/tatatele.ts all use createServiceRoleClient; no client
-- or authenticated-context code reads them). Yet each still had a
-- `to authenticated using(true)` SELECT policy, so any logged-in user could
-- read the secrets directly over PostgREST:
--   * payment_accounts.credentials  -> Razorpay/PayU key_secret, salt, webhook_secret
--   * ozonetel_settings.api_key
--   * tatatele_settings.api_token
--
-- Dropping the authenticated SELECT policy leaves RLS enabled with NO policy,
-- which denies anon AND authenticated while the service role (BYPASSRLS) keeps
-- full access. Non-breaking. Reversible by recreating the dropped policy.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj).

-- Guarded so a table that doesn't exist in this DB (e.g. tatatele_settings was
-- never migrated) is skipped instead of aborting the whole batch.
do $$
begin
  if to_regclass('public.payment_accounts') is not null then
    execute 'drop policy if exists payment_accounts_authenticated_select on public.payment_accounts';
  end if;
  if to_regclass('public.ozonetel_settings') is not null then
    execute 'drop policy if exists ozonetel_settings_select_authenticated on public.ozonetel_settings';
  end if;
  if to_regclass('public.tatatele_settings') is not null then
    execute 'drop policy if exists tatatele_settings_select_authenticated on public.tatatele_settings';
  end if;
end$$;

-- Verify (optional): each should still report relrowsecurity = true and now
-- have zero authenticated/anon SELECT policies.
--   select tablename, policyname, roles from pg_policies
--    where tablename in ('payment_accounts','ozonetel_settings','tatatele_settings');
