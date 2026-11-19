// Firebase CRM → oneinbox stage/assignee sync + Task 2 drip enroll.
//
//   POST /api/ahl-crm/sync
//   Authorization: Bearer <WEBHOOK_INTERNAL_TOKEN>
//   Body JSON:
//   {
//     "mobileNo": "9198…",
//     "leadUniqueId": "Lead ID - 26474",
//     "leadStatus": "Warm Lead",
//     "assignedTo": "Mehjabeen",
//     "assignedToEmail": "optional@…",
//     "clientName": "optional"
//   }
//
// Call this from Firebase createLead/updateLead (and sheet assign if needed).

import { NextResponse, type NextRequest } from "next/server";
import { applyAhlCrmLeadToContacts } from "@/lib/ahl-crm-sync";
import { enrollDripsForLead } from "@/lib/drip";
import type { ParsedLsqLead } from "@/lib/lsq-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function expectedToken(): string {
  return (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
}

function tokenFromRequest(req: NextRequest, bodyToken: string): boolean {
  const expected = expectedToken();
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === expected) return true;
  if (bodyToken && bodyToken === expected) return true;
  return false;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "AHL CRM → oneinbox sync + Task 2 drip enroll",
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!tokenFromRequest(req, String(body.token ?? "").trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mobileNo = (body.mobileNo as string) ?? null;
  const leadUniqueId = (body.leadUniqueId as string) ?? null;
  const leadStatus = (body.leadStatus as string) ?? null;
  const assignedTo = (body.assignedTo as string) ?? null;
  const assignedToEmail = (body.assignedToEmail as string) ?? null;
  const clientName = (body.clientName as string) ?? null;

  const result = await applyAhlCrmLeadToContacts({
    mobileNo,
    leadUniqueId,
    leadStatus,
    assignedTo,
    assignedToEmail,
    clientName,
  });

  // Task 2: enroll into stage-matched drips (Mehjabeen pilot + AHL Messaging).
  let dripsEnrolled = 0;
  const mobileDigits = String(mobileNo ?? "").replace(/\D/g, "");
  if (mobileDigits.length >= 10 && leadStatus) {
    const lead: ParsedLsqLead = {
      mobile: mobileDigits,
      prospect_id: leadUniqueId ? String(leadUniqueId).trim() : null,
      stage: String(leadStatus).trim() || null,
      lead_number: leadUniqueId ? String(leadUniqueId).trim() : null,
      owner_name: assignedTo ? String(assignedTo).trim() : null,
      owner_email: assignedToEmail ? String(assignedToEmail).trim() : null,
      first_name: clientName ? String(clientName).trim() : null,
      source: "CRM",
      sub_source: null,
      platform: "WhatsApp",
      fields: {},
    };
    try {
      dripsEnrolled = await enrollDripsForLead(lead);
    } catch (e) {
      console.warn(
        "[ahl-crm-sync] drip enroll failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    updated: result.updated,
    matchedIds: result.matchedIds,
    ensuredAhlMessaging: result.ensuredAhlMessaging,
    drips_enrolled: dripsEnrolled,
  });
}
