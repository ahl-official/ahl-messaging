-- Per-number controls for updating EXISTING LSQ leads when a new
-- WhatsApp inbound arrives. Default behaviour is unchanged (linked
-- only — original attribution preserved). Operator opts in when they
-- want re-attribution.
--
--   update_existing_lead_source        — master toggle, OFF by default.
--   update_existing_lead_max_age_days  — only re-attribute leads whose
--     LSQ CreatedOn is within this many days. NULL = no age cap (any
--     age allowed if the toggle is on). 0 / negative = same as NULL.

alter table public.automation_configs
  add column if not exists update_existing_lead_source boolean
    not null default false;

alter table public.automation_configs
  add column if not exists update_existing_lead_max_age_days integer;
