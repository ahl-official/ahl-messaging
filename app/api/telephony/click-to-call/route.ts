// POST /api/telephony/click-to-call  { lead_phone, agent_phone? }
// Trigger an outbound click-to-call through the configured operator API.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { placeClickToCall } from "@/lib/telephony";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    lead_phone?: string;
    agent_phone?: string;
    contact_id?: string;
    virtual_number_tag?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Accept either an explicit lead_phone or a contact_id (the chat Call menu
  // sends contact_id, like the other dialers).
  let leadPhone = body.lead_phone?.trim() ?? "";
  if (!leadPhone && body.contact_id) {
    const admin = createServiceRoleClient();
    const { data: c } = await admin.from("contacts").select("wa_id").eq("id", body.contact_id).maybeSingle();
    leadPhone = (c?.wa_id as string | null) ?? "";
  }
  if (!leadPhone) return NextResponse.json({ error: "lead_phone or contact_id required" }, { status: 400 });

  try {
    const r = await placeClickToCall(leadPhone, {
      agentPhone: body.agent_phone,
      agentEmail: me.email,
      virtualNumberTag: body.virtual_number_tag,
    });
    if (!r.ok) {
      return NextResponse.json({ error: `Operator API ${r.status}: ${r.body}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, status: r.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Call failed" }, { status: 400 });
  }
}
