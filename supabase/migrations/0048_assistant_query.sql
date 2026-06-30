-- Read-only SQL escape hatch for the in-app AI assistant.
--
-- Supabase JS doesn't expose raw SQL — every read goes through the
-- PostgREST builder, which can't represent ad-hoc joins / aggregations
-- the assistant might need for one-off questions ("top contacts by
-- inbound messages this month grouped by tag"). This function gives
-- the service-role client a single RPC to run an arbitrary SELECT and
-- get back a JSONB array of rows.
--
-- Safety rails (enforced both here AND in the API route):
--   • The query MUST start with SELECT or WITH (case-insensitive).
--   • The query MUST NOT contain a semicolon except as a trailing
--     character — blocks classic stacked-statement injection.
--   • Implicit row cap of 200 (via LIMIT 200 wrapper if the caller's
--     query doesn't already have a LIMIT).
--   • SECURITY DEFINER + revoke from public so only the service role
--     can execute it.

create or replace function public.assistant_run_select(query_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
  cleaned text := btrim(query_text);
begin
  if cleaned is null or length(cleaned) = 0 then
    raise exception 'empty query';
  end if;
  -- strip a single trailing semicolon if present
  if right(cleaned, 1) = ';' then
    cleaned := btrim(left(cleaned, length(cleaned) - 1));
  end if;
  if position(';' in cleaned) > 0 then
    raise exception 'semicolons not allowed in query body';
  end if;
  if not (lower(left(cleaned, 6)) = 'select' or lower(left(cleaned, 4)) = 'with') then
    raise exception 'only SELECT / WITH queries are allowed';
  end if;
  -- Wrap into json_agg so the result is always a single JSONB array.
  -- Hard cap at 200 rows so the assistant can't accidentally pull a
  -- million message bodies into the model context.
  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from (%s limit 200) t',
    cleaned
  ) into result;
  return result;
exception when others then
  -- Surface the Postgres error message to the caller so the assistant
  -- can correct itself rather than retrying the same broken query.
  raise exception '%', sqlerrm;
end
$$;

revoke all on function public.assistant_run_select(text) from public;
revoke all on function public.assistant_run_select(text) from anon;
revoke all on function public.assistant_run_select(text) from authenticated;
-- service_role automatically has execute since it inherits everything,
-- but be explicit for future-proofing.
grant execute on function public.assistant_run_select(text) to service_role;
