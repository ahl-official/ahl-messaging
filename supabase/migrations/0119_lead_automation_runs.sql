-- Dedup ledger for the Lead Automation execution engine. When an LSQ
-- webhook fires a published automation's action (e.g. "send template"), we
-- record (automation, prospect, node) here so the same action never fires
-- twice for the same lead — even if LSQ re-sends the stage-change event.

create table if not exists lead_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null,
  prospect_id text not null,
  node_id text not null,
  sent_at timestamptz not null default now(),
  unique (automation_id, prospect_id, node_id)
);

create index if not exists lead_automation_runs_prospect_idx
  on lead_automation_runs (prospect_id);
