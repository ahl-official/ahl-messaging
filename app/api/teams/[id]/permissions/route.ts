// GET    /api/teams/[id]/permissions  → current override row (or null)
// PATCH  /api/teams/[id]/permissions  → set/clear fields
// DELETE /api/teams/[id]/permissions  → drop the row (inherit role)
//
// Caller must be admin+. Operates on the team_permissions table which
// sits between role defaults and per-member overrides in the
// resolution chain.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  CAPABILITY_KEYS,
  PANEL_KEYS,
  SETTINGS_TAB_KEYS,
  type PanelKey,
  type SettingsTabKey,
} from "@/lib/permission-types";

export const runtime = "nodejs";

interface PatchBody {
  // Each field: value | null (clear/inherit) | undefined (no change).
  allowed_number_ids?: string[] | null;
  allowed_panels?: PanelKey[] | null;
  allowed_settings_tabs?: SettingsTabKey[] | null;
  mask_phone_numbers?: boolean | null;
  mask_emails?: boolean | null;
  mask_source_subsource?: boolean | null;
  can_send_messages?: boolean | null;
  can_use_magic_message?: boolean | null;
  can_export_data?: boolean | null;
  can_assign_contacts?: boolean | null;
  can_manage_templates?: boolean | null;
  can_manage_automation?: boolean | null;
  can_make_calls?: boolean | null;
  can_view_call_history?: boolean | null;
  can_manage_team?: boolean | null;
  can_manage_numbers?: boolean | null;
  can_delete_labels?: boolean | null;
  lsq_assigned_visibility_only?: boolean | null;
  can_sync_lsq_owner?: boolean | null;
}

async function guard(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const me = await getCurrentMember();
  if (!me)
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAtLeast(me.role, "admin"))
    return { ok: false, res: NextResponse.json({ error: "Admin or above" }, { status: 403 }) };
  return { ok: true };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await guard();
  if (!g.ok) return g.res;
  const { id } = await params;
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_permissions")
    .select("*")
    .eq("team_id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ override: data ?? null });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await guard();
  if (!g.ok) return g.res;
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const update = sanitize(body);
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_permissions")
    .upsert(
      { team_id: id, ...update, updated_at: new Date().toISOString() },
      { onConflict: "team_id" },
    )
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, override: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await guard();
  if (!g.ok) return g.res;
  const { id } = await params;
  const admin = createServiceRoleClient();
  const { error } = await admin.from("team_permissions").delete().eq("team_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
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

  const boolKeys = ["mask_phone_numbers", "mask_emails", "mask_source_subsource", ...CAPABILITY_KEYS] as const;
  for (const key of boolKeys) {
    if (key in body) {
      const v = (body as Record<string, unknown>)[key];
      if (v === null) out[key] = null;
      else if (typeof v === "boolean") out[key] = v;
    }
  }
  return out;
}
