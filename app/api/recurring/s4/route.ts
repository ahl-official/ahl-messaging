// GET  /api/recurring  — list recurring campaigns (+ send counts)
// POST /api/recurring  — create a recurring (daily dynamic) campaign

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface PostBody {
  name?: string;
  business_phone_number_id?: string;
  template_name?: string;
  template_language?: string | null;
  template_body_preview?: string | null;
  template_components?: unknown;
  filter?: Record<string, unknown>;
  window_days?: number;
  rate_limit_per_minute?: number;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("recurring_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recurring: data ?? [] });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  const bpid = (body.business_phone_number_id ?? "").trim();
  const tpl = (body.template_name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!bpid) return NextResponse.json({ error: "Send-from number is required" }, { status: 400 });
  if (!tpl) return NextResponse.json({ error: "Template is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("recurring_campaigns")
    .insert({
      name,
      business_phone_number_id: bpid,
      template_name: tpl,
      template_language: body.template_language?.trim() || null,
      template_body_preview: body.template_body_preview?.trim() || null,
      template_components: body.template_components ?? null,
      filter: body.filter ?? {},
      window_days: Math.max(1, Math.min(365, Math.round(body.window_days ?? 90))),
      rate_limit_per_minute: Math.max(1, Math.min(120, body.rate_limit_per_minute ?? 30)),
      created_by_email: me.email ?? null,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recurring: data });
}
