-- Log of WhatsApp Status posts the operator has pushed via the
-- dashboard. Each row mirrors what was sent to Evolution + when the
-- 24-hour window expires, so the Post Status modal can show a
-- "Recent statuses" list without round-tripping to Evolution.
--
-- Note: this is OUR log, not Evolution's source of truth. If the operator
-- posts a status from their phone directly, it won't appear here.

create table if not exists evolution_status_posts (
  id                          uuid primary key default gen_random_uuid(),
  business_phone_number_id    text not null references business_numbers(phone_number_id) on delete cascade,
  posted_by_user_id           uuid references auth.users(id) on delete set null,
  posted_by_email             text,
  type                        text not null check (type in ('text','image','video','audio')),
  content_preview             text,
  media_url                   text,
  background_color            text,
  wa_message_id               text,
  posted_at                   timestamptz not null default now(),
  expires_at                  timestamptz not null default (now() + interval '24 hours')
);

create index if not exists evolution_status_posts_bpid_ts_idx
  on evolution_status_posts (business_phone_number_id, posted_at desc);
