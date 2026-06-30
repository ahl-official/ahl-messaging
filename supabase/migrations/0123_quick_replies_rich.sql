-- Rich quick replies: optional media (image/video) + a single URL button, on
-- top of the existing text body. When set, the snippet is sent as a WhatsApp
-- interactive cta_url message (media header + body + button) instead of plain
-- text. All nullable — a quick reply stays text-only unless these are filled.

alter table public.quick_replies
  add column if not exists media_url   text,
  add column if not exists media_kind  text,   -- 'image' | 'video'
  add column if not exists button_text text,
  add column if not exists button_url  text;
