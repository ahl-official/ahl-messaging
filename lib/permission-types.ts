// Pure types + constants for permissions. Safe to import from client
// components. Server-only helpers live in `lib/permissions.ts`.

import type { Role } from "@/lib/team-types";

// Sidebar panel keys — kept in sync with components/LeftNav.tsx items.
// Keep this in sync with the items array in components/LeftNav.tsx —
// only ship panel keys for surfaces that are actually visible in the
// sidebar. Listing orphaned routes (widget / commerce / generic
// integrations index) here made the permissions panel show toggles
// the operator couldn't act on, which kept causing confusion.
export const PANEL_KEYS = [
  "inbox",
  "home",
  "campaigns",
  "contacts",
  "templates",
  "quick_replies",
  "automation",
  "calls",
  "lsq",
  "reports",
  "tasks",
  "lead_distribution",
  "telephony",
  "settings",
] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];

export const PANEL_LABEL: Record<PanelKey, string> = {
  inbox: "Inbox",
  home: "Home",
  campaigns: "Campaigns",
  contacts: "Contacts",
  templates: "Templates",
  quick_replies: "Quick Replies",
  automation: "Automation",
  calls: "Call history",
  lsq: "CRM",
  reports: "Reports",
  tasks: "Tasks",
  lead_distribution: "Lead Distribution",
  telephony: "Telephony",
  settings: "Settings",
};

// Sub-tabs inside the Settings area. Granular per-role / per-member
// gates so an admin can hide e.g. "Portfolios" / "Data" / "API" from
// a teammate even after letting them into Settings.
export const SETTINGS_TAB_KEYS = [
  "team",
  "teams",
  "labels",
  "permissions",
  "numbers",
  "capabilities",
  "targets",
  "notice",
  "portfolios",
  "api",
  "data",
  "ai",
  "payments",
  "calling",
  "interakt",
  "ads",
  "embed",
] as const;
export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number];

export const SETTINGS_TAB_LABEL: Record<SettingsTabKey, string> = {
  team: "Team",
  teams: "Teams",
  labels: "Labels",
  permissions: "Permissions",
  numbers: "Numbers",
  capabilities: "Capabilities",
  targets: "Targets",
  notice: "Notice",
  portfolios: "Portfolios",
  api: "API",
  data: "Data",
  ai: "AI",
  payments: "Payments",
  calling: "Calling",
  interakt: "Interakt",
  ads: "Ads / Marketing",
  embed: "Embed",
};

// Capability flags — match column names in role_permissions /
// team_member_permissions exactly.
export const CAPABILITY_KEYS = [
  "can_send_messages",
  "can_use_magic_message",
  "can_export_data",
  "can_assign_contacts",
  "can_manage_templates",
  "can_manage_automation",
  "can_make_calls",
  "can_align_dates",
  "can_view_call_history",
  "can_manage_team",
  "can_manage_numbers",
  "can_delete_labels",
  // When true, the inbox only shows contacts whose CRM lead owner
  // matches this user's email. Used to give junior agents a focused
  // queue without granting them full inbox access.
  "lsq_assigned_visibility_only",
  // When true, dashboard contact assignment also pushes the new owner
  // to LSQ (matching the assignee's email to an LSQ user). Without
  // this, dashboard + LSQ owner can drift.
  "can_sync_lsq_owner",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  can_send_messages: "Send messages",
  can_use_magic_message: "Use Magic Message AI",
  can_export_data: "Export data (CSV)",
  can_assign_contacts: "Assign / reassign contacts",
  can_manage_templates: "Create & edit templates",
  can_manage_automation: "Manage automations",
  can_make_calls: "Make WhatsApp calls",
  can_align_dates: "Date Align / send booking link",
  can_view_call_history: "View call history",
  can_manage_team: "Manage team members",
  can_manage_numbers: "Manage WhatsApp numbers",
  can_delete_labels: "Delete contact labels",
  lsq_assigned_visibility_only: "Limit to LSQ-assigned chats (OFF = all chats)",
  can_sync_lsq_owner: "Sync assignment to LSQ owner",
};

export const CAPABILITY_DESCRIPTION: Record<CapabilityKey, string> = {
  can_send_messages: "Reply in any inbox conversation.",
  can_use_magic_message: "Generate AI replies in the composer.",
  can_export_data: "Download contact / message exports.",
  can_assign_contacts: "Pick up or reassign chats to teammates.",
  can_manage_templates: "Create, edit, and submit WhatsApp templates.",
  can_manage_automation: "Edit auto-reply / drip / image-trigger flows.",
  can_make_calls: "Initiate outbound WhatsApp calls.",
  can_align_dates:
    "Open Date Align in the composer — pick a client's date or send a self-booking link.",
  can_view_call_history: "See the full call log on /calls.",
  can_manage_team: "Invite, deactivate, change roles.",
  can_manage_numbers: "Connect / rename / activate WhatsApp numbers.",
  can_delete_labels:
    "Delete a workspace label (removes it from every contact too). Anyone can create + rename.",
  lsq_assigned_visibility_only:
    "ON = user sees only chats whose CRM lead owner is their email (focused queue). OFF = sees ALL chats on their allowed numbers.",
  can_sync_lsq_owner:
    "When this user reassigns a chat, also push the new owner to LSQ so the lead owner there stays in sync.",
};

// Logical grouping for the capability list so the Permissions panel
// can render bucketed sections (Messaging / Inbox / Content / Admin /
// LSQ) instead of a flat 13-item grid that was hard to scan.
export interface CapabilityGroup {
  key: string;
  label: string;
  description: string;
  keys: CapabilityKey[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    key: "messaging",
    label: "Messaging & calling",
    description: "What this user can SEND from the inbox.",
    keys: ["can_send_messages", "can_use_magic_message", "can_make_calls", "can_align_dates"],
  },
  {
    key: "inbox",
    label: "Inbox management",
    description: "How they organise chats day-to-day.",
    keys: ["lsq_assigned_visibility_only", "can_assign_contacts", "can_view_call_history", "can_delete_labels"],
  },
  {
    key: "content",
    label: "Content & setup",
    description: "Edit templates, automations, numbers, exports.",
    keys: [
      "can_manage_templates",
      "can_manage_automation",
      "can_manage_numbers",
      "can_export_data",
    ],
  },
  {
    key: "admin",
    label: "Admin",
    description: "Team + role gates. Use carefully.",
    keys: ["can_manage_team"],
  },
  {
    key: "lsq",
    label: "CRM",
    description: "How chats relate to CRM leads.",
    keys: ["can_sync_lsq_owner"],
  },
];

// Shape of a row in role_permissions (from DB).
export interface RolePermissions {
  role: Role;
  allowed_number_ids: string[] | null; // null = all numbers
  allowed_panels: PanelKey[] | null;   // null = all panels
  allowed_settings_tabs: SettingsTabKey[] | null; // null = all settings tabs
  mask_phone_numbers: boolean;
  mask_emails: boolean;
  mask_source_subsource: boolean;
  can_send_messages: boolean;
  can_use_magic_message: boolean;
  can_export_data: boolean;
  can_assign_contacts: boolean;
  can_manage_templates: boolean;
  can_manage_automation: boolean;
  can_make_calls: boolean;
  can_view_call_history: boolean;
  can_manage_team: boolean;
  can_manage_numbers: boolean;
  can_delete_labels: boolean;
  lsq_assigned_visibility_only: boolean;
  can_sync_lsq_owner: boolean;
  can_align_dates: boolean;
}

// Override row — every field is nullable, NULL = inherit role default.
export interface MemberPermissionOverride {
  member_id: string;
  allowed_number_ids: string[] | null;
  allowed_panels: PanelKey[] | null;
  allowed_settings_tabs: SettingsTabKey[] | null;
  mask_phone_numbers: boolean | null;
  mask_emails: boolean | null;
  mask_source_subsource: boolean | null;
  can_send_messages: boolean | null;
  can_use_magic_message: boolean | null;
  can_export_data: boolean | null;
  can_assign_contacts: boolean | null;
  can_manage_templates: boolean | null;
  can_manage_automation: boolean | null;
  can_make_calls: boolean | null;
  can_view_call_history: boolean | null;
  can_manage_team: boolean | null;
  can_manage_numbers: boolean | null;
  can_delete_labels: boolean | null;
  lsq_assigned_visibility_only: boolean | null;
  can_sync_lsq_owner: boolean | null;
  can_align_dates: boolean | null;
}

// Team-group override — same shape as MemberPermissionOverride but
// keyed by team_id. NULL field = "inherit from role". Sits between
// role default and member override in the resolution chain.
export interface TeamPermissionOverride {
  team_id: string;
  allowed_number_ids: string[] | null;
  allowed_panels: PanelKey[] | null;
  allowed_settings_tabs: SettingsTabKey[] | null;
  mask_phone_numbers: boolean | null;
  mask_emails: boolean | null;
  mask_source_subsource: boolean | null;
  can_send_messages: boolean | null;
  can_use_magic_message: boolean | null;
  can_export_data: boolean | null;
  can_assign_contacts: boolean | null;
  can_manage_templates: boolean | null;
  can_manage_automation: boolean | null;
  can_make_calls: boolean | null;
  can_view_call_history: boolean | null;
  can_manage_team: boolean | null;
  can_manage_numbers: boolean | null;
  can_delete_labels: boolean | null;
  lsq_assigned_visibility_only: boolean | null;
  can_sync_lsq_owner: boolean | null;
  can_align_dates: boolean | null;
}

/** Layer a team override onto a role default. NULL team fields fall
 *  through to the role default. The returned shape is still a
 *  RolePermissions row (i.e. fully resolved, no NULLs), suitable as
 *  the "baseline" the MemberAccessSheet shows when it labels fields
 *  as "inherited". */
export function applyTeamOverride(
  base: RolePermissions,
  override: TeamPermissionOverride | null,
): RolePermissions {
  if (!override) return base;
  const pick = <T>(o: T | null | undefined, b: T): T =>
    o === null || o === undefined ? b : o;
  return {
    role: base.role,
    allowed_number_ids: pick(override.allowed_number_ids, base.allowed_number_ids),
    allowed_panels: (pick(
      override.allowed_panels as PanelKey[] | null | undefined,
      base.allowed_panels as PanelKey[] | null,
    ) as PanelKey[] | null),
    allowed_settings_tabs: (pick(
      override.allowed_settings_tabs as SettingsTabKey[] | null | undefined,
      base.allowed_settings_tabs as SettingsTabKey[] | null,
    ) as SettingsTabKey[] | null),
    mask_phone_numbers: pick(override.mask_phone_numbers, base.mask_phone_numbers),
    mask_emails: pick(override.mask_emails, base.mask_emails),
    mask_source_subsource: pick(override.mask_source_subsource, base.mask_source_subsource),
    can_send_messages: pick(override.can_send_messages, base.can_send_messages),
    can_use_magic_message: pick(override.can_use_magic_message, base.can_use_magic_message),
    can_export_data: pick(override.can_export_data, base.can_export_data),
    can_assign_contacts: pick(override.can_assign_contacts, base.can_assign_contacts),
    can_manage_templates: pick(override.can_manage_templates, base.can_manage_templates),
    can_manage_automation: pick(override.can_manage_automation, base.can_manage_automation),
    can_make_calls: pick(override.can_make_calls, base.can_make_calls),
    can_view_call_history: pick(override.can_view_call_history, base.can_view_call_history),
    can_manage_team: pick(override.can_manage_team, base.can_manage_team),
    can_manage_numbers: pick(override.can_manage_numbers, base.can_manage_numbers),
    can_delete_labels: pick(override.can_delete_labels, base.can_delete_labels),
    lsq_assigned_visibility_only: pick(
      override.lsq_assigned_visibility_only,
      base.lsq_assigned_visibility_only,
    ),
    can_sync_lsq_owner: pick(
      override.can_sync_lsq_owner,
      base.can_sync_lsq_owner,
    ),
    can_align_dates: pick(override.can_align_dates, base.can_align_dates),
  };
}

// Per-number inbox visibility mode. Only stored for numbers that
// differ from the global lsq_assigned_visibility_only default — empty
// map = "fall back to the global flag for every number".
export type NumberAccessMode = "full" | "assigned_only";
export type NumberAccessModes = Record<string, NumberAccessMode>;

// Effective (resolved) permissions for one member — never null.
export interface EffectivePermissions {
  role: Role;
  allowed_number_ids: string[] | null; // null = unrestricted
  allowed_panels: PanelKey[] | null;   // null = unrestricted
  allowed_settings_tabs: SettingsTabKey[] | null; // null = unrestricted
  mask_phone_numbers: boolean;
  mask_emails: boolean;
  mask_source_subsource: boolean;
  can_send_messages: boolean;
  can_use_magic_message: boolean;
  can_export_data: boolean;
  can_assign_contacts: boolean;
  can_manage_templates: boolean;
  can_manage_automation: boolean;
  can_make_calls: boolean;
  can_view_call_history: boolean;
  can_manage_team: boolean;
  can_manage_numbers: boolean;
  can_delete_labels: boolean;
  lsq_assigned_visibility_only: boolean;
  can_sync_lsq_owner: boolean;
  /** Date Align — pick a client's date / send a self-booking link. */
  can_align_dates: boolean;
  /** Per-bpid override map. `numberAccessMode(perms, bpid)` resolves a
   *  specific number's mode honouring this map first, then the global
   *  lsq_assigned_visibility_only flag, then defaulting to 'full'. */
  number_access_modes: NumberAccessModes;
}

// Owners always get full unrestricted access — they shouldn't be lockable.
export function ownerPermissions(): EffectivePermissions {
  return {
    role: "owner",
    allowed_number_ids: null,
    allowed_panels: null,
    allowed_settings_tabs: null,
    mask_phone_numbers: false,
    mask_emails: false,
    mask_source_subsource: false,
    can_send_messages: true,
    can_use_magic_message: true,
    can_export_data: true,
    can_assign_contacts: true,
    can_manage_templates: true,
    can_manage_automation: true,
    can_make_calls: true,
    can_view_call_history: true,
    can_manage_team: true,
    can_manage_numbers: true,
    can_delete_labels: true,
    // Owners see all chats (no CRM filter) and DO sync to LSQ when
    // they reassign.
    lsq_assigned_visibility_only: false,
    can_sync_lsq_owner: true,
    can_align_dates: true,
    number_access_modes: {},
  };
}

/**
 * Resolve effective permissions for a member.
 * - Owner: always full access.
 * - Else: every field falls back to role default when override is NULL.
 *   Array fields (allowed_number_ids / allowed_panels): NULL on either
 *   side means "unrestricted" — override wins when present (even empty
 *   array, which means "explicitly nothing").
 */
export function resolveEffective(
  role: Role,
  roleDefaults: RolePermissions,
  override: MemberPermissionOverride | null,
  numberAccessModes: NumberAccessModes = {},
): EffectivePermissions {
  if (role === "owner") return ownerPermissions();

  const ov = override;
  const pickArr = (
    o: string[] | null | undefined,
    r: string[] | null | undefined,
  ): string[] | null =>
    o === undefined || o === null ? (r ?? null) : o;

  const pickBool = (o: boolean | null | undefined, r: boolean): boolean =>
    o === null || o === undefined ? r : o;

  return {
    role,
    allowed_number_ids: pickArr(ov?.allowed_number_ids, roleDefaults.allowed_number_ids),
    allowed_panels: (pickArr(ov?.allowed_panels as string[] | null | undefined, roleDefaults.allowed_panels) as PanelKey[] | null),
    allowed_settings_tabs: (pickArr(
      ov?.allowed_settings_tabs as string[] | null | undefined,
      roleDefaults.allowed_settings_tabs as string[] | null | undefined,
    ) as SettingsTabKey[] | null),
    mask_phone_numbers: pickBool(ov?.mask_phone_numbers, roleDefaults.mask_phone_numbers),
    mask_emails: pickBool(ov?.mask_emails, roleDefaults.mask_emails),
    mask_source_subsource: pickBool(ov?.mask_source_subsource, roleDefaults.mask_source_subsource),
    can_send_messages: pickBool(ov?.can_send_messages, roleDefaults.can_send_messages),
    can_use_magic_message: pickBool(ov?.can_use_magic_message, roleDefaults.can_use_magic_message),
    can_export_data: pickBool(ov?.can_export_data, roleDefaults.can_export_data),
    can_assign_contacts: pickBool(ov?.can_assign_contacts, roleDefaults.can_assign_contacts),
    can_manage_templates: pickBool(ov?.can_manage_templates, roleDefaults.can_manage_templates),
    can_manage_automation: pickBool(ov?.can_manage_automation, roleDefaults.can_manage_automation),
    can_make_calls: pickBool(ov?.can_make_calls, roleDefaults.can_make_calls),
    can_view_call_history: pickBool(ov?.can_view_call_history, roleDefaults.can_view_call_history),
    can_manage_team: pickBool(ov?.can_manage_team, roleDefaults.can_manage_team),
    can_manage_numbers: pickBool(ov?.can_manage_numbers, roleDefaults.can_manage_numbers),
    can_delete_labels: pickBool(ov?.can_delete_labels, roleDefaults.can_delete_labels),
    lsq_assigned_visibility_only: pickBool(
      ov?.lsq_assigned_visibility_only,
      roleDefaults.lsq_assigned_visibility_only,
    ),
    can_sync_lsq_owner: pickBool(
      ov?.can_sync_lsq_owner,
      roleDefaults.can_sync_lsq_owner,
    ),
    can_align_dates: pickBool(ov?.can_align_dates, roleDefaults.can_align_dates),
    number_access_modes: numberAccessModes,
  };
}

/** Resolve a single number's inbox visibility for this member.
 *  Per-bpid row wins; otherwise the global lsq_assigned_visibility_only
 *  flag decides; otherwise full. */
export function numberAccessMode(
  perms: EffectivePermissions,
  numberId: string,
): NumberAccessMode {
  const explicit = perms.number_access_modes[numberId];
  if (explicit) return explicit;
  return perms.lsq_assigned_visibility_only ? "assigned_only" : "full";
}

export function panelAllowed(perms: EffectivePermissions, panel: PanelKey): boolean {
  if (perms.allowed_panels === null) return true;
  return perms.allowed_panels.includes(panel);
}

export function numberAllowed(perms: EffectivePermissions, numberId: string): boolean {
  if (perms.allowed_number_ids === null) return true;
  return perms.allowed_number_ids.includes(numberId);
}

export function settingsTabAllowed(
  perms: EffectivePermissions,
  tab: SettingsTabKey,
): boolean {
  if (perms.allowed_settings_tabs === null) return true;
  return perms.allowed_settings_tabs.includes(tab);
}
