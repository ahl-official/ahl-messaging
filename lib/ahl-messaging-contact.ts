// Ensure a WhatsApp contact exists on the AHL Messaging (Meta Cloud API)
// number so Task 2 drips can enroll CRM leads that never messaged that line.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveTeamMember } from "@/lib/ahl-crm-sync";

/** Meta Cloud API phone_number_id for AHL Messaging (+91 73041 89059). */
export const AHL_MESSAGING_BPID =
  (process.env.AHL_MESSAGING_BPID || "").trim() || "1198859879988526";

function digitsOnly(v: string): string {
  return v.replace(/\D/g, "");
}

/** Normalize to India WhatsApp wa_id: 91 + last 10 digits. */
export function normalizeWaId(mobile: string): string | null {
  const d = digitsOnly(mobile);
  if (d.length < 10) return null;
  const ten = d.slice(-10);
  return `91${ten}`;
}

export type EnsureAhlMessagingContactInput = {
  mobile: string;
  name?: string | null;
  stage?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  prospectId?: string | null;
  leadNumber?: string | null;
};

/**
 * Find or create a contact on AHL Messaging for this mobile.
 * Used before drip enroll so CRM-only leads still get a send target.
 */
export async function ensureAhlMessagingContact(
  input: EnsureAhlMessagingContactInput,
): Promise<{ id: string; wa_id: string; name: string | null; created: boolean } | null> {
  const waId = normalizeWaId(input.mobile);
  if (!waId) return null;

  const admin = createServiceRoleClient();
  const bpid = AHL_MESSAGING_BPID;

  const { data: existing } = await admin
    .from("contacts")
    .select("id, wa_id, name")
    .eq("business_phone_number_id", bpid)
    .eq("wa_id", waId)
    .maybeSingle();

  const member = await resolveTeamMember(admin, input.ownerName, input.ownerEmail);

  const patch: Record<string, unknown> = {
    lsq_last_sync_at: new Date().toISOString(),
  };
  const stage = (input.stage ?? "").trim();
  if (stage) patch.lsq_stage = stage;
  const leadNumber = (input.leadNumber ?? "").trim();
  if (leadNumber) patch.lsq_lead_number = leadNumber;
  const prospectId = (input.prospectId ?? "").trim();
  if (prospectId) patch.lsq_prospect_id = prospectId;
  const ownerName = (input.ownerName ?? "").trim();
  if (ownerName) patch.lsq_owner_name = ownerName;
  if (member?.email) {
    patch.lsq_owner_email = member.email.toLowerCase();
    patch.assigned_to_email = member.email.toLowerCase();
    if (member.user_id) {
      patch.assigned_to = member.user_id;
      patch.assigned_at = new Date().toISOString();
    }
  }

  if (existing) {
    const name = (input.name ?? "").trim();
    if (name && !(existing.name as string | null)?.trim()) {
      patch.name = name;
    }
    if (Object.keys(patch).length > 1) {
      await admin.from("contacts").update(patch).eq("id", existing.id);
    }
    return {
      id: existing.id as string,
      wa_id: existing.wa_id as string,
      name: (patch.name as string | undefined) ?? (existing.name as string | null),
      created: false,
    };
  }

  const name = (input.name ?? "").trim() || null;
  const { data: created, error } = await admin
    .from("contacts")
    .insert({
      wa_id: waId,
      business_phone_number_id: bpid,
      name,
      profile_name: name,
      status: "open",
      ...patch,
    })
    .select("id, wa_id, name")
    .single();

  if (error || !created) {
    console.error("[ahl-messaging-contact] create failed:", error?.message);
    return null;
  }

  return {
    id: created.id as string,
    wa_id: created.wa_id as string,
    name: created.name as string | null,
    created: true,
  };
}
