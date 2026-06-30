// PATCH (toggle / rename / rotate) and DELETE for one API token.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateApiToken } from "@/lib/api-tokens";

export const runtime = "nodejs";

interface PatchBody {
  enabled?: boolean;
  name?: string;
  rotate?: boolean;
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
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (!n) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    patch.name = n;
  }
  if (body.rotate) patch.token = generateApiToken();

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("api_tokens")
    .update(patch)
    .eq("id", id)
    .eq("business_phone_number_id", bpid)
    .select(
      "id, name, token, enabled, last_used_at, request_count, created_at",
    )
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ token: data });
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
    .from("api_tokens")
    .delete()
    .eq("id", id)
    .eq("business_phone_number_id", bpid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
