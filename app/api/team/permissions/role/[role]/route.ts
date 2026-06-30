// PATCH /api/team/permissions/role/[role]
// Update role-level default permissions. Owner / superadmin only.
// Body: partial RolePermissions — any subset of editable fields.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast, type Role } from "@/lib/team-types";
import {
  CAPABILITY_KEYS,
  PANEL_KEYS,
  SETTINGS_TAB_KEYS,
  type PanelKey,
  type SettingsTabKey,
} from "@/lib/permission-types";

export const runtime = "nodejs";

const VALID_ROLES: Role[] = ["owner", "superadmin", "admin", "teammate"];

interface PatchBody {
  allowed_number_ids?: string[] | null;
  allowed_panels?: PanelKey[] | null;
  allowed_settings_tabs?: SettingsTabKey[] | null;
  mask_phone_numbers?: boolean;
  mask_emails?: boolean;
  mask_source_subsource?: boolean;
  can_send_messages?: boolean;
  can_use_magic_message?: boolean;
  can_export_data?: boolean;
  can_assign_contacts?: boolean;
  can_manage_templates?: boolean;
  can_manage_automation?: boolean;
  can_make_calls?: boolean;
  can_view_call_history?: boolean;
  can_manage_team?: boolean;
  can_manage_numbers?: boolean;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "superadmin")) {
    return NextResponse.json({ error: "Super admin or owner only" }, { status: 403 });
  }

  const { role } = await params;
  if (!VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Owner row is locked — owners always have full access. Disallow edits to
  // prevent footguns.
  if (role === "owner") {
    return NextResponse.json(
      { error: "Owner permissions are locked to full access." },
      { status: 400 },
    );
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const update = sanitize(body);
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("role_permissions")
    .update(update)
    .eq("role", role)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, role_permissions: data });
}

function sanitize(body: PatchBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if ("allowed_number_ids" in body) {
    const v = body.allowed_number_ids;
    if (v === null) out.allowed_number_ids = null;
    else if (Array.isArray(v)) out.allowed_number_ids = v.map(String);
  }
  if ("allowed_panels" in body) {
    const v = body.allowed_panels;
    if (v === null) out.allowed_panels = null;
    else if (Array.isArray(v)) {
      out.allowed_panels = v.filter((p): p is PanelKey =>
        (PANEL_KEYS as readonly string[]).includes(p),
      );
    }
  }
  if ("allowed_settings_tabs" in body) {
    const v = body.allowed_settings_tabs;
    if (v === null) out.allowed_settings_tabs = null;
    else if (Array.isArray(v)) {
      out.allowed_settings_tabs = v.filter((t): t is SettingsTabKey =>
        (SETTINGS_TAB_KEYS as readonly string[]).includes(t),
      );
    }
  }
  if (typeof body.mask_phone_numbers === "boolean") out.mask_phone_numbers = body.mask_phone_numbers;
  if (typeof body.mask_emails === "boolean") out.mask_emails = body.mask_emails;
  if (typeof body.mask_source_subsource === "boolean") out.mask_source_subsource = body.mask_source_subsource;
  for (const key of CAPABILITY_KEYS) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}
