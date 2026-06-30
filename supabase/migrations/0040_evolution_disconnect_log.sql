-- Evolution disconnect log — every `connection.update` event with
-- state='close' coming from Evolution lands one row here. The
-- evolution-number health badge ("good / unstable / at-risk") is derived
-- from the row count + the most-recent reason code:
--   • 401  → Baileys was logged out (number unlinked from Linked Devices
--            or banned by WhatsApp). The number is effectively dead until
--            re-scanned.
--   • 408 / 500 / 503 → transient network blips. Harmless in small numbers,
--            warning if frequent.
--   • 515  → "stream errored" — Baileys couldn't reach the WA gateway.
--            Often network/IP related.
--
-- Schema is tiny so we don't need to age out rows aggressively — the
-- health window query just selects WHERE occurred_at > now() - 24h.
-- A nightly prune of rows older than 7d keeps the table from growing
-- forever; deferred to a future migration when row counts justify it.

create table if not exists evolution_disconnects (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null references business_numbers(phone_number_id) on delete cascade,
  reason_code                 int  not null,
  occurred_at                 timestamptz not null default now()
);

create index if not exists evolution_disconnects_bpid_ts_idx
  on evolution_disconnects (business_phone_number_id, occurred_at desc);
