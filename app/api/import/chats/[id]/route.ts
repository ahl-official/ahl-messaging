// GET /api/import/chats/[id]
//
// Poll endpoint — UI hits this every second to refresh the progress bar
// (processed_*, inserted_*, errors[]) without re-uploading anything.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { id } = await params;
  const admin = createServiceRoleClient();
  const { data: job } = await admin
    .from("chat_import_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  return NextResponse.json({ job });
}
