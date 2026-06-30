-- Per-number override for the Interakt magic-message UTILITY template.
-- When set, magic messages sent FROM this number use this approved template
-- name instead of the workspace default ("magic_message_llp"). Lets a single
-- Interakt number (e.g. Sahil Ayyan 73 → shahil_magic_message) carry its own
-- branded magic card without touching any other number.
alter table business_numbers
  add column if not exists magic_message_template text;

-- Sahil Ayyan 73 (Interakt) magic messages use its own branded utility template.
update business_numbers
  set magic_message_template = 'shahil_magic_message'
  where phone_number_id = 'interakt:918279405973';
