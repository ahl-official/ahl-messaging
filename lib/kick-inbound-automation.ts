// Kick trigger flows + AI debounce as soon as an inbound WhatsApp message
// lands — in-process, no HTTP hop to /api/automation/process.
//
// Why: the Meta webhook used to fetch localhost (extra round-trip / possible
// hang). WAHA only stamped automation_pending_at and waited for the 30s
// sweep — so flow replies felt 30–60s late.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAutomationTestContactNumbers } from "@/lib/app-settings";
import { matchAndRunTriggers } from "@/lib/trigger-engine";

export async function kickInboundAutomation(params: {
  contactId: string;
  waId: string;
  bpid: string;
  inboundText: string;
  inboundType?: string;
  inboundMediaUrl?: string | null;
}): Promise<{ matched: boolean; aiEnqueued: boolean }> {
  const {
    contactId,
    waId,
    bpid,
    inboundText,
    inboundType = "",
    inboundMediaUrl = null,
  } = params;

  const mediaTypes = ["image", "video", "audio", "document", "sticker", "voice", "ptt"];
  const inboundHasMedia =
    Boolean(inboundMediaUrl) || mediaTypes.includes(inboundType);

  // 1) Trigger flows first — immediate reply path (no debounce).
  if (inboundText.trim() || inboundHasMedia) {
    try {
      const { matched } = await matchAndRunTriggers({
        contactId,
        waId,
        bpid,
        inboundText,
        inboundType,
        inboundMediaUrl,
      });
      if (matched) return { matched: true, aiEnqueued: false };
    } catch (e) {
      console.warn(
        "[kick-inbound] trigger match failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // 2) No flow matched → enqueue AI auto-reply (debounced).
  const admin = createServiceRoleClient();
  const { data: config } = await admin
    .from("automation_configs")
    .select("enabled, inbound_debounce_seconds")
    .eq("business_phone_number_id", bpid)
    .maybeSingle();

  if (!config?.enabled) return { matched: false, aiEnqueued: false };

  const testPatients = await getAutomationTestContactNumbers();
  if (testPatients.length > 0) {
    const patientWa = waId.replace(/\D/g, "");
    if (!testPatients.includes(patientWa)) {
      return { matched: false, aiEnqueued: false };
    }
  }

  const debounce = Math.max(
    0,
    Math.min(120, Number(config.inbound_debounce_seconds ?? 10)),
  );
  const processAt = new Date(Date.now() + debounce * 1000).toISOString();

  await admin
    .from("contacts")
    .update({ automation_pending_at: processAt })
    .eq("id", contactId);

  return { matched: false, aiEnqueued: true };
}
