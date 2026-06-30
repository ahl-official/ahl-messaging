// Server-side permission helpers. Reads role_permissions +
// team_member_permissions and resolves effective permissions for the
// current member. Client components should consume these via the
// PermissionsContext provider, not call this directly.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import type { Role, TeamMember } from "@/lib/team-types";
import {
  applyTeamOverride,
  ownerPermissions,
  resolveEffective,
  type EffectivePermissions,
  type MemberPermissionOverride,
  type NumberAccessMode,
  type NumberAccessModes,
  type RolePermissions,
  type SettingsTabKey,
  type TeamPermissionOverride,
} from "@/lib/permission-types";

export type { EffectivePermissions, RolePermissions, MemberPermissionOverride } from "@/lib/permission-types";

const ALL_ROLES: Role[] = ["owner", "superadmin", "admin", "teammate"];

// Hardcoded fallback used when the row is missing (pre-migration / fresh DB).
function fallbackRoleDefaults(role: Role): RolePermissions {
  return {
    role,
    allowed_number_ids: null,
    allowed_panels: null,
    allowed_settings_tabs: null,
    mask_phone_numbers: role === "teammate",
    mask_emails: role === "teammate",
    mask_source_subsource: role === "teammate",
    can_send_messages: true,
    can_use_magic_message: true,
    can_export_data: role !== "teammate",
    can_assign_contacts: role !== "teammate",
    can_manage_templates: role !== "teammate",
    can_manage_automation: role !== "teammate",
    can_make_calls: true,
    can_view_call_history: true,
    can_manage_team: role === "owner" || role === "superadmin" || role === "admin",
    can_manage_numbers: role === "owner" || role === "superadmin",
    can_delete_labels: role !== "teammate",
    lsq_assigned_visibility_only: false,
    can_sync_lsq_owner: role === "owner" || role === "superadmin",
    can_align_dates: role !== "teammate",
  };
}

export async function getAllRolePermissions(): Promise<Record<Role, RolePermissions>> {
  const admin = createServiceRoleClient();
  const { data } = await admin.from("role_permissions").select("*");
  const map: Record<Role, RolePermissions> = {
    owner: fallbackRoleDefaults("owner"),
    superadmin: fallbackRoleDefaults("superadmin"),
    admin: fallbackRoleDefaults("admin"),
    teammate: fallbackRoleDefaults("teammate"),
  };
  for (const row of (data ?? []) as RolePermissions[]) {
    if (ALL_ROLES.includes(row.role)) map[row.role] = row;
  }
  return map;
}

export async function getMemberOverride(memberId: string): Promise<MemberPermissionOverride | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("team_member_permissions")
    .select("*")
    .eq("member_id", memberId)
    .maybeSingle();
  return (data as MemberPermissionOverride | null) ?? null;
}

export async function getAllMemberOverrides(): Promise<Record<string, MemberPermissionOverride>> {
  const admin = createServiceRoleClient();
  const { data } = await admin.from("team_member_permissions").select("*");
  const map: Record<string, MemberPermissionOverride> = {};
  for (const row of (data ?? []) as MemberPermissionOverride[]) {
    map[row.member_id] = row;
  }
  return map;
}

/** Load the per-bpid visibility overrides for one member. Empty map
 *  when the migration hasn't run yet — caller falls back to the global
 *  `lsq_assigned_visibility_only` flag, so absence is safe (dashboard
 *  keeps working). Wrapped in try/catch + lowercase error scan in case
 *  Supabase returns the "relation does not exist" payload differently
 *  across versions. */
export async function getNumberAccessModesFor(
  memberId: string,
): Promise<NumberAccessModes> {
  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin
      .from("member_number_access")
      .select("business_phone_number_id, mode")
      .eq("member_id", memberId);
    if (error || !data) return {};
    const out: NumberAccessModes = {};
    for (const row of data as Array<{
      business_phone_number_id: string;
      mode: NumberAccessMode;
    }>) {
      out[row.business_phone_number_id] = row.mode;
    }
    return out;
  } catch {
    return {};
  }
}

/** Same as above but for every member at once. Used by the Permissions
 *  page to render each row's override badge. Same safe-fallback. */
export async function getAllNumberAccessModes(): Promise<
  Record<string, NumberAccessModes>
> {
  try {
    const admin = createServiceRoleClient();
    const { data } = await admin
      .from("member_number_access")
      .select("member_id, business_phone_number_id, mode");
    const out: Record<string, NumberAccessModes> = {};
    for (const row of (data ?? []) as Array<{
      member_id: string;
      business_phone_number_id: string;
      mode: NumberAccessMode;
    }>) {
      if (!out[row.member_id]) out[row.member_id] = {};
      out[row.member_id][row.business_phone_number_id] = row.mode;
    }
    return out;
  } catch {
    return {};
  }
}

/** Load one team's permission override row. Safe-fallback when the
 *  team_permissions migration hasn't been applied yet — returns null
 *  so the resolver falls through to the plain role defaults. */
export async function getTeamPermission(
  teamId: string,
): Promise<TeamPermissionOverride | null> {
  try {
    const admin = createServiceRoleClient();
    const { data } = await admin
      .from("team_permissions")
      .select("*")
      .eq("team_id", teamId)
      .maybeSingle();
    return (data as TeamPermissionOverride | null) ?? null;
  } catch {
    return null;
  }
}

/** Same as above for every team at once. Used by GET
 *  /api/team/permissions so the UI can render which teams have
 *  overrides. */
export async function getAllTeamPermissions(): Promise<
  Record<string, TeamPermissionOverride>
> {
  try {
    const admin = createServiceRoleClient();
    const { data } = await admin.from("team_permissions").select("*");
    const map: Record<string, TeamPermissionOverride> = {};
    for (const row of (data ?? []) as TeamPermissionOverride[]) {
      map[row.team_id] = row;
    }
    return map;
  } catch {
    return {};
  }
}

export async function getEffectivePermissionsFor(
  member: TeamMember,
): Promise<EffectivePermissions> {
  if (member.role === "owner") return ownerPermissions();
  // Permissions chain: role default → team override (if member is in
  // a team) → member override. Number access modes are stitched in
  // separately by the resolver.
  const [roleMap, teamOverride, memberOverride, modes] = await Promise.all([
    getAllRolePermissions(),
    member.team_id ? getTeamPermission(member.team_id) : Promise.resolve(null),
    getMemberOverride(member.id),
    getNumberAccessModesFor(member.id),
  ]);
  const baseline = applyTeamOverride(roleMap[member.role], teamOverride);
  return resolveEffective(member.role, baseline, memberOverride, modes);
}

export async function getCurrentEffectivePermissions(): Promise<{
  member: TeamMember;
  perms: EffectivePermissions;
} | null> {
  const member = await getCurrentMember();
  if (!member) return null;
  const perms = await getEffectivePermissionsFor(member);
  return { member, perms };
}

/**
 * Server-side guard for /settings/<tab> pages. Returns true when the
 * current user is allowed to view the given tab; false otherwise
 * (caller should redirect). Owner always returns true.
 */
export async function canViewSettingsTab(tab: SettingsTabKey): Promise<boolean> {
  const ctx = await getCurrentEffectivePermissions();
  if (!ctx) return false;
  if (ctx.member.role === "owner") return true;
  const list = ctx.perms.allowed_settings_tabs;
  if (list === null) return true;
  return list.includes(tab);
}

/**
 * Server-side guard for top-level dashboard pages. Matches the
 * panel-key the sidebar uses (see LeftNav), so a member can't reach a
 * page by direct URL if its sidebar entry would be hidden. Owner
 * bypasses the check.
 */
export async function canViewPanel(
  panel: import("./permission-types").PanelKey,
): Promise<boolean> {
  const ctx = await getCurrentEffectivePermissions();
  if (!ctx) return false;
  if (ctx.member.role === "owner") return true;
  const list = ctx.perms.allowed_panels;
  if (list === null) return true;
  return list.includes(panel);
}
