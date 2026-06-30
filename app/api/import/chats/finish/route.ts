// POST /api/import/chats/finish
//
// Marks an import job complete and recomputes the last_message_* preview
// for every contact whose rows were touched, so the inbox lists the
// imported chats with their actual most-recent message instead of "—".
// Pass `cancelled: true` to abort a job that's still in-flight.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface Body {
  job_id?: string;
  cancelled?: boolean;
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
  const jobId = body.job_id?.trim();
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: job } = await admin
    .from("chat_import_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Unknown job_id" }, { status: 404 });
  if (job.status !== "running") {
    return NextResponse.json(
      { error: `Job is ${job.status}, not running.` },
      { status: 409 },
    );
  }

  if (body.cancelled) {
    const { data: cancelled } = await admin
      .from("chat_import_jobs")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("*")
      .single();
    return NextResponse.json({ job: cancelled });
  }

  // Recompute contact previews — pull the latest message per contact on
  // the target bpid and write last_message_* fields. Limited to contacts
  // touched by this number to avoid scanning the whole table.
  const { data: contacts } = await admin
    .from("contacts")
    .select("id")
    .eq("business_phone_number_id", job.target_bpid);

  let previewsUpdated = 0;
  for (const c of contacts ?? []) {
    const { data: latest } = await admin
      .from("messages")
      .select("content, direction, status, timestamp")
      .eq("contact_id", c.id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) continue;
    await admin
      .from("contacts")
      .update({
        last_message_at: latest.timestamp,
        last_message_preview: (latest.content ?? "").slice(0, 120) || null,
        last_message_direction: latest.direction,
        last_message_status: latest.status,
      })
      .eq("id", c.id);
    previewsUpdated++;
  }

  const { data: finished } = await admin
    .from("chat_import_jobs")
    .update({ status: "completed", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .select("*")
    .single();

  return NextResponse.json({ job: finished, previews_updated: previewsUpdated });
}
