// Apply AHL Firebase CRM lead updates onto oneinbox contacts.
// Match by trailing 10 digits of mobile (same approach as LSQ webhook).

import { createServiceRoleClient } from "@/lib/supabase/server";

export type AhlCrmLeadSyncPayload = {
  mobileNo?: string | null;
  leadUniqueId?: string | null;
  leadStatus?: string | null;
  assignedTo?: string | null;
  /** Optional email if CRM ever sends it */
  assignedToEmail?: string | null;
  clientName?: string | null;
};

function digitsOnly(v: string): string {
  return v.replace(/\D/g, "");
}

function last10(mobile: string): string | null {
  const d = digitsOnly(mobile);
  if (d.length < 10) return null;
  return d.slice(-10);
}

/** Resolve CRM assignee display name / email → team_members row.
 *  Firebase round-robin stores display names ("Rahul", "Mehjabeen");
 *  inbox "LSQ-assigned only" filters on team_members.email — so we must
 *  map name → login email here. */
export async function resolveTeamMember(
  admin: ReturnType<typeof createServiceRoleClient>,
  assignedTo: string | null | undefined,
  assignedToEmail: string | null | undefined,
): Promise<{ user_id: string | null; email: string | null; name: string | null } | null> {
  const email = (assignedToEmail ?? "").trim().toLowerCase();
  if (email) {
    const { data } = await admin
      .from("team_members")
      .select("user_id, email, full_name, first_name")
      .ilike("email", email)
      .eq("is_active", true)
      .maybeSingle();
    if (data) {
      return {
        user_id: (data as { user_id: string | null }).user_id,
        email: (data as { email: string }).email,
        name: (data as { full_name?: string | null }).full_name ?? null,
      };
    }
  }

  const name = (assignedTo ?? "").trim();
  if (!name) return null;

  const { data: rows } = await admin
    .from("team_members")
    .select("user_id, email, full_name, first_name")
    .eq("is_active", true)
    .limit(200);

  const needle = name.toLowerCase();
  const match = ((rows ?? []) as Array<{
    user_id: string | null;
    email: string;
    full_name: string | null;
    first_name: string | null;
  }>).find((r) => {
    const full = (r.full_name ?? "").trim().toLowerCase();
    const first = (r.first_name ?? "").trim().toLowerCase();
    if (full && (full === needle || full.startsWith(needle) || needle.startsWith(full))) {
      return true;
    }
    if (first && first === needle) return true;
    // "Mehjabeen" vs "Mehjabeen Something"
    if (full && full.split(/\s+/)[0] === needle) return true;
    return false;
  });

  if (!match) return null;
  return { user_id: match.user_id, email: match.email, name: match.full_name };
}

/**
 * Mirror CRM stage + assignee onto matching WhatsApp contacts.
 * Returns how many contact rows were updated.
 */
export async function applyAhlCrmLeadToContacts(
  payload: AhlCrmLeadSyncPayload,
): Promise<{ updated: number; matchedIds: string[] }> {
  const mobile = String(payload.mobileNo ?? "").trim();
  const ten = last10(mobile);
  if (!ten) return { updated: 0, matchedIds: [] };

  const admin = createServiceRoleClient();
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, name, assigned_to, assigned_to_email")
    .ilike("wa_id", `%${ten}`);

  const list = (contacts ?? []) as Array<{
    id: string;
    name: string | null;
    assigned_to: string | null;
    assigned_to_email: string | null;
  }>;
  if (list.length === 0) return { updated: 0, matchedIds: [] };

  const member = await resolveTeamMember(
    admin,
    payload.assignedTo,
    payload.assignedToEmail,
  );

  const patch: Record<string, unknown> = {
    lsq_last_sync_at: new Date().toISOString(),
  };

  const stage = String(payload.leadStatus ?? "").trim();
  if (stage) patch.lsq_stage = stage;

  const leadId = String(payload.leadUniqueId ?? "").trim();
  if (leadId) patch.lsq_lead_number = leadId;

  const ownerName = String(payload.assignedTo ?? "").trim();
  if (ownerName) patch.lsq_owner_name = ownerName;

  if (member?.email) {
    patch.lsq_owner_email = member.email.toLowerCase();
    patch.assigned_to_email = member.email.toLowerCase();
    if (member.user_id) {
      patch.assigned_to = member.user_id;
      patch.assigned_at = new Date().toISOString();
    }
  } else if (ownerName) {
    // Keep owner name even if we can't map to a team login yet.
    patch.lsq_owner_email = null;
  }

  const ids = list.map((c) => c.id);
  const { error } = await admin.from("contacts").update(patch).in("id", ids);
  if (error) {
    console.error("[ahl-crm-sync] contact update failed:", error.message);
    return { updated: 0, matchedIds: [] };
  }

  const clientName = String(payload.clientName ?? "").trim();
  if (clientName) {
    const nameless = list.filter((c) => !(c.name ?? "").trim()).map((c) => c.id);
    if (nameless.length > 0) {
      await admin.from("contacts").update({ name: clientName }).in("id", nameless);
    }
  }

  return { updated: ids.length, matchedIds: ids };
}
