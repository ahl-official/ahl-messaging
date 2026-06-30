// CRUD for outbound webhooks attached to a business phone number.
//   GET  → list every webhook on this BPID
//   POST → register a new URL (auto-generates the HMAC secret)
//
// Admin-only at the route layer; RLS only blocks anon clients.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateWebhookSecret } from "@/lib/outbound-webhooks";

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
    .from("outbound_webhooks")
    .select(
      "id, label, url, secret, enabled, last_attempt_at, last_status_code, last_error, delivery_count, failure_count, created_at, created_by_user_id",
    )
    .eq("business_phone_number_id", bpid)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ webhooks: data ?? [] });
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

  let body: { url?: string; label?: string; enabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "URL must start with http:// or https://" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("outbound_webhooks")
    .insert({
      business_phone_number_id: bpid,
      url,
      label: body.label?.trim() || null,
      enabled: body.enabled !== false,
      secret: generateWebhookSecret(),
      created_by_user_id: me.user_id,
    })
    .select(
      "id, label, url, secret, enabled, last_attempt_at, last_status_code, last_error, delivery_count, failure_count, created_at, created_by_user_id",
    )
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ webhook: data });
}
