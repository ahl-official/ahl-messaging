-- Add template_name to messages so per-agent reports can split
-- "regular template sends" from "magic message" sends. Previously
-- both shared type='template' with no distinguishing key, forcing
-- fragile content / button heuristics. The column is nullable so old
-- rows stay valid and only outbound template inserts moving forward
-- will populate it.

alter table public.messages
  add column if not exists template_name text;

create index if not exists messages_template_name_idx
  on public.messages (template_name)
  where template_name is not null;
