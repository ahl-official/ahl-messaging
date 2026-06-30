-- 0103_date_align_off_by_default.sql
--
-- Date Align (can_align_dates) is now OFF for everyone by default. Access is
-- granted explicitly PER MEMBER from Settings → Members → the "Date Align /
-- send booking link" toggle. Owners always keep it (code bypass in
-- ownerPermissions()), so the owner can still align dates + grant access.
--
-- Run once in the Supabase SQL editor. Idempotent.

-- 1. Every role's default → OFF (covers teammate, admin and any other role).
UPDATE public.role_permissions SET can_align_dates = false;

-- 2. Clear any per-member override that currently GRANTS it, so nobody is
--    left enabled. NULL = inherit the role default (now false). Re-enable the
--    chosen team's members explicitly (UI toggle, or a follow-up UPDATE).
UPDATE public.team_member_permissions
   SET can_align_dates = NULL
 WHERE can_align_dates IS TRUE;
