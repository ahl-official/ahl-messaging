-- Multi-button quick replies. A `buttons` array replaces the single
-- button_text/button_url pair. Each button: { type: 'quick_reply' | 'url',
-- text, url? }. WhatsApp free-form only supports reply buttons (max 3) OR one
-- URL button — Phone / Copy-Code buttons are template-only, so not stored here.
-- button_text/button_url stay for back-compat reads of older rows.

alter table public.quick_replies
  add column if not exists buttons jsonb not null default '[]'::jsonb;
