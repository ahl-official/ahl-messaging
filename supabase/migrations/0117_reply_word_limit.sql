-- Per-number reply length cap (words). The bot keeps replies to this many
-- words; if a generated reply runs longer it's compressed to one short line.
-- 0 = no limit (don't compress). Default 15 to match the anti-spam policy.

alter table automation_configs
  add column if not exists reply_word_limit integer not null default 15;
