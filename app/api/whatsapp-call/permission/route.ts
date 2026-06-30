// GET /api/whatsapp-call/permission?contact_id=...
//
// Returns the contact's current WhatsApp call-permission row (state +
// granted_at + expires_at) so the composer's Call button can show the
// "calling window" — whether a business-initiated call is allowed right
// now and how long the ~7-day permission lasts. Read-only.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contactId = request.nextUrl.searchParams.get("contact_id");
  if (!contactId) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("whatsapp_call_permissions")
    .select("state, granted_at, expires_at")
    .eq("contact_id", contactId)
    .maybeSingle();

  return NextResponse.json(
    { permission: data ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
