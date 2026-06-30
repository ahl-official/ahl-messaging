// Per-webhook operations: PATCH (toggle / rename / rotate secret) and
// DELETE.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateWebhookSecret } from "@/lib/outbound-webhooks";

export const runtime = "nodejs";

interface PatchBody {
  enabled?: boolean;
  label?: string;
  url?: string;
  rotate_secret?: boolean;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ bpid: string; id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { bpid, id } = await params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.label === "string") patch.label = body.label.trim() || null;
  if (typeof body.url === "string") {
    const u = body.url.trim();
    if (!/^https?:\/\//i.test(u)) {
      return NextResponse.json(
        { error: "URL must start with http:// or https://" },
        { status: 400 },
      );
    }
    patch.url = u;
  }
  if (body.rotate_secret) patch.secret = generateWebhookSecret();

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("outbound_webhooks")
    .update(patch)
    .eq("id", id)
    .eq("business_phone_number_id", bpid)
    .select(
      "id, label, url, secret, enabled, last_attempt_at, last_status_code, last_error, delivery_count, failure_count, created_at",
    )
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ webhook: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ bpid: string; id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { bpid, id } = await params;

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("outbound_webhooks")
    .delete()
    .eq("id", id)
    .eq("business_phone_number_id", bpid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
