-- Off-topic / personal-intent guard for the AI bot.
--
-- The bot only handles hair-loss / hair-transplant topics. When a patient
-- repeatedly pushes personal / friendship / romance / casual chat, the bot
-- issues 3 escalating warnings and then BLOCKS itself for that contact:
-- it stops replying entirely (a human can still chat manually). The block
-- surfaces in the chat composer as "Chat blocked due to app guidelines".
--
--   offtopic_strikes  — count of consecutive off-topic patient messages
--   bot_blocked_at    — when the bot was auto-blocked (NULL = not blocked)
--   bot_blocked_reason— why ("off_topic_guidelines")

alter table contacts
  add column if not exists offtopic_strikes integer not null default 0,
  add column if not exists bot_blocked_at timestamptz,
  add column if not exists bot_blocked_reason text;
