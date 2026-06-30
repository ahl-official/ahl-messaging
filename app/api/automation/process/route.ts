import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { getAutomationTestContactNumbers } from "@/lib/app-settings";

export const runtime = "nodejs";

interface Body {
  contact_id?: string;
  trigger_message_id?: string;
  /** Shared secret so only the webhook can invoke this route. */
  token?: string;
}

// =====================================================================
// POST /api/automation/process
//
// Webhook-called enqueue endpoint. Instead of firing the LLM right
// away, we set `contacts.automation_pending_at = now() + debounce`. Any
// subsequent inbound message within the window resets the timestamp.
// Once the window settles, /api/automation/process-pending picks up the
// row, atomically claims it, and runs the LLM ONCE on the combined
// recent-message context — so a patient typing 4 quick messages gets
// one consolidated reply instead of 4 racing ones.
// =====================================================================
export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set in .env.local" },
      { status: 500 },
    );
  }
  if (body.token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contactId = body.contact_id?.trim();
  if (!contactId) {
    return NextResponse.json(
      { error: "contact_id is required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("wa_id, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact?.business_phone_number_id) {
    return NextResponse.json({ skipped: "contact_not_found" });
  }

  // ---- Trigger flows ----
  // Keyword rules run independently of the AI bot — they fire whether or
  // not AI auto-reply is enabled. A matched flow handles the reply, so we
  // skip the AI pass below to avoid a double response.
  const triggerMessageId = body.trigger_message_id?.trim();
  if (triggerMessageId) {
    const { data: msg } = await admin
      .from("messages")
      .select("content, type, media_url")
      .eq("id", triggerMessageId)
      .maybeSingle();
    const inboundText = (msg?.content as string | null) ?? "";
    const inboundType = (msg?.type as string | null) ?? "";
    const inboundMediaUrl = (msg?.media_url as string | null) ?? null;
    const mediaTypes = ["image", "video", "audio", "document", "sticker", "voice", "ptt"];
    const inboundHasMedia = Boolean(inboundMediaUrl) || mediaTypes.includes(inboundType);
    // Run on text OR media — an image-only reply must still resume a flow
    // that's waiting for the patient to send photos.
    if (inboundText.trim() || inboundHasMedia) {
      try {
        const { matchAndRunTriggers } = await import("@/lib/trigger-engine");
        const { matched } = await matchAndRunTriggers({
          contactId,
          waId: contact.wa_id ?? "",
          bpid: contact.business_phone_number_id,
          inboundText,
          inboundType,
          inboundMediaUrl,
        });
        if (matched) return NextResponse.json({ trigger: "matched" });
      } catch (e) {
        console.warn("[triggers] match failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  const { data: config } = await admin
    .from("automation_configs")
    .select("enabled, inbound_debounce_seconds")
    .eq("business_phone_number_id", contact.business_phone_number_id)
    .maybeSingle();
  if (!config?.enabled) {
    return NextResponse.json({ skipped: "automation_disabled" });
  }

  // Test-mode patient whitelist — when set, the bot replies ONLY to
  // these patient numbers (operator's own phone + testers). Lets a
  // freshly trained bot live-test on the production WhatsApp number
  // without exposing real customers to wrong answers.
  const testPatients = await getAutomationTestContactNumbers();
  if (testPatients.length > 0) {
    const patientWa = (contact.wa_id ?? "").replace(/\D/g, "");
    if (!testPatients.includes(patientWa)) {
      return NextResponse.json({ skipped: "not_in_test_patients" });
    }
  }

  // Debounce window is operator-set per number. Clamp so a misconfigured
  // value can't park a contact for hours.
  const debounce = Math.max(
    0,
    Math.min(120, Number(config.inbound_debounce_seconds ?? 10)),
  );
  const processAt = new Date(Date.now() + debounce * 1000).toISOString();

  const { error } = await admin
    .from("contacts")
    .update({ automation_pending_at: processAt })
    .eq("id", contactId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ enqueued: true, process_at: processAt });
}
