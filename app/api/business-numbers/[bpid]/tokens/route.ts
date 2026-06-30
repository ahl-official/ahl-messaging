// GET  /api/business-numbers/[bpid]/tokens — list every API token on this BPID.
// POST /api/business-numbers/[bpid]/tokens — create a new token.
//
// Admin-only. Tokens map an external Bearer to a BPID; the relay then
// uses that BPID's portfolio Meta access-token to call Meta — so
// integrators never see Meta credentials.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateApiToken } from "@/lib/api-tokens";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bpid: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { bpid } = await params;
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("api_tokens")
    .select(
      "id, name, token, enabled, last_used_at, request_count, created_at, created_by_user_id",
    )
    .eq("business_phone_number_id", bpid)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tokens: data ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bpid: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { bpid } = await params;

  let body: { name?: string; enabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("api_tokens")
    .insert({
      business_phone_number_id: bpid,
      name,
      token: generateApiToken(),
      enabled: body.enabled !== false,
      created_by_user_id: me.user_id,
    })
    .select(
      "id, name, token, enabled, last_used_at, request_count, created_at",
    )
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ token: data });
}
