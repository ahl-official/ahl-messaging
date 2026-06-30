// POST /api/import/chats/start
//
// Creates a new chat-import job. The caller (browser UI or external
// migration script) does this once per import session, then streams
// contacts + messages in batches via /batch, then calls /finish.
//
// Auth: owner or admin only. The job picks the target business number
// from the body and validates it exists on this workspace.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface Body {
  target_bpid?: string;
  label?: string;
  source_format?: "json" | "csv" | "script" | string;
  /** Optional total counts — informational, used for progress bar UX. */
  total_messages?: number;
  total_contacts?: number;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const targetBpid = body.target_bpid?.trim();
  if (!targetBpid) {
    return NextResponse.json({ error: "target_bpid is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();

  // Validate target number exists on this workspace.
  const { data: number } = await admin
    .from("business_numbers")
    .select("phone_number_id")
    .eq("phone_number_id", targetBpid)
    .maybeSingle();
  if (!number) {
    return NextResponse.json(
      { error: `Business number ${targetBpid} not connected to this workspace.` },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from("chat_import_jobs")
    .insert({
      target_bpid: targetBpid,
      label: body.label?.trim() || null,
      source_format: body.source_format ?? "json",
      total_messages: Number.isFinite(body.total_messages) ? body.total_messages : 0,
      total_contacts: Number.isFinite(body.total_contacts) ? body.total_contacts : 0,
      status: "running",
      created_by: member.email,
    })
    .select("*")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create job" },
      { status: 500 },
    );
  }
  return NextResponse.json({ job: data });
}
