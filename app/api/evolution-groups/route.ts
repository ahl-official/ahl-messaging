// GET    /api/evolution-groups            → list groups
// POST   /api/evolution-groups   { name } → create
// PATCH  /api/evolution-groups   { id, name } → rename
// DELETE /api/evolution-groups?id=...      → delete (numbers fall back to "Ungrouped")
//
// Operator-defined clusters for Evolution (Baileys) numbers — typically
// by city or clinic (Delhi / Noida / Haridwar …). Owner / superadmin
// can manage; anyone can read for the picker.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GroupRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data: groups, error } = await admin
    .from("evolution_groups")
    .select("id, name, color, created_at, updated_at")
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Per-group number counts — small N, one extra query is fine.
  const { data: numbers } = await admin
    .from("business_numbers")
    .select("evolution_group_id")
    .not("evolution_group_id", "is", null);
  const counts = new Map<string, number>();
  for (const r of (numbers ?? []) as Array<{ evolution_group_id: string }>) {
    counts.set(r.evolution_group_id, (counts.get(r.evolution_group_id) ?? 0) + 1);
  }

  return NextResponse.json({
    groups: ((groups ?? []) as GroupRow[]).map((g) => ({
      ...g,
      number_count: counts.get(g.id) ?? 0,
    })),
  });
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "superadmin")) {
    return NextResponse.json({ error: "Owners / superadmins only" }, { status: 403 });
  }
  let body: { name?: string; color?: string };
  try {
    body = (await request.json()) as { name?: string; color?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (name.length > 60) {
    return NextResponse.json({ error: "name too long (60 max)" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("evolution_groups")
    .insert({ name, color: body.color?.trim() || null })
    .select("id, name, color, created_at, updated_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "A group with that name already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ group: data });
}

export async function PATCH(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "superadmin")) {
    return NextResponse.json({ error: "Owners / superadmins only" }, { status: 403 });
  }
  let body: { id?: string; name?: string; color?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 60) {
      return NextResponse.json({ error: "invalid name" }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.color !== undefined) patch.color = body.color.trim() || null;

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("evolution_groups")
    .update(patch)
    .eq("id", body.id);
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "A group with that name already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "superadmin")) {
    return NextResponse.json({ error: "Owners / superadmins only" }, { status: 403 });
  }
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const admin = createServiceRoleClient();
  // ON DELETE SET NULL — any numbers assigned to this group fall back
  // to "Ungrouped" automatically.
  const { error } = await admin.from("evolution_groups").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
