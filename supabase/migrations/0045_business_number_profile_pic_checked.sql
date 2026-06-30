-- Track the last time we asked Meta / Evolution for a profile pic on
-- this number. The background cron uses this to round-robin across
-- numbers that haven't been checked in a while, rather than re-trying
-- the same null-pic numbers every 5 minutes forever.
--
-- NULL means "never checked" — those go first.

alter table business_numbers
  add column if not exists profile_pic_checked_at timestamptz;

create index if not exists business_numbers_profile_pic_checked_idx
  on business_numbers (profile_pic_checked_at nulls first)
  where profile_pic_url is null;
