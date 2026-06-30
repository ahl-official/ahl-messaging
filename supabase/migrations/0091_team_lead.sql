-- 0091_team_lead.sql
-- Per-team reporting: mark 1-2 members of a team as Team Lead (TL). A TL can
-- view the agent-productivity report for their OWN team (team_members.team_id)
-- and set those members' KRA (agent_targets_member). Owner/admin keep
-- workspace-wide access. Toggled by owner/admin in Team settings.

alter table public.team_members
  add column if not exists is_team_lead boolean not null default false;

-- Quick lookup of a team's leads.
create index if not exists team_members_team_lead_idx
  on public.team_members (team_id)
  where is_team_lead = true;
