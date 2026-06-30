// GET  /api/targets/role           — list all 4 role rows
// PUT  /api/targets/role           — upsert a single role row
//
// Admin+ only. Owner-facing UI for setting KRA/KPA baselines per role.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { TARGET_FIELDS, ROLE_TARGETS_FALLBACK, type AgentTargets } from "@/lib/agent-targets";
import type { Role } from "@/lib/team-types";

export const runtime = "nodejs";

const VALID_ROLES = ["owner", "superadmin", "admin", "teammate"] as const;

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const admin = createServiceRoleClient();
  const { data } = await admin.from("agent_targets_role").select("*");
  // Synthesise rows for any role missing in the table so the UI has
  // every entry to render (operator can edit + save → upsert creates).
  const byRole = new Map<string, AgentTargets & { role: string }>();
  for (const row of (data ?? []) as Array<AgentTargets & { role: string }>) {
    byRole.set(row.role, row);
  }
  const rows = VALID_ROLES.map((role) => {
    const r = byRole.get(role);
    if (r) return r;
    return { role, ...ROLE_TARGETS_FALLBACK[role as Role] };
  });
  return NextResponse.json({ rows });
}

interface PutBody {
  role?: Role;
  magic_messages_per_day?: number;
  calls_per_day?: number;
  text_replies_per_day?: number;
  template_sends_per_day?: number;
  max_idle_hours_per_day?: number;
  min_login_hours_per_day?: number;
}

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner-only — role-level baselines affect everyone.
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.role || !(VALID_ROLES as readonly string[]).includes(body.role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  const row: Record<string, unknown> = { role: body.role };
  for (const f of TARGET_FIELDS) {
    const v = (body as Record<string, unknown>)[f];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      row[f] = v;
    }
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("agent_targets_role")
    .upsert(row, { onConflict: "role" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ row: data });
}
