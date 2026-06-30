// GET    /api/magic-message/templates → user's team templates + any
//                                         workspace-wide rows
// POST   /api/magic-message/templates → create a new template for the
//                                         caller's team (or pass
//                                         team_id=null for org-wide)
// DELETE /api/magic-message/templates?id=<uuid> → owner / admin / the
//                                                  creator can delete
//
// Migration 0053 may not have run yet on some deploys — we wrap reads
// in try/catch so the UI degrades to "no templates" instead of 500.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";

export const runtime = "nodejs";

interface Template {
  id: string;
  team_id: string | null;
  title: string;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createServiceRoleClient();
    // Caller sees: workspace-wide (team_id IS NULL) + their team's rows.
    let q = admin
      .from("magic_message_templates")
      .select("id, team_id, title, body, created_by, created_at, updated_at")
      .order("title", { ascending: true });
    if (me.team_id) {
      q = q.or(`team_id.is.null,team_id.eq.${me.team_id}`);
    } else {
      q = q.is("team_id", null);
    }
    const { data } = await q;
    return NextResponse.json({
      templates: (data ?? []) as Template[],
      my_team_id: me.team_id ?? null,
    });
  } catch (e) {
    return NextResponse.json({
      templates: [],
      my_team_id: me.team_id ?? null,
      error: e instanceof Error ? e.message : "Failed",
    });
  }
}

interface PostBody {
  title?: string;
  body?: string;
  /** undefined / not-sent → use caller's team. null → workspace-wide
   *  (owner/superadmin only). string → arbitrary team (admin+). */
  team_id?: string | null;
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
  const title = (body.title ?? "").trim();
  const text = (body.body ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });
  if (title.length > 80) {
    return NextResponse.json({ error: "title too long (max 80)" }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "body too long (max 4000)" }, { status: 400 });
  }

  // Resolve target team_id.
  let teamId: string | null;
  if (body.team_id === undefined) {
    teamId = me.team_id ?? null;
  } else if (body.team_id === null) {
    // Workspace-wide save — restrict to admin+ so a regular teammate
    // can't accidentally publish their template across the entire org.
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json(
        { error: "Admin or above to save workspace-wide" },
        { status: 403 },
      );
    }
    teamId = null;
  } else {
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json(
        { error: "Admin or above to target another team" },
        { status: 403 },
      );
    }
    teamId = String(body.team_id);
  }

  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin
      .from("magic_message_templates")
      .insert({
        team_id: teamId,
        title,
        body: text,
        created_by: me.id,
      })
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ template: data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const admin = createServiceRoleClient();
    const { data: row } = await admin
      .from("magic_message_templates")
      .select("created_by, team_id")
      .eq("id", id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Creator can delete their own. Admins+ can delete anything in
    // their team or workspace-wide. Stricter than POST so junior
    // teammates can't wipe each other's templates.
    const isCreator = row.created_by === me.id;
    const isAdmin = isAtLeast(me.role, "admin");
    if (!isCreator && !isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { error } = await admin
      .from("magic_message_templates")
      .delete()
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
