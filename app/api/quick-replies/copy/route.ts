// POST /api/quick-replies/copy
//   { quick_reply_ids: string[], target_phone_number_ids: string[] }
// Make the selected quick replies show on the selected numbers too — unions
// the target numbers into each snippet's business_phone_number_ids. (A quick
// reply is a single row scoped to many numbers, so "copy" = widen the scope.)

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { quick_reply_ids?: string[]; target_phone_number_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const ids = Array.from(new Set((body.quick_reply_ids ?? []).map((s) => String(s).trim()).filter(Boolean)));
  // Skip Evolution numbers — quick replies are Cloud-API only.
  const targets = Array.from(
    new Set(
      (body.target_phone_number_ids ?? [])
        .map((s) => String(s).trim())
        .filter((s) => s && !s.startsWith("evo:")),
    ),
  );
  if (ids.length === 0) return NextResponse.json({ error: "Select at least one quick reply." }, { status: 400 });
  if (targets.length === 0) return NextResponse.json({ error: "Select at least one number." }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: rows, error } = await admin
    .from("quick_replies")
    .select("id, business_phone_number_ids")
    .in("id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let updated = 0;
  for (const r of rows ?? []) {
    const current = Array.isArray(r.business_phone_number_ids) ? (r.business_phone_number_ids as string[]) : [];
    const next = Array.from(new Set([...current, ...targets]));
    if (next.length === current.length) continue; // already on all targets
    const { error: upErr } = await admin
      .from("quick_replies")
      .update({ business_phone_number_ids: next })
      .eq("id", r.id as string);
    if (!upErr) updated++;
  }

  return NextResponse.json({ ok: true, updated, total: ids.length });
}
