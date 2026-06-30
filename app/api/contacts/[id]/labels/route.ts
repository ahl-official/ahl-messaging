// PUT /api/contacts/[id]/labels
//
// Body: { label_ids: string[] }   // order matters; first three kept.
//
// Replaces the contact's labels in one shot. Max 3 enforced server-side
// so the UI can't sneak a 4th in. Any signed-in member can edit
// (labels are workflow tags, not a permission gate).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

const MAX_LABELS = 3;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: contactId } = await params;
  if (!contactId) {
    return NextResponse.json({ error: "contact id required" }, { status: 400 });
  }

  let body: { label_ids?: unknown };
  try {
    body = (await request.json()) as { label_ids?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.label_ids)) {
    return NextResponse.json(
      { error: "label_ids must be an array of uuids" },
      { status: 400 },
    );
  }

  // Dedup, cap at MAX_LABELS, validate uuid-ish shape.
  const seen = new Set<string>();
  const trimmed: string[] = [];
  for (const raw of body.label_ids) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    trimmed.push(t);
    if (trimmed.length >= MAX_LABELS) break;
  }

  const admin = createServiceRoleClient();

  // Validate every id refers to a real label so a stale UI can't
  // attach phantom uuids.
  if (trimmed.length > 0) {
    const { data: existing } = await admin
      .from("contact_labels")
      .select("id")
      .in("id", trimmed);
    const validIds = new Set((existing ?? []).map((r: { id: string }) => r.id));
    const filtered = trimmed.filter((id) => validIds.has(id));
    if (filtered.length !== trimmed.length) {
      return NextResponse.json(
        { error: "One or more label ids do not exist." },
        { status: 400 },
      );
    }
  }

  const { data, error } = await admin
    .from("contacts")
    .update({ label_ids: trimmed })
    .eq("id", contactId)
    .select("id, label_ids")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, contact: data });
}
