-- 0104_enable_date_align_for_team.sql
--
-- Grant Date Align (can_align_dates) to EVERY member of the "Date Align" team.
-- Run after 0103 (which turned it OFF for everyone). Idempotent — re-running
-- just keeps them enabled. Upsert so members without an override row get one.

INSERT INTO public.team_member_permissions (member_id, can_align_dates)
SELECT m.id, TRUE
  FROM public.team_members m
  JOIN public.teams t ON t.id = m.team_id
 WHERE lower(t.name) = 'date align'
ON CONFLICT (member_id)
DO UPDATE SET can_align_dates = TRUE, updated_at = now();

-- Verify — these members now have Date Align access:
SELECT m.id, m.email, m.full_name, m.is_active
  FROM public.team_members m
  JOIN public.teams t ON t.id = m.team_id
 WHERE lower(t.name) = 'date align'
 ORDER BY m.email;
