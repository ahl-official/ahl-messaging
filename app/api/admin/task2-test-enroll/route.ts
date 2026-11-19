// Manual Task 2 pilot enroll for one test lead (no Firebase needed).
//
//   POST /api/admin/task2-test-enroll
//   Authorization: Bearer <WEBHOOK_INTERNAL_TOKEN>
//   Body:
//   {
//     "mobileNo": "9198…",
//     "leadStatus": "Warm Lead",
//     "assignedTo": "Mehjabeen",
//     "clientName": "Test",
//     "leadUniqueId": "optional"
//   }
//
// Mirrors CRM sync: ensure AHL Messaging contact → assign → enroll drip.
// Drip tick (every ~30s) will then send Day-1 if the drip is enabled.

import { NextResponse, type NextRequest } from "next/server";
import { applyAhlCrmLeadToContacts } from "@/lib/ahl-crm-sync";
import { enrollDripsForLead } from "@/lib/drip";
import type { ParsedLsqLead } from "@/lib/lsq-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function expectedToken(): string {
  return (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
}

function authorized(req: NextRequest, bodyToken: string): boolean {
  const expected = expectedToken();
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === expected) return true;
  if (bodyToken && bodyToken === expected) return true;
  return false;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!authorized(req, String(body.token ?? "").trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mobileNo = String(body.mobileNo ?? "").trim();
  const leadStatus = String(body.leadStatus ?? "Warm Lead").trim() || "Warm Lead";
  const assignedTo = String(body.assignedTo ?? "Mehjabeen").trim() || "Mehjabeen";
  const clientName = String(body.clientName ?? "Task2 Test").trim();
  const leadUniqueId = String(body.leadUniqueId ?? `Lead ID - Task2Test-${Date.now()}`).trim();

  if (mobileNo.replace(/\D/g, "").length < 10) {
    return NextResponse.json({ error: "mobileNo required (10+ digits)" }, { status: 400 });
  }

  const sync = await applyAhlCrmLeadToContacts({
    mobileNo,
    leadUniqueId,
    leadStatus,
    assignedTo,
    assignedToEmail: (body.assignedToEmail as string) ?? null,
    clientName,
  });

  const mobileDigits = mobileNo.replace(/\D/g, "");
  const lead: ParsedLsqLead = {
    mobile: mobileDigits,
    prospect_id: leadUniqueId,
    stage: leadStatus,
    lead_number: leadUniqueId,
    owner_name: assignedTo,
    owner_email: body.assignedToEmail ? String(body.assignedToEmail) : null,
    first_name: clientName,
    source: "CRM",
    sub_source: null,
    platform: "WhatsApp",
    fields: {},
  };

  const dripsEnrolled = await enrollDripsForLead(lead);

  return NextResponse.json({
    ok: true,
    sync,
    drips_enrolled: dripsEnrolled,
    lead: {
      mobile: mobileDigits,
      stage: leadStatus,
      assignedTo,
      clientName,
      leadUniqueId,
    },
    next:
      dripsEnrolled > 0
        ? "Drip enrolled. Wait ~30s for drip-tick to send Day-1 (or call /api/drips/tick)."
        : "No drip enrolled. Seed drips first (GET /api/admin/seed-task2-leak3-drip), confirm stage matches, assignedTo=Mehjabeen, and drip enabled.",
  });
}
