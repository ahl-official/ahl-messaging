// Pure types + constants for the team_members table. Safe to import from
// client components — contains no server-only code (no next/headers, no
// Supabase server client). Server-only helpers live in `lib/team.ts`.

export type Role = "owner" | "superadmin" | "admin" | "teammate";

export const ROLES: Role[] = ["owner", "superadmin", "admin", "teammate"];

// Higher number = more powerful.
export const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  superadmin: 3,
  admin: 2,
  teammate: 1,
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  superadmin: "Super admin",
  admin: "Admin",
  teammate: "Teammate",
};

export interface TeamMember {
  id: string;
  user_id: string | null;
  email: string;
  full_name: string | null;
  /** Required for sending Magic Messages (renders on the card footer). */
  first_name: string | null;
  /** Required for sending Magic Messages (renders on the card footer). */
  last_name: string | null;
  role: Role;
  is_active: boolean;
  /** True for self-signups that haven't been approved by the owner yet.
   *  Login is blocked while this is true. Pre-invited members never
   *  hit this state. */
  pending_approval?: boolean;
  invited_by: string | null;
  last_active_at: string | null;
  /** Optional team assignment (HT Done / Welcome / Sales / Date Align /
   *  custom). NULL = unassigned. */
  team_id: string | null;
  /** Team Lead: can view the agent-productivity report for their own team
   *  (team_id) and set those members' KRA targets. Set by owner/admin. */
  is_team_lead?: boolean;
  /** Monitor-only: this user just watches leads, doesn't work them. Leads
   *  owned by a monitor count as "unassigned/available" in the inbox so a
   *  full-access agent can pick them up. Set from Settings → Team. */
  is_monitor?: boolean;
  /** Per-user inbox visibility — phone_number_ids the operator has
   *  toggled off in the UserMenu. Empty array = show all numbers they
   *  have access to. Migrated from the old global
   *  business_numbers.is_active toggle which leaked across users. */
  hidden_number_ids: string[];
  /** Ozonetel CloudAgent identity for click-to-call. agent_id is the
   *  operator's CloudAgent agentID; phone is the number / WebRTC SIP id
   *  their calls land on. NULL until wired in Settings → Calling. */
  ozonetel_agent_id?: string | null;
  ozonetel_phone?: string | null;
  /** Tata Tele (Smartflo) agent the click-to-call rings first. */
  tatatele_agent_number?: string | null;
  created_at: string;
  updated_at: string;
}

/** Composes the user-facing display name from first/last. Returns null when
 *  both are missing — callers can treat that as "profile incomplete". */
export function memberDisplayName(
  m: Pick<TeamMember, "first_name" | "last_name" | "full_name" | "email"> | null,
): string | null {
  if (!m) return null;
  const first = m.first_name?.trim();
  const last = m.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (m.full_name?.trim()) return m.full_name.trim();
  return null;
}

export function isAtLeast(role: Role | null | undefined, threshold: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[threshold];
}

export function canManageRole(actor: Role, target: Role): boolean {
  if (target === "owner" || actor === "owner") return actor === "owner";
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return ["superadmin", "admin", "teammate", "owner"];
  if (actor === "superadmin") return ["admin", "teammate"];
  if (actor === "admin") return ["teammate"];
  return [];
}
