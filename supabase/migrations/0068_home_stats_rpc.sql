-- Single-shot home-page stats aggregation.
--
-- The TypeScript implementation in lib/home-stats.ts paginated through
-- all 39k+ contacts + every inbound message in the last 48 h to
-- compute the counters the /home dashboard shows. End-to-end took
-- 6-10 s on production. This function does the same work in Postgres
-- with proper aggregations + indexes — runs in <300 ms.
--
-- bpid_filter NULL = workspace-wide (owner view).
-- bpid_filter [] / non-null = scope to that allow-list (teammate view).
-- Returning JSONB lets the TS layer pick fields without managing a
-- composite row type.

create or replace function public.get_home_stats(bpid_filter text[])
returns jsonb
language plpgsql
stable
as $$
declare
  cutoff_inbound  timestamptz := now() - interval '48 hours';
  warn_cutoff     timestamptz := now() - interval '18 hours';   -- 24-6h window
  closed_cutoff   timestamptz := now() - interval '24 hours';
  result jsonb;
  -- scope helper: true when filter is null OR row's bpid is in filter
  -- (Postgres treats `x = any(null)` as null, so we explicit-test).
begin
  with
  -- Per-contact stats — single scan over `contacts`.
  scoped_contacts as (
    select
      c.id,
      c.wa_id,
      c.name,
      c.profile_name,
      coalesce(c.status, 'open') as status,
      coalesce(c.unread_count, 0) as unread_count,
      c.tags,
      c.business_phone_number_id,
      c.assigned_to
    from public.contacts c
    where bpid_filter is null
       or c.business_phone_number_id = any(bpid_filter)
  ),
  -- Latest inbound timestamp per contact, last 48 h only.
  latest_inbound as (
    select
      m.contact_id,
      max(m.timestamp) as latest_at
    from public.messages m
    where m.direction = 'inbound'
      and m.timestamp >= cutoff_inbound
      and (bpid_filter is null
           or m.business_phone_number_id = any(bpid_filter))
    group by m.contact_id
  ),
  -- Top-line counters.
  counters as (
    select
      count(*) filter (where status = 'open') as open_count,
      count(*) filter (where status = 'closed') as closed_count,
      count(*) as total_conversations,
      count(*) filter (where unread_count > 0) as unread_conversations,
      coalesce(sum(unread_count), 0) as unread_messages,
      count(*) filter (
        where status = 'open' and assigned_to is null
      ) as unassigned_open
    from scoped_contacts
  ),
  -- 24-h window expiry split, joined per-contact.
  window_split as (
    select
      count(*) filter (
        where li.latest_at between warn_cutoff and now()
        and (warn_cutoff + (now() - li.latest_at)) <= warn_cutoff + interval '6 hours'
        and (now() - li.latest_at) <= interval '6 hours'
      ) as windows_expiring_soon_unused, -- placeholder; we recompute below
      0 as placeholder
    from scoped_contacts sc
    left join latest_inbound li on li.contact_id = sc.id
  ),
  -- Simpler & accurate window computation:
  --   windows_expiring_soon: latest_at within (now-24h .. now-18h], i.e.
  --      6h or less remaining in the 24 h customer-care window.
  --   windows_closed: latest_at <= now-24h OR no inbound in 48h.
  window_counts as (
    select
      count(*) filter (
        where li.latest_at is not null
          and li.latest_at >= closed_cutoff
          and li.latest_at <= warn_cutoff
      ) as windows_expiring_soon,
      count(*) filter (
        where sc.status = 'open'
          and (li.latest_at is null or li.latest_at < closed_cutoff)
      ) as windows_closed
    from scoped_contacts sc
    left join latest_inbound li on li.contact_id = sc.id
  ),
  -- Per-business-number breakdown.
  per_number as (
    select
      sc.business_phone_number_id,
      bn.verified_name,
      bn.display_phone_number,
      count(*) as total_count,
      count(*) filter (where sc.status = 'open') as open_count,
      count(*) filter (where sc.unread_count > 0) as unread_conversations,
      coalesce(sum(sc.unread_count), 0) as unread_messages
    from scoped_contacts sc
    left join public.business_numbers bn
      on bn.phone_number_id = sc.business_phone_number_id
    where sc.business_phone_number_id is not null
    group by sc.business_phone_number_id, bn.verified_name, bn.display_phone_number
    order by open_count desc, total_count desc
    limit 20
  ),
  -- Top tags via unnest.
  tag_rows as (
    select
      unnest(coalesce(sc.tags, '{}'::text[])) as tag,
      sc.unread_count
    from scoped_contacts sc
  ),
  top_tags as (
    select
      tag,
      count(*) as total_count,
      count(*) filter (where unread_count > 0) as unread_count
    from tag_rows
    where tag is not null and tag <> ''
    group by tag
    order by total_count desc
    limit 12
  ),
  -- Recent 8 inbound messages (lightweight).
  recent_msgs as (
    select
      m.contact_id,
      m.content,
      m.timestamp,
      m.business_phone_number_id
    from public.messages m
    where m.direction = 'inbound'
      and (bpid_filter is null
           or m.business_phone_number_id = any(bpid_filter))
    order by m.timestamp desc
    limit 8
  ),
  recent_activity as (
    select
      rm.contact_id,
      sc.wa_id,
      coalesce(nullif(trim(sc.name), ''), nullif(trim(sc.profile_name), ''), sc.wa_id) as display_name,
      rm.content as preview,
      rm.timestamp,
      rm.business_phone_number_id
    from recent_msgs rm
    join scoped_contacts sc on sc.id = rm.contact_id
    order by rm.timestamp desc
  )
  select jsonb_build_object(
    'openCount',            (select open_count from counters),
    'closedCount',          (select closed_count from counters),
    'totalConversations',   (select total_conversations from counters),
    'unreadConversations',  (select unread_conversations from counters),
    'unreadMessages',       (select unread_messages from counters),
    'unassignedOpen',       (select unassigned_open from counters),
    'windowsExpiringSoon',  (select windows_expiring_soon from window_counts),
    'windowsClosed',        (select windows_closed from window_counts),
    'perNumber', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'business_phone_number_id', business_phone_number_id,
        'verified_name', verified_name,
        'display_phone_number', display_phone_number,
        'totalCount', total_count,
        'openCount', open_count,
        'unreadConversations', unread_conversations,
        'unreadMessages', unread_messages
      )) from per_number),
      '[]'::jsonb
    ),
    'topTags', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'tag', tag,
        'totalCount', total_count,
        'unreadCount', unread_count
      )) from top_tags),
      '[]'::jsonb
    ),
    'recentActivity', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'contact_id', contact_id,
        'wa_id', wa_id,
        'display_name', display_name,
        'preview', preview,
        'timestamp', timestamp,
        'business_phone_number_id', business_phone_number_id
      )) from recent_activity),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end$$;

-- Indexes the function relies on. Most exist already from earlier
-- migrations; CREATE IF NOT EXISTS keeps this idempotent.
create index if not exists messages_inbound_timestamp_idx
  on public.messages (timestamp desc)
  where direction = 'inbound';
create index if not exists contacts_bpid_status_idx
  on public.contacts (business_phone_number_id, status);

-- Allow the public.authenticated and service-role to execute. RLS on
-- the underlying tables still enforces row visibility for callers.
grant execute on function public.get_home_stats(text[]) to authenticated, service_role;
