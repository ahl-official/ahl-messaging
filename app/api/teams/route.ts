// GET  /api/teams           — list all teams + member counts
// POST /api/teams           — create a new team (admin+)
// PUT  /api/teams           — rename / recolor an existing team (admin+)
// DELETE /api/teams?id=…    — drop a team. Members fall back to NULL
//                             (i.e. unassigned) thanks to the FK
//                             ON DELETE SET NULL.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

const VALID_COLORS = ["emerald", "sky", "violet", "amber", "rose", "teal", "slate"] as const;

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const [{ data: teams }, { data: members }] = await Promise.all([
    admin.from("teams").select("*").order("name", { ascending: true }),
    admin
      .from("team_members")
      .select("team_id, is_active")
      .eq("is_active", true),
  ]);
  const counts = new Map<string, number>();
  for (const m of (members ?? []) as Array<{ team_id: string | null }>) {
    if (!m.team_id) continue;
    counts.set(m.team_id, (counts.get(m.team_id) ?? 0) + 1);
  }
  const rows = (teams ?? []).map((t: Record<string, unknown>) => ({
    ...t,
    member_count: counts.get(t.id as string) ?? 0,
  }));
  return NextResponse.json({ teams: rows });
}

interface PostBody {
  name?: string;
  color?: string;
  description?: string;
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (name.length > 60) {
    return NextResponse.json({ error: "Name too long (60 max)" }, { status: 400 });
  }
  const color =
    body.color && (VALID_COLORS as readonly string[]).includes(body.color)
      ? body.color
      : null;
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("teams")
    .insert({
      name,
      color,
      description: body.description?.trim() || null,
    })
    .select("*")
    .single();
  if (error) {
    if (/duplicate key|23505/.test(error.message)) {
      return NextResponse.json(
        { error: "A team with that name already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ team: data });
}

interface PutBody extends PostBody {
  id?: string;
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return NextResponse.json({ error: "Name required" }, { status: 400 });
    patch.name = n;
  }
  if (body.color !== undefined) {
    patch.color =
      body.color && (VALID_COLORS as readonly string[]).includes(body.color)
        ? body.color
        : null;
  }
  if (body.description !== undefined) {
    patch.description = body.description?.trim() || null;
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("teams")
    .update(patch)
    .eq("id", body.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ team: data });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const admin = createServiceRoleClient();
  const { error } = await admin.from("teams").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
