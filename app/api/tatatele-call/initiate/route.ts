// POST /api/tatatele-call/initiate  body { contact_id }
//
// Fires a Tata Tele (Smartflo) click-to-call: rings the operator's
// Smartflo agent number first, then bridges the contact. Returns
// immediately — Smartflo confirms origination, not pickup.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import {
  clickToCall,
  getActiveTataTeleSettings,
  normalizeDestination,
} from "@/lib/tatatele";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const agentNumber = member.tatatele_agent_number?.trim();
  if (!agentNumber) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Your Tata Tele agent number isn't set. Ask an owner to wire it in Settings → Calling.",
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

  const settings = await getActiveTataTeleSettings();
  if (!settings) {
    return NextResponse.json(
      {
        ok: false,
        error: "Tata Tele isn't configured yet. Add the account in Settings → Calling.",
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

  const destinationNumber = normalizeDestination(contact.wa_id);
  if (destinationNumber.length < 10) {
    return NextResponse.json(
      { ok: false, error: `Bad customer number (${contact.wa_id}).` },
      { status: 400 },
    );
  }

  // eslint-disable-next-line no-console
  console.log("[tatatele] dialing", {
    base_url: settings.base_url,
    caller_id: settings.caller_id,
    agentNumber,
    destinationNumber,
  });
  const result = await clickToCall({ settings, agentNumber, destinationNumber });
  // eslint-disable-next-line no-console
  console.log("[tatatele] result", result);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Dial failed" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, message: result.message });
}
