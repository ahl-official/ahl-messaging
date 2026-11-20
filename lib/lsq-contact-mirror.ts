// Mirror CRM lead stage + owner onto a One Inbox contact row.
// Used by inbound ensure-lead (so new chats don't sit as Unassigned /
// blank stage until someone opens the details panel) and by the
// contact-panel lead refresh.

import { createServiceRoleClient } from "@/lib/supabase/server";
import type { LsqLeadView } from "@/lib/lsq";
import { resolveTeamMember } from "@/lib/ahl-crm-sync";

type Admin = ReturnType<typeof createServiceRoleClient>;

export async function mirrorLsqLeadOntoContact(
  admin: Admin,
  contactId: string,
  lead: Pick<
    LsqLeadView,
    | "prospect_id"
    | "lead_number"
    | "status"
    | "owner_name"
    | "owner_email"
    | "source"
    | "sub_source"
    | "source_medium"
    | "first_name"
  >,
  opts?: {
    /** Used when LSQ has no ProspectStage yet (brand-new lead). */
    defaultStage?: string | null;
    /** Also set contacts.name from LSQ first name when local name empty. */
    fillNameIfEmpty?: boolean;
  },
): Promise<void> {
  const stage =
    String(lead.status ?? "").trim() ||
    String(opts?.defaultStage ?? "").trim() ||
    null;

  const patch: Record<string, unknown> = {
    lsq_prospect_id: lead.prospect_id,
    lsq_lead_number: lead.lead_number,
    lsq_last_sync_at: new Date().toISOString(),
    lsq_synced_at: new Date().toISOString(),
  };
  if (stage) patch.lsq_stage = stage;
  if (lead.owner_name) patch.lsq_owner_name = lead.owner_name;
  if (lead.source) patch.lsq_source = lead.source;
  if (lead.sub_source) patch.lsq_sub_source = lead.sub_source;
  if (lead.source_medium) patch.utm_source = lead.source_medium;

  const member = await resolveTeamMember(
    admin,
    lead.owner_name,
    lead.owner_email,
  );
  if (member?.email) {
    const email = member.email.toLowerCase();
    patch.lsq_owner_email = email;
    patch.assigned_to_email = email;
    if (member.user_id) {
      patch.assigned_to = member.user_id;
      patch.assigned_at = new Date().toISOString();
    }
  } else if (lead.owner_email?.trim()) {
    const email = lead.owner_email.trim().toLowerCase();
    patch.lsq_owner_email = email;
    patch.assigned_to_email = email;
  }

  if (opts?.fillNameIfEmpty) {
    const first = String(lead.first_name ?? "").trim();
    if (first) {
      const { data: row } = await admin
        .from("contacts")
        .select("name")
        .eq("id", contactId)
        .maybeSingle();
      if (!(row?.name as string | null | undefined)?.trim()) {
        patch.name = first;
      }
    }
  }

  const { error } = await admin
    .from("contacts")
    .update(patch)
    .eq("id", contactId);
  if (error) {
    console.warn(
      `[lsq-mirror] contact ${contactId} update failed: ${error.message}`,
    );
  }
}

/**
 * Re-fetch the lead by phone and mirror onto the contact. Safe to call
 * fire-and-forget a few seconds after ensure-lead so round-robin
 * assignment that lands just after create still shows up in the inbox.
 */
export async function refreshContactFromLsqByPhone(
  contactId: string,
  waId: string,
  opts?: { defaultStage?: string | null },
): Promise<void> {
  const { lsqGetLeadByMobile } = await import("@/lib/lsq");
  const admin = createServiceRoleClient();
  const result = await lsqGetLeadByMobile(waId);
  if (!result.found || !result.lead) return;
  await mirrorLsqLeadOntoContact(admin, contactId, result.lead, {
    defaultStage: opts?.defaultStage ?? "New Lead",
    fillNameIfEmpty: true,
  });
}
