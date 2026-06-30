-- 0089_protect_business_number_secrets.sql
-- Defense-in-depth for the provider secrets stored on business_numbers:
--   evolution_api_key, interakt_api_key, interakt_webhook_secret
--
-- Even with RLS, a logged-in user could `select evolution_api_key from
-- business_numbers` over PostgREST (RLS is row-level, not column-level) and
-- harvest every instance key. A plain column REVOKE is a no-op while a
-- table-level SELECT grant exists, so we revoke the table grant and re-grant
-- SELECT on only the NON-secret columns.
--
-- Safe / non-breaking: the app reads the secret columns exclusively via the
-- service role (which these grants don't touch). The only authenticated-role
-- readers of this table are the dashboard page and the home-stats query, and
-- both select a subset of the columns granted below.
--
-- Run in the Supabase SQL editor (project qflroespjasgcnsidpcj).
-- Reversible with:  grant select on public.business_numbers to authenticated;

revoke select on public.business_numbers from anon, authenticated;

grant select (
  phone_number_id,
  display_phone_number,
  verified_name,
  nickname,
  memo,
  is_active,
  created_at,
  meta_status,
  meta_checked_at,
  waba_id,
  provider,
  evolution_instance_name,
  evolution_jid,
  evolution_connection_state,
  evolution_group_id,
  profile_pic_url
) on public.business_numbers to authenticated;

-- Verify (optional): should list ONLY the non-secret columns above, never
-- evolution_api_key / interakt_api_key / interakt_webhook_secret.
--   select grantee, column_name from information_schema.column_privileges
--    where table_name = 'business_numbers' and grantee = 'authenticated'
--    order by column_name;
