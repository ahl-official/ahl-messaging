// POST /api/tasks/[id]/comments  { body }
//   Add a comment to a task. Assignee, creator, or admin+ — same
//   visibility rule as GET /api/tasks/[id].

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let body: { body?: string };
  try {
    body = (await request.json()) as { body?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const text = body.body?.trim();
  if (!text) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "comment too long (2000 max)" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: task } = await admin
    .from("tasks")
    .select("id, assigned_to, created_by")
    .eq("id", id)
    .maybeSingle();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const t = task as {
    id: string;
    assigned_to: string | null;
    created_by: string | null;
  };
  const canComment =
    isAtLeast(member.role, "admin") ||
    t.assigned_to === member.id ||
    t.created_by === member.id;
  if (!canComment) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await admin.from("task_comments").insert({
    task_id: id,
    member_id: member.id,
    body: text,
    kind: "comment",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Bump parent task's updated_at so the list view reorders correctly.
  await admin
    .from("tasks")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
