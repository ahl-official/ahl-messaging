-- "Monitor" team members.
--
-- Some users only WATCH leads (don't reply). Leads sit parked under a
-- monitor's LSQ ownership and get reassigned to a real working agent
-- overnight. While a lead is owned by a monitor it should count as
-- "unassigned / available" in the inbox so a full-access agent can pick
-- it up — see the Unassigned filter in app/api/contacts.
--
-- Marked from Settings → Team (per member). Default false = normal
-- working agent.

alter table public.team_members
  add column if not exists is_monitor boolean not null default false;

-- The Unassigned filter looks up monitor emails on every fetch; a small
-- partial index keeps that lookup trivial.
create index if not exists team_members_is_monitor_idx
  on public.team_members (is_monitor)
  where is_monitor = true;
