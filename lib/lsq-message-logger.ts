// One-call helper to log a WhatsApp message onto an CRM lead's
// activity timeline. Used by both the inbound webhook and every
// outbound send path (manual reply, AI reply, Magic Message,
// templates) so every chat turn shows up in LSQ reporting.
//
// Always fire-and-forget — never block the user-visible send path
// on this. The function itself catches everything internally and
// only logs warnings to the server console.
//
// ActivityNote format:
//   "<role-prefix> : <message text> - (Insta WA <display_phone>)"
// where role-prefix is "Client" for Inbound, "AI Reply" when the bot
// sent it, and "Agent Reply" for everything else outbound. The "(Insta
// WA …)" suffix stays so existing LSQ Smart Views keep grouping.

import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getLsqConfig,
  lsqCreateActivity,
  lsqGetLeadByMobile,
} from "@/lib/lsq";

export type MessageDirection = "Inbound" | "Outbound";
/** Who actually sent the message. Drives the "Client : / AI Reply : /
 *  Agent Reply :" prefix on the LSQ activity note. Optional — defaults
 *  to "client" for Inbound and "agent" for Outbound. */
export type MessageSender = "client" | "ai" | "agent";

export interface LogWhatsappActivityInput {
  /** Internal contact UUID — we look up wa_id + lsq_prospect_id from
   *  here. Skip if neither is available. */
  contactId: string;
  /** Direction stamps the mx_Custom_2 custom field so LSQ reports can
   *  segment inbound vs outbound chat volume. */
  direction: MessageDirection;
  /** Plain-text message body. Empty / non-text payloads (image
   *  captions etc.) should pass a synthetic note like "[image] caption". */
  text: string;
  /** Optional — if provided, used to build the "(Insta WA <phone>)"
   *  suffix. Falls back to a lookup via business_phone_number_id. */
  businessPhoneNumberId?: string | null;
  /** When the message actually happened (ISO). Defaults to now. */
  timestamp?: string;
  /** Who originated the message — only the AI-reply path needs to
   *  pass this explicitly; everything else is derived from direction. */
  sender?: MessageSender;
}

export async function logWhatsappActivityToLSQ(
  input: LogWhatsappActivityInput,
): Promise<void> {
  const cfg = getLsqConfig();
  if (!cfg.configured) return;

  const admin = createServiceRoleClient();

  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, lsq_prospect_id, business_phone_number_id")
    .eq("id", input.contactId)
    .maybeSingle();
  if (!contact) return;

  // Interakt numbers never touch LSQ — no lead create, no re-attribution,
  // and no activity logging. They run their own CRM. (bpid is "interakt:".)
  const bpidForGate =
    input.businessPhoneNumberId ?? contact.business_phone_number_id ?? "";
  if (bpidForGate.startsWith("interakt:")) return;

  // Fallback: ensure-lead is fire-and-forget from the webhook, so the
  // very first inbound message for a brand-new contact can race ahead
  // of it and find no prospect_id cached. Before giving up, do a
  // synchronous phone-lookup against LSQ — if the lead already exists
  // (common: client is in CRM but new on WhatsApp), cache the
  // prospect_id back onto the contact so this branch self-heals from
  // message #1. Only the create-fresh case (genuinely-new lead) still
  // falls through to ensure-lead.
  let prospectId = contact.lsq_prospect_id as string | null;
  if (!prospectId && contact.wa_id) {
    try {
      const found = await lsqGetLeadByMobile(contact.wa_id);
      if (found.found && found.lead?.prospect_id) {
        prospectId = found.lead.prospect_id;
        await admin
          .from("contacts")
          .update({
            lsq_prospect_id: prospectId,
            lsq_synced_at: new Date().toISOString(),
          })
          .eq("id", contact.id);
      }
    } catch (e) {
      console.warn(
        "[lsq-msg] lead lookup failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }
  if (!prospectId) {
    // Still no lead — ensure-lead's create path will run async and
    // future messages will log. Skip this one rather than orphan it.
    return;
  }

  // Resolve the source business number for fallback formatting + the
  // automation_config row that holds the operator-defined suffix
  // (activity_note_suffix). Operator-typed text always wins; we only
  // auto-derive a "WhatsApp <last10>" suffix when nothing's configured.
  const phoneNumberId =
    input.businessPhoneNumberId ?? contact.business_phone_number_id ?? null;

  let configuredSuffix = "";
  let displayPhone = "";
  if (phoneNumberId) {
    const [{ data: cfg }, { data: bn }] = await Promise.all([
      admin
        .from("automation_configs")
        .select("activity_note_suffix, lsq_activity_log_enabled")
        .eq("business_phone_number_id", phoneNumberId)
        .maybeSingle(),
      admin
        .from("business_numbers")
        .select("display_phone_number, phone_number_id")
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle(),
    ]);
    // Capability gate — operator can disable activity-log push per
    // number. Default true so legacy rows behave unchanged.
    if (cfg && cfg.lsq_activity_log_enabled === false) {
      return;
    }
    configuredSuffix = (cfg?.activity_note_suffix ?? "").toString().trim();
    if (bn) {
      displayPhone =
        (bn.display_phone_number ?? "")
          .toString()
          .replace(/\D/g, "")
          .slice(-10) || bn.phone_number_id;
    }
  }

  // No-text messages (images without captions, stickers, location
  // pings, "unsupported" payloads from Meta) used to log a junk
  // "[no text] - (...)" activity on LSQ. Skip silently instead —
  // the photo pipeline / dedicated handlers cover the cases the
  // operator actually wants on the timeline.
  const trimmedText = (input.text ?? "").trim();
  if (!trimmedText) return;
  // 1st choice: whatever the operator typed in Automation → Activity
  //              Note Suffix. 2nd choice: auto-derived "WhatsApp <last10>"
  //              from the business number. 3rd choice: no suffix.
  const suffixContent = configuredSuffix || (displayPhone ? `WhatsApp ${displayPhone}` : "");
  const noteSuffix = suffixContent ? ` - (${suffixContent})` : "";

  // Role prefix — "Client : " for inbound, "AI Reply : " when the bot
  // generated it, "Agent Reply : " for operator-sent messages. Default
  // sender is derived from direction so existing call-sites don't have
  // to pass it.
  const sender: MessageSender =
    input.sender ?? (input.direction === "Inbound" ? "client" : "agent");
  const prefix =
    sender === "client"
      ? "Client"
      : sender === "ai"
        ? "AI Reply"
        : "Agent Reply";
  const note = `${prefix} : ${trimmedText}${noteSuffix}`;

  // ISO with seconds, formatted as LSQ expects ("yyyy-MM-dd HH:mm:ss"
  // — no timezone, naive local time). We pass the UTC clock to keep
  // ordering monotonic regardless of server tz.
  const ts = new Date(input.timestamp ?? Date.now())
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  try {
    const result = await lsqCreateActivity({
      prospectId,
      note,
      fields: [
        { SchemaName: "mx_Custom_1", Value: ts },
        { SchemaName: "mx_Custom_2", Value: input.direction },
      ],
    });
    if (!result.ok) {
      console.warn(
        `[lsq-msg] Activity create failed (${input.direction}, contact=${input.contactId}): ${result.error}`,
      );
    }
  } catch (e) {
    console.warn(
      "[lsq-msg] Activity create threw:",
      e instanceof Error ? e.message : e,
    );
  }
}
