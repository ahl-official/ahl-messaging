-- import_chats_from_table — direct table → contacts+messages import.
--
-- The CSV upload flow had to ship 2M+ row tables through the operator's
-- browser, which choked on large files and required psql tricks to even
-- download. This function pulls the same data INSIDE Postgres without
-- ever leaving the DB.
--
-- Caller (the run API route) validates the source table + column map
-- and passes everything in as parameters. The function builds a safe
-- dynamic SQL using `format()` quoting, runs the contacts upsert + the
-- messages upsert, and returns a JSON summary the API ships back.
--
-- Helper function for column discovery — also used by /preview when
-- supabase-js can't read information_schema directly.

create or replace function public.get_columns(schema_name text, tbl_name text)
returns table(column_name text)
language sql
stable
as $$
  select c.column_name::text
  from information_schema.columns c
  where c.table_schema = schema_name
    and c.table_name = tbl_name;
$$;

grant execute on function public.get_columns(text, text) to authenticated, service_role;

create or replace function public.list_public_tables()
returns table(table_name text)
language sql
stable
as $$
  select t.table_name::text
  from information_schema.tables t
  where t.table_schema = 'public'
    and t.table_type = 'BASE TABLE';
$$;

grant execute on function public.list_public_tables() to authenticated, service_role;

create or replace function public.import_chats_from_table(
  src_table     text,
  target_bpid   text,
  col_wa_id     text,
  col_direction text,
  col_type      text,
  col_content   text,
  col_media_url text,
  col_timestamp text,
  has_type      boolean default false,
  has_media_url boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  inserted_contacts int := 0;
  inserted_messages int := 0;
  skipped_messages  int := 0;
  total_in_source   int := 0;
begin
  -- Large archives (2M+ rows) run past the default 8s PostgREST
  -- statement timeout. Disable it for the duration of this function
  -- — the inserts are bulk anyway, and the operator's UI is willing
  -- to wait. Reset on function exit happens automatically.
  perform set_config('statement_timeout', '0', true);
  -- Step 1: distinct contacts. wa_id digits-only, range 7..14 to keep
  -- WhatsApp LIDs / garbage out.
  execute format(
    $f$
    with src as (
      select distinct
        regexp_replace(%I::text, '\D', '', 'g') as wa_id
      from public.%I
      where %I is not null
    )
    insert into public.contacts (wa_id, business_phone_number_id, status, imported)
    select wa_id, %L, 'open', true
    from src
    where length(wa_id) between 7 and 14
    on conflict (wa_id, business_phone_number_id) do nothing
    $f$,
    col_wa_id, src_table, col_wa_id, target_bpid
  );
  get diagnostics inserted_contacts = row_count;

  -- Step 2: messages. Synthetic wa_message_id ('import:<sha>') guards
  -- against duplicates on re-run via the wa_message_id unique index.
  -- Type / media_url are optional — we substitute 'text' / NULL when
  -- the source doesn't have those columns.
  execute format(
    $f$
    insert into public.messages (
      contact_id, wa_message_id, direction, type, content, media_url,
      status, timestamp, business_phone_number_id
    )
    select
      c.id,
      'import:' || encode(
        digest(c.id::text || '|' || s.%I::text || '|' || s.%I::text || '|' || coalesce(s.%I, ''), 'sha256'),
        'hex'
      ),
      s.%I,
      %s,
      s.%I,
      %s,
      'delivered',
      s.%I,
      %L
    from public.%I s
    join public.contacts c
      on c.wa_id = regexp_replace(s.%I::text, '\D', '', 'g')
     and c.business_phone_number_id = %L
    where s.%I is not null
      and length(regexp_replace(s.%I::text, '\D', '', 'g')) between 7 and 14
    on conflict (wa_message_id) do nothing
    $f$,
    col_timestamp, col_direction, col_content,
    col_direction,
    case when has_type then format('coalesce(s.%I, %L)', col_type, 'text') else quote_literal('text') end,
    col_content,
    case when has_media_url then format('s.%I', col_media_url) else 'NULL' end,
    col_timestamp,
    target_bpid,
    src_table,
    col_wa_id,
    target_bpid,
    col_wa_id,
    col_wa_id
  );
  get diagnostics inserted_messages = row_count;

  -- Step 3: count source rows for the "skipped" delta.
  execute format('select count(*) from public.%I', src_table) into total_in_source;
  skipped_messages := greatest(0, coalesce(total_in_source, 0) - inserted_messages);

  -- Step 4: refresh contact last_message_* for target number.
  update public.contacts c
  set last_message_at      = sub.ts,
      last_message_preview = left(coalesce(sub.content, ''), 120),
      last_message_direction = sub.direction,
      last_message_status    = sub.status
  from (
    select distinct on (contact_id)
      contact_id, timestamp as ts, content, direction, status
    from public.messages
    where business_phone_number_id = target_bpid
    order by contact_id, timestamp desc
  ) sub
  where sub.contact_id = c.id
    and c.business_phone_number_id = target_bpid;

  return jsonb_build_object(
    'inserted_contacts', inserted_contacts,
    'inserted_messages', inserted_messages,
    'skipped_messages',  skipped_messages
  );
end$$;

grant execute on function public.import_chats_from_table(
  text, text, text, text, text, text, text, text, boolean, boolean
) to authenticated, service_role;

-- pgcrypto for digest() — already enabled in most Supabase projects,
-- but harmless if re-enabled.
create extension if not exists pgcrypto;
