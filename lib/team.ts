// Server-only helpers for team_members. Client components must import types
// and pure helpers from `lib/team-types.ts` instead — that file has no
// next/headers dependency.

import {
  createServerClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import {
  ROLE_LABEL,
  isAtLeast,
  type Role,
  type TeamMember,
} from "@/lib/team-types";

// Re-export pure types so existing server-side imports of `lib/team` keep
// working without churn.
export {
  ROLES,
  ROLE_RANK,
  ROLE_LABEL,
  isAtLeast,
  canManageRole,
  assignableRoles,
} from "@/lib/team-types";
export type { Role, TeamMember } from "@/lib/team-types";

/**
 * Returns the team_members row for the currently signed-in auth user, or null
 * if there's no session, no row, or the row is inactive.
 */
export async function getCurrentMember(): Promise<TeamMember | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("team_members")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const member = data as TeamMember | null;
  if (!member || !member.is_active) return null;
  return member;
}

/**
 * Lower-cased emails of every active "monitor" member — users who only
 * watch leads and don't work them. The Unassigned inbox filter treats a
 * lead owned by one of these as available. Service-role read so it's
 * consistent regardless of the caller's RLS scope.
 */
export async function getMonitorEmails(): Promise<string[]> {
  try {
    const admin = createServiceRoleClient();
    const { data } = await admin
      .from("team_members")
      .select("email")
      .eq("is_monitor", true)
      .eq("is_active", true);
    return (data ?? [])
      .map((r) => (r.email as string | null)?.trim().toLowerCase())
      .filter((e): e is string => !!e);
  } catch {
    // Column missing (migration not run yet) etc. — fail safe to "no
    // monitors" so the inbox keeps working.
    return [];
  }
}

/**
 * Server-action / route guard. Returns the member if allowed, otherwise
 * `{ error, status }` callers can JSON-return.
 */
export async function requireRole(
  threshold: Role,
): Promise<{ member: TeamMember } | { error: string; status: 401 | 403 }> {
  const member = await getCurrentMember();
  if (!member) return { error: "You're not signed in.", status: 401 };
  if (!isAtLeast(member.role, threshold)) {
    return {
      error: `This action requires ${ROLE_LABEL[threshold]} or higher.`,
      status: 403,
    };
  }
  return { member };
}
