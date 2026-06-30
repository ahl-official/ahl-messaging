// GET  /api/tasks?scope=mine|all&status=&priority=&assigned_to=&q=&page=
//   List tasks. Default scope='mine' for everyone; admin+ can pass
//   scope='all' to see the whole workspace. Filters compose.
// POST /api/tasks  { title, description?, assigned_to, priority?, due_at?,
//                    contact_id?, business_phone_number_id? }
//   Admin+ only — owner, superadmin, admin can assign.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
const STATUSES: Status[] = ["open", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

interface DbTask {
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

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const scope = sp.get("scope") === "all" ? "all" : "mine";
  const statusFilter = sp.get("status") as Status | null;
  const priorityFilter = sp.get("priority") as Priority | null;
  const assignedTo = sp.get("assigned_to");
  const q = sp.get("q")?.trim();
  const page = Math.max(1, Number(sp.get("page") ?? "1"));
  const pageSize = 50;

  // Only admin+ can see "all". Teammates' "all" silently degrades to
  // "mine" so they can't enumerate the workspace.
  const effectiveScope =
    scope === "all" && isAtLeast(member.role, "admin") ? "all" : "mine";

  const admin = createServiceRoleClient();
  let query = admin
    .from("tasks")
    .select(
      "id, title, description, status, priority, assigned_to, created_by, contact_id, business_phone_number_id, due_at, completed_at, created_at, updated_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (effectiveScope === "mine") {
    // Assignee OR creator — both should see it in "mine".
    query = query.or(`assigned_to.eq.${member.id},created_by.eq.${member.id}`);
  }
  if (statusFilter && STATUSES.includes(statusFilter)) {
    query = query.eq("status", statusFilter);
  }
  if (priorityFilter && PRIORITIES.includes(priorityFilter)) {
    query = query.eq("priority", priorityFilter);
  }
  if (assignedTo && effectiveScope === "all") {
    query = query.eq("assigned_to", assignedTo);
  }
  if (q) {
    query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%`);
  }

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as DbTask[];

  // Hydrate member display names for assignee + creator in one round
  // trip so the UI doesn't need per-row lookups.
  const memberIds = Array.from(
    new Set(
      rows
        .flatMap((r) => [r.assigned_to, r.created_by])
        .filter((v): v is string => Boolean(v)),
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

  // Contact display names so a linked-contact chip can show the patient
  // name rather than a UUID. Cheap — same one-shot pattern as members.
  const contactIds = Array.from(
    new Set(rows.map((r) => r.contact_id).filter((v): v is string => Boolean(v))),
  );
  const contactMap = new Map<
    string,
    { id: string; name: string | null; wa_id: string | null }
  >();
  if (contactIds.length > 0) {
    const { data: cs } = await admin
      .from("contacts")
      .select("id, name, profile_name, wa_id")
      .in("id", contactIds);
    for (const c of cs ?? []) {
      contactMap.set(c.id as string, {
        id: c.id as string,
        name:
          ((c.name as string | null) ??
            (c.profile_name as string | null)) ||
          null,
        wa_id: (c.wa_id as string | null) ?? null,
      });
    }
  }

  const tasks = rows.map((t) => ({
    ...t,
    assignee:
      t.assigned_to && memberMap.has(t.assigned_to)
        ? memberMap.get(t.assigned_to)!
        : null,
    creator:
      t.created_by && memberMap.has(t.created_by)
        ? memberMap.get(t.created_by)!
        : null,
    contact:
      t.contact_id && contactMap.has(t.contact_id)
        ? contactMap.get(t.contact_id)!
        : null,
  }));

  return NextResponse.json({
    tasks,
    page,
    page_size: pageSize,
    total: count ?? tasks.length,
    scope: effectiveScope,
  });
}

interface PostBody {
  title?: string;
  description?: string | null;
  assigned_to?: string;
  priority?: Priority;
  due_at?: string | null;
  contact_id?: string | null;
  business_phone_number_id?: string | null;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json(
      { error: "Admins / superadmins / owner only" },
      { status: 403 },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (title.length > 200) {
    return NextResponse.json({ error: "title too long (200 max)" }, { status: 400 });
  }
  const assignedTo = body.assigned_to?.trim();
  if (!assignedTo) {
    return NextResponse.json(
      { error: "assigned_to is required" },
      { status: 400 },
    );
  }
  const priority: Priority = PRIORITIES.includes(body.priority as Priority)
    ? (body.priority as Priority)
    : "normal";

  const admin = createServiceRoleClient();

  // Validate the assignee exists in this workspace — without this an
  // operator could paste any UUID and orphan a task.
  const { data: assignee } = await admin
    .from("team_members")
    .select("id, role")
    .eq("id", assignedTo)
    .maybeSingle();
  if (!assignee) {
    return NextResponse.json(
      { error: "assigned_to is not a valid team member" },
      { status: 400 },
    );
  }

  const dueAt = body.due_at ? new Date(body.due_at).toISOString() : null;

  const { data, error } = await admin
    .from("tasks")
    .insert({
      title,
      description: body.description?.toString().trim() || null,
      status: "open",
      priority,
      assigned_to: assignedTo,
      created_by: member.id,
      contact_id: body.contact_id || null,
      business_phone_number_id: body.business_phone_number_id || null,
      due_at: dueAt,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
