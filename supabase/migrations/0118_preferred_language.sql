-- Patient's preferred reply language. The bot greets, asks the patient which
-- language they prefer, stores the choice here (and pushes it to LSQ's
-- mx_Religion field), then replies in that language on every turn.
-- NULL = not chosen yet → bot asks in its greeting and matches their language
-- meanwhile.

alter table contacts
  add column if not exists preferred_language text;
