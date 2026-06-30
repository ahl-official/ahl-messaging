// POST /api/business-numbers/[bpid]/subscribe-webhook
//
// Subscribes our app to this number's WhatsApp Business Account for webhook
// delivery (POST /{waba_id}/subscribed_apps). The app-level webhook config
// (callback URL + "messages" field) is shared, but each WABA must ALSO be
// subscribed to the app — otherwise inbound messages never reach us even
// though outbound works. Owner/admin only.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { subscribeAppToWaba } from "@/lib/embedded-signup";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ bpid: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { bpid } = await params;

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("business_numbers")
    .select("waba_id, provider")
    .eq("phone_number_id", bpid)
    .maybeSingle();

  if (row?.provider && row.provider !== "meta") {
    return NextResponse.json({ error: "Only Meta numbers use Meta webhooks." }, { status: 400 });
  }
  const wabaId = (row?.waba_id as string | null)?.trim();
  if (!wabaId) {
    return NextResponse.json({ error: "This number has no WABA id set (Settings → Numbers → Edit WABA)." }, { status: 400 });
  }

  const creds = await resolveCredsForPhoneNumberId(bpid);
  if (!creds?.access_token) {
    return NextResponse.json({ error: "No access token for this number's portfolio." }, { status: 400 });
  }

  try {
    await subscribeAppToWaba(wabaId, creds.access_token);
    return NextResponse.json({ ok: true, waba_id: wabaId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Subscribe failed" },
      { status: 502 },
    );
  }
}
