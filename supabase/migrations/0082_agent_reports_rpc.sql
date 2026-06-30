-- Agent-productivity reports were pulling EVERY outbound + inbound message
-- for the date range into Node in 1000-row pages (see app/api/reports/agents
-- fetchAll) and grouping in JS — on a busy 30-day window that's 100k+ rows
-- across 100+ sequential round-trips, which made the Reports page hang.
--
-- This RPC does all of it in one DB call: per-agent outbound rollup, per-agent
-- call rollup, per-day inbound/outbound, and inbound totals (distinct patients).
-- The route then only does scoring + label joins in JS over ~tens of rows.
--
-- p_bpids = NULL  -> all numbers (owner/superadmin). Otherwise restrict.
-- p_since / p_until = NULL -> open-ended (range='all').

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
      handled_by_email                       as email,
      count(*)                               as calls_handled,
      coalesce(sum(duration_seconds), 0)     as talk_time_seconds
    from whatsapp_calls
    where handled_by_email is not null
      and (p_since is null or start_at >= p_since)
      and (p_until is null or start_at <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by handled_by_email
  ),
  daily as (
    select
      to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')                       as day,
      count(*) filter (where direction = 'inbound')                             as patient_messages,
      count(*) filter (where direction = 'outbound')                            as outbound,
      count(distinct contact_id) filter (where direction = 'inbound')           as unique_patients
    from messages
    where (p_since is null or timestamp >= p_since)
      and (p_until is null or timestamp <= p_until)
      and (p_bpids is null or business_phone_number_id = any (p_bpids))
    group by 1
  ),
  inbound_tot as (
    select
      count(*)                       as patient_messages,
      count(distinct contact_id)     as unique_patients
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
