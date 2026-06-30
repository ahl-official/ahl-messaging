// GET    /api/tasks/[id]                 — task + comments thread
// PATCH  /api/tasks/[id]   { status?, priority?, title?, description?, due_at?,
//                            assigned_to?, contact_id?, business_phone_number_id? }
//   Assignee can update status only. Admin+ can update everything.
// DELETE /api/tasks/[id]                  — admin+ only

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
const STATUSES: Status[] = ["open", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  assigned_to: string | null;
  created_by: string | null;
  contact_id: string | null;
  business_phone_number_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  task_id: string;
  member_id: string | null;
  body: string;
  kind: "comment" | "status_change" | "assignee_change" | "due_change";
  created_at: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: task, error } = await admin
    .from("tasks")
    .select(
      "id, title, description, status, priority, assigned_to, created_by, contact_id, business_phone_number_id, due_at, completed_at, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const t = task as TaskRow;
  // Visibility: assignee, creator, or admin+. Anything else 404s so
  // the existence of a task isn't leaked across the workspace.
  const canSee =
    isAtLeast(member.role, "admin") ||
    t.assigned_to === member.id ||
    t.created_by === member.id;
  if (!canSee) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: commentsRaw } = await admin
    .from("task_comments")
    .select("id, task_id, member_id, body, kind, created_at")
    .eq("task_id", id)
    .order("created_at", { ascending: true });
  const comments = (commentsRaw ?? []) as CommentRow[];

  const memberIds = Array.from(
    new Set(
      [
        t.assigned_to,
        t.created_by,
        ...comments.map((c) => c.member_id),
      ].filter((v): v is string => Boolean(v)),
    ),
  );
  const memberMap = new Map<
    string,
    { id: string; full_name: string | null; email: string }
  >();
  if (memberIds.length > 0) {
    const { data: mems } = await admin
      .from("team_members")
      .select("id, full_name, email")
      .in("id", memberIds);
    for (const m of mems ?? []) {
      memberMap.set(m.id as string, {
        id: m.id as string,
        full_name: (m.full_name as string | null) ?? null,
        email: m.email as string,
      });
    }
  }

  let contact: { id: string; name: string | null; wa_id: string | null } | null = null;
  if (t.contact_id) {
    const { data: c } = await admin
      .from("contacts")
      .select("id, name, profile_name, wa_id")
      .eq("id", t.contact_id)
      .maybeSingle();
    if (c) {
      contact = {
        id: c.id as string,
        name: ((c.name as string | null) ?? (c.profile_name as string | null)) || null,
        wa_id: (c.wa_id as string | null) ?? null,
      };
    }
  }

  return NextResponse.json({
    task: {
      ...t,
      assignee: t.assigned_to ? memberMap.get(t.assigned_to) ?? null : null,
      creator: t.created_by ? memberMap.get(t.created_by) ?? null : null,
      contact,
    },
    comments: comments.map((c) => ({
      ...c,
      member: c.member_id ? memberMap.get(c.member_id) ?? null : null,
    })),
  });
}

interface PatchBody {
  status?: Status;
  priority?: Priority;
  title?: string;
  description?: string | null;
  assigned_to?: string | null;
  due_at?: string | null;
  contact_id?: string | null;
  business_phone_number_id?: string | null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("tasks")
    .select("id, status, assigned_to, created_by, due_at, priority, title, description")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const cur = existing as TaskRow;

  const isAdmin = isAtLeast(member.role, "admin");
  const isAssignee = cur.assigned_to === member.id;

  // Permissions:
  // - admin+ → full edit
  // - assignee → status + priority only (they can self-prioritise their
  //   work, but cannot reassign or rewrite the brief)
  // - everyone else → reject
  if (!isAdmin && !isAssignee) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const auditLines: Array<{
    kind: CommentRow["kind"];
    body: string;
  }> = [];

  if ("status" in body && body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    if (body.status !== cur.status) {
      patch.status = body.status;
      if (body.status === "done") {
        patch.completed_at = new Date().toISOString();
      } else if (cur.status === "done") {
        patch.completed_at = null;
      }
      auditLines.push({
        kind: "status_change",
        body: `${cur.status} → ${body.status}`,
      });
    }
  }
  if ("priority" in body && body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) {
      return NextResponse.json({ error: "invalid priority" }, { status: 400 });
    }
    if (body.priority !== cur.priority) {
      patch.priority = body.priority;
    }
  }

  if (isAdmin) {
    if ("title" in body && body.title !== undefined) {
      const title = body.title.trim();
      if (!title || title.length > 200) {
        return NextResponse.json({ error: "invalid title" }, { status: 400 });
      }
      patch.title = title;
    }
    if ("description" in body) {
      patch.description = body.description?.toString().trim() || null;
    }
    if ("assigned_to" in body) {
      const newAssignee = body.assigned_to?.toString().trim() || null;
      if (newAssignee) {
        const { data: a } = await admin
          .from("team_members")
          .select("id")
          .eq("id", newAssignee)
          .maybeSingle();
        if (!a) {
          return NextResponse.json(
            { error: "assigned_to not a valid member" },
            { status: 400 },
          );
        }
      }
      if (newAssignee !== cur.assigned_to) {
        patch.assigned_to = newAssignee;
        auditLines.push({
          kind: "assignee_change",
          body: `assignee changed`,
        });
      }
    }
    if ("due_at" in body) {
      const next = body.due_at ? new Date(body.due_at).toISOString() : null;
      if (next !== cur.due_at) {
        patch.due_at = next;
        auditLines.push({ kind: "due_change", body: "due date updated" });
      }
    }
    if ("contact_id" in body) patch.contact_id = body.contact_id || null;
    if ("business_phone_number_id" in body) {
      patch.business_phone_number_id = body.business_phone_number_id || null;
    }
  } else {
    // Assignee tried to change non-allowed fields → 403 so it's not
    // silently swallowed.
    const restricted = [
      "title",
      "description",
      "assigned_to",
      "due_at",
      "contact_id",
      "business_phone_number_id",
    ] as const;
    for (const k of restricted) {
      if (k in body) {
        return NextResponse.json(
          { error: `Only admin+ can change ${k}` },
          { status: 403 },
        );
      }
    }
  }

  if (Object.keys(patch).length === 1) {
    // Only updated_at — nothing meaningful to write.
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error: updErr } = await admin
    .from("tasks")
    .update(patch)
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  if (auditLines.length > 0) {
    await admin.from("task_comments").insert(
      auditLines.map((a) => ({
        task_id: id,
        member_id: member.id,
        body: a.body,
        kind: a.kind,
      })),
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { error } = await admin.from("tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
