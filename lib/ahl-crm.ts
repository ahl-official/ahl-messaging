// Server-only — create leads in the AHL Firebase CRM.

import type { createServiceRoleClient } from "@/lib/supabase/server";

export interface AhlEnsureLeadInput {
  mobileNo: string;
  clientName?: string;
  platform: string;
  callType: string;
  leadStatus: string;
  assignmentStatus: string;
  syncStatus: string;
  actor: string;
}

type Admin = ReturnType<typeof createServiceRoleClient>;

/** True when AHL Firebase CRM env is configured. */
export function isAhlCrmConfigured(): boolean {
  return !!(
    process.env.AHL_CRM_LEADS_URL?.trim() &&
    process.env.AHL_CRM_API_KEY?.trim()
  );
}

/** Create a lead in AHL CRM. Returns the CRM lead id, or null if skipped/failed. */
export async function ahlEnsureLead(
  input: AhlEnsureLeadInput,
): Promise<string | null> {
  const url = process.env.AHL_CRM_LEADS_URL?.trim();
  const key = process.env.AHL_CRM_API_KEY?.trim();
  if (!url || !key) return null;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return null;

  const json = (await res.json().catch(() => null)) as {
    leadId?: string;
    id?: string;
  } | null;

  const leadId = json?.leadId ?? json?.id ?? null;
  return leadId && String(leadId).trim() ? String(leadId).trim() : null;
}

/**
 * If the contact has no CRM ids yet and AHL Firebase is configured,
 * create a lead and store the id on `contacts.lsq_lead_number`.
 * Never throws — safe to call from webhooks.
 */
export async function ahlEnsureLeadForContact(
  admin: Admin,
  opts: {
    contactId: string;
    mobileNo: string;
    clientName?: string | null;
  },
): Promise<string | null> {
  if (!isAhlCrmConfigured()) return null;
  try {
    const { data: row } = await admin
      .from("contacts")
      .select("lsq_lead_number, lsq_prospect_id")
      .eq("id", opts.contactId)
      .maybeSingle();
    if (row?.lsq_lead_number || row?.lsq_prospect_id) return null;

    const leadId = await ahlEnsureLead({
      mobileNo: opts.mobileNo,
      clientName: opts.clientName?.trim() || undefined,
      platform: "WhatsApp",
      callType: "Incoming",
      leadStatus: "New Lead",
      assignmentStatus: "pending",
      syncStatus: "needs_assignment",
      actor: "system",
    });
    if (!leadId) return null;

    await admin
      .from("contacts")
      .update({ lsq_lead_number: leadId })
      .eq("id", opts.contactId);
    return leadId;
  } catch (e) {
    console.error(
      "[ahl-crm] ensure lead failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
