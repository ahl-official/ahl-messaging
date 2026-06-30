-- get_agent_reports (0082) removed the 100-round-trip fan-out, but for the
-- owner viewing ALL numbers it still scanned ~122k outbound rows in 8.4 s —
-- because sent_by_email / type / template_name / contact_id live only in the
-- heap, so every matched row needed a random heap fetch.
--
-- Fix: covering PARTIAL indexes that carry those columns in the index payload,
-- so the per-agent + per-day rollups become index-only scans. Plus rewrite the
-- daily CTE into direction-split sub-queries so each side can use its partial
-- index (a single all-direction scan can't use a partial index).
--
-- NOTE: messages is the largest table — create these with CREATE INDEX
-- CONCURRENTLY (run each statement on its own, outside a transaction). The
-- plain messages_timestamp_idx added during debugging is unused (the planner
-- never picks it) and is dropped here.

drop index concurrently if exists public.messages_timestamp_idx;

create index concurrently if not exists messages_rep_outbound_idx
  on public.messages (timestamp)
  include (sent_by_email, type, template_name)
  where direction = 'outbound';

create index concurrently if not exists messages_rep_inbound_idx
  on public.messages (timestamp)
  include (contact_id)
  where direction = 'inbound';

create or replace function public.get_agent_reports(
  p_since  timestamptz,
  p_until  timestamptz,
  p_bpids  text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with out_msgs as (
    select
      sent_by_email                                                            as email,
      count(*) filter (where type = 'text')                                    as text_replies,
      count(*) filter (where type = 'template')                                as template_sends,
      count(*) filter (where type = 'template' and template_name = 'magic_message')
                                                                               as magic_messages
    from messages
    where direction = 'outbound'
      and sent_by_email is not null
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by sent_by_email
  ),
  call_stats as (
    select
      handled_by_email                   as email,
      count(*)                           as calls_handled,
      coalesce(sum(duration_seconds), 0) as talk_time_seconds
    from whatsapp_calls
    where handled_by_email is not null
      and (p_since is null or start_at >= p_since)
      and (p_until is null or start_at <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by handled_by_email
  ),
  daily_in as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day,
      count(*)                                            as patient_messages,
      count(distinct contact_id)                          as unique_patients
    from messages
    where direction = 'inbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  daily_out as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day,
      count(*)                                            as outbound
    from messages
    where direction = 'outbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  daily as (
    select
      coalesce(i.day, o.day)               as day,
      coalesce(i.patient_messages, 0)      as patient_messages,
      coalesce(o.outbound, 0)              as outbound,
      coalesce(i.unique_patients, 0)       as unique_patients
    from daily_in i
    full join daily_out o on i.day = o.day
  ),
  inbound_tot as (
    select
      count(*)                   as patient_messages,
      count(distinct contact_id) as unique_patients
    from messages
    where direction = 'inbound'
      and (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
  )
  select jsonb_build_object(
    'outbound',       coalesce((select jsonb_agg(to_jsonb(o)) from out_msgs o), '[]'::jsonb),
    'calls',          coalesce((select jsonb_agg(to_jsonb(c)) from call_stats c), '[]'::jsonb),
    'daily',          coalesce((select jsonb_agg(to_jsonb(d) order by d.day desc) from daily d), '[]'::jsonb),
    'inbound_totals', coalesce((select to_jsonb(t) from inbound_tot t),
                               jsonb_build_object('patient_messages', 0, 'unique_patients', 0))
  );
$$;

grant execute on function public.get_agent_reports(timestamptz, timestamptz, text[])
  to anon, authenticated, service_role;
