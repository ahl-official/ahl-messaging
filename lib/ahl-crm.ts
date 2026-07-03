// Server-only — create leads in the AHL Firebase CRM.

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
