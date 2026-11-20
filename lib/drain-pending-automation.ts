// Claim due contacts.automation_pending_at rows and run AI.
// Used by /api/automation/process-pending and the in-process scheduler
// so a broken localhost HTTP tick can't leave replies sitting for minutes.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { runAutomation } from "@/lib/automation";
import { processPendingLeadAutomations } from "@/lib/lead-automation-engine";

const MAX_BATCH = 25;

export async function drainPendingAutomation(): Promise<{
  processed: number;
  skipped: number;
  leadAutomationResumed: number;
}> {
  const admin = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin
    .from("contacts")
    .select("id")
    .lte("automation_pending_at", nowIso)
    .order("automation_pending_at", { ascending: true })
    .limit(MAX_BATCH);
  if (error) {
    console.warn("[drain-pending] query failed:", error.message);
    return { processed: 0, skipped: 0, leadAutomationResumed: 0 };
  }
  if (!due || due.length === 0) {
    let leadAutomationResumed = 0;
    try {
      leadAutomationResumed = await processPendingLeadAutomations();
    } catch (e) {
      console.warn(
        "[drain-pending] lead automation resume failed:",
        e instanceof Error ? e.message : e,
      );
    }
    return { processed: 0, skipped: 0, leadAutomationResumed };
  }

  let processed = 0;
  let skipped = 0;
  for (const row of due) {
    const { data: claimed } = await admin
      .from("contacts")
      .update({ automation_pending_at: null })
      .eq("id", row.id)
      .lte("automation_pending_at", new Date().toISOString())
      .select("id");
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }

    const { data: lastInbound } = await admin
      .from("messages")
      .select("id")
      .eq("contact_id", row.id)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false })
      .limit(1);
    const triggerId = lastInbound?.[0]?.id as string | undefined;
    if (!triggerId) {
      skipped++;
      continue;
    }

    void runAutomation({
      contactId: row.id,
      triggerMessageId: triggerId,
    }).catch((e) => {
      console.error(
        "[drain-pending] runAutomation failed:",
        e instanceof Error ? e.message : e,
      );
    });
    processed++;
  }

  let leadAutomationResumed = 0;
  try {
    leadAutomationResumed = await processPendingLeadAutomations();
  } catch (e) {
    console.warn(
      "[drain-pending] lead automation resume failed:",
      e instanceof Error ? e.message : e,
    );
  }

  return { processed, skipped, leadAutomationResumed };
}
