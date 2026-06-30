// POST /api/whatsapp-call/settings
//
// One-time switch: turn WhatsApp Cloud Calling on (or off) for a
// given phone_number_id. Required by Meta before any inbound call
// reaches our webhook OR any outbound dial attempt is honored. We
// keep this behind owner/superadmin to avoid junior agents flipping
// production settings by accident.
//
// Body: {
//   phone_number_id: string,
//   status?: "ENABLED" | "DISABLED",
//   callback_permission_status?: "ENABLED" | "DISABLED",
// }

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { enableCalling, type CallingSettings } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner" && member.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: {
    phone_number_id?: string;
    status?: "ENABLED" | "DISABLED";
    callback_permission_status?: "ENABLED" | "DISABLED";
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.phone_number_id) {
    return NextResponse.json(
      { error: "phone_number_id required" },
      { status: 400 },
    );
  }

  const settings: CallingSettings = {
    status: payload.status ?? "ENABLED",
    callback_permission_status:
      payload.callback_permission_status ?? "ENABLED",
  };
  const result = await enableCalling(payload.phone_number_id, settings);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Failed to update calling settings" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, raw: result.raw });
}
