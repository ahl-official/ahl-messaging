-- The "assigned-only inbox" visibility filter matched contacts.lsq_owner_email
-- against the agent's (lower-cased) auth email with a case-SENSITIVE compare,
-- but lsq_owner_email was stored verbatim from LSQ's OwnerIdEmailAddress (often
-- mixed-case) — so agents saw zero chats on their assigned-only numbers.
--
-- Normalise existing data to lower(trim()). Going forward the writers also
-- normalise (see lib/lsq, lib/lsq-webhook, lib/lsq-owner-sync, the webhook and
-- backfill routes), and the read filter lower-cases the email.

update public.contacts
   set lsq_owner_email = lower(trim(lsq_owner_email))
 where lsq_owner_email is not null
   and lsq_owner_email <> lower(trim(lsq_owner_email));
