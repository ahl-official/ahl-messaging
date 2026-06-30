// POST /api/ozonetel-call/initiate  body { contact_id }
//
// Fires an Ozonetel CloudAgent manual dial for the contact. The
// operator must already be logged into CloudAgent (manual/blended,
// Ready) — CloudAgent then rings their agent phone / WebRTC session and
// bridges the customer. Returns the UCID on success.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import {
  agentManualDial,
  getActiveOzonetelSettings,
  normalizeCustomerNumber,
} from "@/lib/ozonetel";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Operator's Ozonetel agentID = the email they log into CloudAgent
  // with. Owners can override per-operator in Settings → Calling →
  // Agent mapping (ozonetel_agent_id column), but the default is the
  // member's email so we don't block calls just because the mapping
  // hasn't been wired.
  const agentId =
    member.ozonetel_agent_id?.trim() || member.email?.trim();
  if (!agentId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Couldn't resolve your Ozonetel agent ID — no email on your team_members row.",
      },
      { status: 409 },
    );
  }

  let payload: { contact_id?: string };
  try {
    payload = (await request.json()) as { contact_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.contact_id) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }

  const settings = await getActiveOzonetelSettings();
  if (!settings) {
    return NextResponse.json(
      {
        ok: false,
        error: "Ozonetel isn't configured yet. Add the account in Settings → Calling.",
      },
      { status: 409 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id")
    .eq("id", payload.contact_id)
    .maybeSingle();
  if (!contact || !contact.wa_id) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const customerNumber = normalizeCustomerNumber(contact.wa_id);
  if (customerNumber.length < 10) {
    return NextResponse.json(
      { ok: false, error: `Bad customer number (${contact.wa_id}).` },
      { status: 400 },
    );
  }

  // eslint-disable-next-line no-console
  console.log("[ozonetel] dialing", {
    base_url: settings.base_url,
    campaign: settings.campaign_name,
    user_name: settings.user_name,
    agentId,
    customerNumber,
  });
  const result = await agentManualDial({ settings, agentId, customerNumber });
  // eslint-disable-next-line no-console
  console.log("[ozonetel] result", result);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Dial failed" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, ucid: result.ucid, status: result.status });
}
