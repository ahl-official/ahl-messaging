-- =====================================================================
-- 0004 — Conversation status + assignment
-- Each conversation (contact) can be open/closed and assigned to one agent.
-- =====================================================================

alter table public.contacts
  add column if not exists status text default 'open'
    check (status in ('open', 'closed')),
  add column if not exists assigned_to uuid
    references auth.users(id) on delete set null,
  add column if not exists assigned_to_email text,
  add column if not exists assigned_at timestamptz;

create index if not exists idx_contacts_status    on public.contacts(status);
create index if not exists idx_contacts_assigned  on public.contacts(assigned_to);
