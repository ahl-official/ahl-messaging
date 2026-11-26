// Kick trigger flows + AI debounce as soon as an inbound WhatsApp message
// lands — in-process, no HTTP hop to /api/automation/process.
//
// Why: the Meta webhook used to fetch localhost (extra round-trip / possible
// hang). WAHA only stamped automation_pending_at and waited for the 30s
// sweep — so flow replies felt 30–60s late.

import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getAutomationTestContactNumbers,
  isAutomationTestContactAllowed,
} from "@/lib/app-settings";
import { matchAndRunTriggers } from "@/lib/trigger-engine";

/** Keep floating AI-drain promises reachable so Next/PM2 don't GC them
 *  after the webhook response returns (unref'd timers were dying → ~3–4
 *  min stalls until an external cron picked the row up). */
const g = globalThis as typeof globalThis & {
  __oneinboxPendingAi?: Set<Promise<void>>;
};
function trackPendingAi(p: Promise<void>) {
  const set = (g.__oneinboxPendingAi ??= new Set());
  set.add(p);
  void p.finally(() => set.delete(p));
}

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

  const admin = createServiceRoleClient();

  // 0) Booking / slot / call signals → auto Task for CRM agent (Mantasha
  //    pilot via DRIP_PILOT_OWNER). Fire-and-forget; never blocks flows.
  if (inboundText.trim()) {
    void import("@/lib/booking-auto-task")
      .then(({ maybeCreateBookingTask }) =>
        maybeCreateBookingTask({
          contactId,
          waId,
          bpid,
          inboundText,
        }),
      )
      .catch((e) => {
        console.warn(
          "[kick-inbound] booking-auto-task failed:",
          e instanceof Error ? e.message : e,
        );
      });
  }

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
      if (matched) {
        // Cancel any pending AI debounce from an earlier inbound.
        await admin
          .from("contacts")
          .update({ automation_pending_at: null })
          .eq("id", contactId);
        return { matched: true, aiEnqueued: false };
      }
    } catch (e) {
      console.warn(
        "[kick-inbound] trigger match failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // 2) No flow matched → enqueue AI auto-reply (debounced).
  const aiEnqueued = await enqueueAiAutoReply({ contactId, waId, bpid });
  return { matched: false, aiEnqueued };
}

/**
 * Enqueue the AI advisor for this contact (debounced). Used when intake is
 * done and the client just shared a freeform query / voice note — the flow
 * must release so AI can answer, guide, or hand off to a human.
 */
export async function enqueueAiAutoReply(params: {
  contactId: string;
  waId: string;
  bpid: string;
  /** Smaller debounce for post-intake query replies (default 1s). */
  debounceSeconds?: number;
}): Promise<boolean> {
  const { contactId, waId, bpid } = params;
  const admin = createServiceRoleClient();

  const { data: config } = await admin
    .from("automation_configs")
    .select("enabled, inbound_debounce_seconds")
    .eq("business_phone_number_id", bpid)
    .maybeSingle();

  if (!config?.enabled) return false;

  const testPatients = await getAutomationTestContactNumbers();
  if (!isAutomationTestContactAllowed(waId, testPatients)) {
    return false;
  }

  const configured = Math.max(
    0,
    Math.min(5, Number(config.inbound_debounce_seconds ?? 3)),
  );
  const debounce =
    params.debounceSeconds != null
      ? Math.max(0, Math.min(5, params.debounceSeconds))
      : configured;
  const processAt = new Date(Date.now() + debounce * 1000).toISOString();

  await admin
    .from("contacts")
    .update({ automation_pending_at: processAt })
    .eq("id", contactId);

  trackPendingAi(runAiAfterDebounce(contactId, debounce));
  scheduleProcessPendingWake(debounce);
  return true;
}

async function runAiAfterDebounce(
  contactId: string,
  debounceSeconds: number,
): Promise<void> {
  const waitMs = Math.max(0, debounceSeconds) * 1000 + 150;
  await new Promise<void>((resolve) => {
    // Do NOT unref — unref'd timers were the ~4 min late-reply bug.
    setTimeout(resolve, waitMs);
  });

  try {
    const admin = createServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: claimed } = await admin
      .from("contacts")
      .update({ automation_pending_at: null })
      .eq("id", contactId)
      .lte("automation_pending_at", nowIso)
      .select("id");
    if (!claimed || claimed.length === 0) return; // extended / already claimed

    const { data: lastInbound } = await admin
      .from("messages")
      .select("id")
      .eq("contact_id", contactId)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false })
      .limit(1);
    const triggerId = lastInbound?.[0]?.id as string | undefined;
    if (!triggerId) return;

    const { runAutomation } = await import("@/lib/automation");
    await runAutomation({
      contactId,
      triggerMessageId: triggerId,
    });
  } catch (e) {
    console.warn(
      "[kick-inbound] in-process AI failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Fire /api/automation/process-pending shortly after the debounce window. */
function scheduleProcessPendingWake(debounceSeconds: number) {
  const token = (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
  if (!token) return;
  const origin =
    process.env.INTERNAL_TICK_BASE ||
    `http://127.0.0.1:${process.env.PORT || "3001"}`;
  const waitMs = Math.max(0, debounceSeconds) * 1000 + 300;
  const t = setTimeout(() => {
    void fetch(`${origin}/api/automation/process-pending`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    }).catch(() => {
      /* instrumentation interval is the backup */
    });
  }, waitMs);
  // Keep this one referenced via the fetch promise; unref OK as backup only.
  t.unref?.();
}
