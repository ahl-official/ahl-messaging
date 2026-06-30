// GET    /api/labels        — list all workspace labels
// POST   /api/labels        — create
// PUT    /api/labels        — rename / recolor
// DELETE /api/labels?id=…   — delete + scrub from all contacts
//
// Labels are workspace-global (every member sees the same set) and are
// a WORKFLOW tag, not a permission gate — so any signed-in member can
// create / rename / delete. Operators wanted inline label management
// from the chat header without sending teammates into Settings. Delete
// removes the id from every contact's label_ids array so we don't
// leave dangling references.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";

export const runtime = "nodejs";

const VALID_COLORS = [
  "emerald",
  "sky",
  "violet",
  "amber",
  "rose",
  "teal",
  "slate",
] as const;

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("contact_labels")
    .select("*")
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ labels: data ?? [] });
}

interface PostBody {
  name?: string;
  color?: string;
  description?: string;
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (name.length > 40) {
    return NextResponse.json({ error: "Name too long (40 max)" }, { status: 400 });
  }
  const color =
    body.color && (VALID_COLORS as readonly string[]).includes(body.color)
      ? body.color
      : null;
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("contact_labels")
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
        { error: "A label with that name already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ label: data });
}

interface PutBody extends PostBody {
  id?: string;
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    .from("contact_labels")
    .update(patch)
    .eq("id", body.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ label: data });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Permission gate — DELETE removes the label from every contact it
  // was assigned to, so we require can_delete_labels (owner / admin
  // get it by default; teammates need the owner to grant explicitly).
  if (me.role !== "owner") {
    const perms = await getEffectivePermissionsFor(me);
    if (!perms.can_delete_labels) {
      return NextResponse.json(
        { error: "You don't have permission to delete labels." },
        { status: 403 },
      );
    }
  }
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const admin = createServiceRoleClient();

  // 1. Scrub the id from every contact's label_ids array so we don't
  //    leave dangling references when the label disappears.
  const { error: scrubErr } = await admin.rpc("array_remove_label_from_contacts", { p_label: id }).single();
  // The RPC above is optional — fall back to a manual UPDATE so this
  // works even before the RPC migration lands.
  if (scrubErr) {
    const { data: contacts } = await admin
      .from("contacts")
      .select("id, label_ids")
      .contains("label_ids", [id]);
    for (const c of (contacts ?? []) as Array<{ id: string; label_ids: string[] }>) {
      const next = (c.label_ids ?? []).filter((x) => x !== id);
      await admin.from("contacts").update({ label_ids: next }).eq("id", c.id);
    }
  }

  const { error } = await admin.from("contact_labels").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
