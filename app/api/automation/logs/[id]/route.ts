// PATCH /api/automation/logs/[id]   { rating?: "good"|"needs_review"|"wrong"|null, note?: string }
//
// Sets (or clears) the quality rating + note on a single automation_log
// row. Drives the daily "Quality review" queue — operator skims yesterday's
// replies, marks each, and patterns emerge over time.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ALLOWED = new Set(["good", "needs_review", "wrong"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let body: { rating?: string | null; note?: string };
  try {
    body = (await request.json()) as { rating?: string | null; note?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const rating = body.rating ?? null;
  if (rating !== null && !ALLOWED.has(rating)) {
    return NextResponse.json(
      { error: "rating must be good | needs_review | wrong | null" },
      { status: 400 },
    );
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("automation_logs")
    .update({
      quality_rating: rating,
      quality_note: note || null,
      quality_reviewed_at: rating ? new Date().toISOString() : null,
      quality_reviewed_by: rating ? user.email ?? user.id : null,
    })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
