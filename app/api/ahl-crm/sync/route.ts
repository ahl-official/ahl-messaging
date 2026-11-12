// Firebase CRM → oneinbox stage/assignee sync.
//
//   POST /api/ahl-crm/sync
//   Authorization: Bearer <WEBHOOK_INTERNAL_TOKEN>
//   Body JSON:
//   {
//     "mobileNo": "9198…",
//     "leadUniqueId": "Lead ID - 26474",
//     "leadStatus": "New Lead",
//     "assignedTo": "Mehjabeen",
//     "assignedToEmail": "optional@…",
//     "clientName": "optional"
//   }
//
// Call this from Firebase createLead/updateLead (and sheet assign if needed).

import { NextResponse, type NextRequest } from "next/server";
import { applyAhlCrmLeadToContacts } from "@/lib/ahl-crm-sync";

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
    message: "AHL CRM → oneinbox sync endpoint",
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

  const result = await applyAhlCrmLeadToContacts({
    mobileNo: (body.mobileNo as string) ?? null,
    leadUniqueId: (body.leadUniqueId as string) ?? null,
    leadStatus: (body.leadStatus as string) ?? null,
    assignedTo: (body.assignedTo as string) ?? null,
    assignedToEmail: (body.assignedToEmail as string) ?? null,
    clientName: (body.clientName as string) ?? null,
  });

  return NextResponse.json({
    ok: true,
    updated: result.updated,
    matchedIds: result.matchedIds,
  });
}
