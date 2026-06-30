-- Global contact labels. Workspace-defined set (e.g. "VIP",
-- "Follow-up", "Cold lead") that any team member can assign to a
-- contact. Max 3 per contact — enforced at the API layer so the UI can
-- still render a 3-label cap badge.
--
-- Why a separate table + array column (not many-to-many):
--   • Most queries need ALL labels for a contact, every read. An array
--     column with a single JOIN keeps the contact-list query cheap.
--   • Labels are a small set (dozens), so the join table overhead isn't
--     worth the normalisation gain.
--
-- contacts.label_ids stores the uuids ordered as the operator picked
-- them — the chip strip honours that order.

create table if not exists public.contact_labels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  /** Tailwind colour key — emerald / sky / violet / amber / rose /
      teal / slate. NULL falls back to slate. */
  color       text,
  /** Optional one-line description shown in the Labels settings tab. */
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists contact_labels_name_lower_idx
  on public.contact_labels (lower(name));

alter table public.contacts
  add column if not exists label_ids uuid[] not null default '{}';

-- GIN index — fast "contacts with this label" filters from the inbox.
create index if not exists contacts_label_ids_idx
  on public.contacts using gin (label_ids);

alter table public.contact_labels enable row level security;
