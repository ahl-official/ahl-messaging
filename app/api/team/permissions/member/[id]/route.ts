// PATCH  /api/team/permissions/member/[id]   — set/clear override fields
// DELETE /api/team/permissions/member/[id]   — remove override (inherit role)
// Caller must be admin+ AND able to manage the target's role.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { canManageRole, isAtLeast, type Role, type TeamMember } from "@/lib/team-types";
import {
  CAPABILITY_KEYS,
  PANEL_KEYS,
  SETTINGS_TAB_KEYS,
  type PanelKey,
  type SettingsTabKey,
} from "@/lib/permission-types";

export const runtime = "nodejs";

interface PatchBody {
  // Each field accepts: value | null (= clear/inherit) | undefined (no change).
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
  /** Per-number visibility overrides. Map of bpid → 'full' |
   *  'assigned_only'. Sending an empty object clears every override;
   *  omitting the field leaves the side table untouched. */
  number_access_modes?: Record<string, "full" | "assigned_only">;
}

async function loadTarget(id: string): Promise<TeamMember | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin.from("team_members").select("*").eq("id", id).maybeSingle();
  return (data as TeamMember | null) ?? null;
}

async function ensureCanEdit(targetId: string): Promise<
  | { ok: true; me: TeamMember; target: TeamMember }
  | { ok: false; res: NextResponse }
> {
  const me = await getCurrentMember();
  if (!me) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!isAtLeast(me.role, "admin")) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Admin or above only" }, { status: 403 }),
    };
  }
  const target = await loadTarget(targetId);
  if (!target) {
    return { ok: false, res: NextResponse.json({ error: "Member not found" }, { status: 404 }) };
  }
  if (target.role === "owner") {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Owner permissions are locked." },
        { status: 400 },
      ),
    };
  }
  if (!canManageRole(me.role as Role, target.role as Role)) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: `You can't edit a ${target.role}.` },
        { status: 403 },
      ),
    };
  }
  return { ok: true, me, target };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await ensureCanEdit(id);
  if (!guard.ok) return guard.res;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const update = sanitize(body);

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_member_permissions")
    .upsert({ member_id: id, ...update }, { onConflict: "member_id" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sync the per-number visibility side table when the caller sent it.
  // Snapshot-style replace — frontend doesn't compute deltas.
  // Wrapped in try/catch so the WHOLE request doesn't 500 when the
  // migration hasn't been run yet (table missing); the rest of the
  // override still saves.
  if (body.number_access_modes && typeof body.number_access_modes === "object") {
    try {
      const entries = Object.entries(body.number_access_modes).filter(
        ([, mode]) => mode === "full" || mode === "assigned_only",
      );
      await admin
        .from("member_number_access")
        .delete()
        .eq("member_id", id);
      if (entries.length > 0) {
        const rows = entries.map(([bpid, mode]) => ({
          member_id: id,
          business_phone_number_id: bpid,
          mode,
        }));
        await admin.from("member_number_access").insert(rows);
      }
    } catch (e) {
      console.warn(
        "[perms] number_access_modes sync skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({ ok: true, override: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await ensureCanEdit(id);
  if (!guard.ok) return guard.res;

  const admin = createServiceRoleClient();
  const { error } = await admin.from("team_member_permissions").delete().eq("member_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // "Reset to role" must also wipe per-number overrides — otherwise
  // the operator clears half the picture and gets confused.
  try {
    await admin.from("member_number_access").delete().eq("member_id", id);
  } catch {
    /* migration not run yet — fine, nothing to wipe */
  }
  return NextResponse.json({ ok: true });
}

function sanitize(body: PatchBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Arrays — null = clear (inherit), array = explicit value (even empty).
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

  // Booleans — null = clear (inherit), bool = explicit value.
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
