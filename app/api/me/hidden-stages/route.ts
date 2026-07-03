// GET  /api/me/hidden-stages              — { hidden: string[] }
// PUT  /api/me/hidden-stages  { hidden }   — replace the caller's list
//
// Per-agent preference for which CRM stages to hide from the inbox
// funnel strip. Stored on team_members.hidden_stages so it syncs
// across the agent's devices.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_members")
    .select("hidden_stages")
    .eq("id", member.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    hidden: ((data?.hidden_stages as string[] | null) ?? []),
  });
}

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { hidden?: string[] };
  try {
    body = (await request.json()) as { hidden?: string[] };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Sanitize: trim, drop empties, dedupe, cap length so the array
  // can't grow unbounded if something glitches.
  const cleaned = Array.from(
    new Set(
      (body.hidden ?? [])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean),
    ),
  ).slice(0, 100);

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("team_members")
    .update({ hidden_stages: cleaned, updated_at: new Date().toISOString() })
    .eq("id", member.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, hidden: cleaned });
}
