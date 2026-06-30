-- Scheduler queue for Lead Automation "Wait" nodes. When a flow hits a Wait,
-- the engine enqueues a continuation here (resume from the node after the wait
-- at run_at = now + wait duration) instead of blocking. The process-pending
-- cron picks due rows and resumes the flow — so waits of any length (seconds
-- → days) work and survive restarts.

create table if not exists lead_automation_pending (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null,
  prospect_id text not null,
  resume_node_id text not null,
  lead jsonb not null,          -- snapshot used to resume (mobile, fields, …)
  run_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (automation_id, prospect_id, resume_node_id)
);

create index if not exists lead_automation_pending_due_idx
  on lead_automation_pending (run_at);
