-- Message edit, delete, and quoted-reply support.
--
-- reply_to_wa_message_id  — the wamid this message quotes. Populated by
--   /api/send-message (outbound) and the inbound webhook (when the
--   customer swipe-replies).
-- reply_to_content        — cached snippet of the quoted message body so
--   the bubble can render the quote header without a per-row lookup.
-- reply_to_direction      — 'inbound' | 'outbound' — drives styling of
--   the quote header (sender attribution).
-- edited_at               — non-null when the operator edited the text
--   via Meta's edit API. Drives the "(edited)" footer + greys out the
--   inline-edit button after the 15-minute window.
-- deleted_at              — non-null when "delete for everyone" was
--   called via Meta. The row stays so the chat thread keeps its order;
--   UI renders a "🗑 This message was deleted" placeholder.
-- original_content        — pre-edit text, kept for audit. NULL when
--   the row was never edited.

alter table public.messages
  add column if not exists reply_to_wa_message_id text;

alter table public.messages
  add column if not exists reply_to_content text;

alter table public.messages
  add column if not exists reply_to_direction text
    check (reply_to_direction in ('inbound', 'outbound'));

alter table public.messages
  add column if not exists edited_at timestamptz;

alter table public.messages
  add column if not exists deleted_at timestamptz;

alter table public.messages
  add column if not exists original_content text;

-- Index the quoted-reply pointer — the dashboard chat loader joins on
-- this when reconciling thread context.
create index if not exists messages_reply_to_wamid_idx
  on public.messages (reply_to_wa_message_id)
  where reply_to_wa_message_id is not null;
