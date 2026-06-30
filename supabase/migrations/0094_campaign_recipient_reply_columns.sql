-- The campaign worker / webhook write button_clicked, button_clicked_at and
-- reply_text onto campaign_recipients (for CTR + reply-text display), but the
-- columns were never created — so the "mark replied" update failed silently
-- and Replied count + CTR stayed at 0. Add them.
alter table public.campaign_recipients
  add column if not exists button_clicked     text,
  add column if not exists button_clicked_at  timestamptz,
  add column if not exists reply_text         text;
