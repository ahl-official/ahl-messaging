// Post-confirmation side-effects for a booking. Best-effort: a failure here
// never undoes the confirmed booking. For the demo this delivers a plain text
// (works for Meta numbers inside the 24h window) and records it in the chat
// thread. Out-of-window template delivery + LSQ push land in the next stage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTextMessage, sendTemplate } from "@/lib/whatsapp";
import { broadcastInbox } from "@/lib/realtime-inbox";
import { getBookingConfirmTemplate } from "@/lib/app-settings";
import { resolveTemplateCreds } from "@/lib/template-creds";
import { renderTemplatePreview } from "@/lib/template-preview";
import type { BookingRow } from "@/lib/bookings";

/** The ACTUAL approved template text the patient received (header + body +
 *  footer, with {{1}}/{{2}} filled), so the dashboard bubble matches WhatsApp
 *  instead of showing a generic line. Null if it can't be fetched. */
async function renderSentTemplateText(
  phoneNumberId: string,
  tpl: { name: string; lang: string },
  components: unknown[],
): Promise<string | null> {
  try {
    const creds = await resolveTemplateCreds({ phoneNumberId });
    if (!creds) return null;
    const rendered = await renderTemplatePreview({
      waba_id: creds.waba,
      access_token: creds.token,
      body: {
        template: {
          name: tpl.name,
          language: { code: tpl.lang },
          components,
        },
      },
    });
    if (!rendered?.text) return null;
    return [rendered.header_text, rendered.text, rendered.footer]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return null;
  }
}

function formatDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Send the public booking link to the patient on WhatsApp + record it in the
 *  thread. Best-effort (Meta + open window). */
export async function sendBookingLink(
  admin: SupabaseClient,
  booking: BookingRow,
  link: string,
): Promise<void> {
  if (!booking.contact_id) return;
  const text = `Hello${
    booking.patient_name ? ` ${booking.patient_name}` : ""
  }! Tap the link below to choose your appointment date:\n${link}`;

  let wamid: string | null = null;
  if (booking.wa_id && booking.business_phone_number_id) {
    try {
      const res = await sendTextMessage(
        booking.wa_id,
        text,
        booking.business_phone_number_id,
      );
      wamid = res?.messages?.[0]?.id ?? null;
    } catch {
      /* out of window / non-Meta — recorded below */
    }
  }

  const nowIso = new Date().toISOString();
  await admin.from("messages").insert({
    contact_id: booking.contact_id,
    wa_message_id: wamid,
    direction: "outbound",
    type: "text",
    content: text,
    status: wamid ? "sent" : "pending",
    timestamp: nowIso,
    business_phone_number_id: booking.business_phone_number_id,
  });
  await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: "Booking link sent",
      last_message_direction: "outbound",
      last_message_status: wamid ? "sent" : "pending",
    })
    .eq("id", booking.contact_id);

  void broadcastInbox({
    business_phone_number_id: booking.business_phone_number_id,
    contact_id: booking.contact_id,
    wa_id: booking.wa_id,
    direction: "outbound",
  });
}

export async function notifyBookingConfirmed(
  admin: SupabaseClient,
  booking: BookingRow,
): Promise<void> {
  if (!booking.booking_date || !booking.contact_id) return;

  const dateStr = formatDate(booking.booking_date);
  const name = booking.patient_name?.trim() || "there";
  const text = `✅ Your appointment is confirmed for ${dateStr}. Thank you! — American Hairline`;

  // 1. Deliver to the patient. Prefer the configured UTILITY template (works
  //    OUTSIDE the 24h window with {{1}}=name, {{2}}=date); fall back to plain
  //    text (only delivers inside the window). The chat record below happens
  //    either way.
  let wamid: string | null = null;
  let msgType: "text" | "template" = "text";
  let content = text;
  if (booking.wa_id && booking.business_phone_number_id) {
    const tpl = await getBookingConfirmTemplate();
    if (tpl) {
      const components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: name },
            { type: "text", text: dateStr },
          ],
        },
      ];
      try {
        const res = await sendTemplate(
          booking.wa_id,
          tpl.name,
          tpl.lang,
          components,
          booking.business_phone_number_id,
        );
        wamid = res?.messages?.[0]?.id ?? null;
        if (wamid) {
          msgType = "template";
          // Show the patient's ACTUAL template text in the thread, not a
          // generic line; fall back to a neutral note if the fetch fails.
          content =
            (await renderSentTemplateText(
              booking.business_phone_number_id,
              tpl,
              components,
            )) ?? `Booking confirmation sent — ${name}, ${dateStr}.`;
        }
      } catch (e) {
        // Log WHY the template didn't go (e.g. Meta #132001 = template not on
        // THIS number's WABA, #132000 = param count mismatch, bad locale) so
        // the cause is visible in pm2 logs instead of a silent text fallback.
        console.error(
          `[booking-notify] template "${tpl.name}" (${tpl.lang}) failed on ${booking.business_phone_number_id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    if (!wamid) {
      try {
        const res = await sendTextMessage(
          booking.wa_id,
          text,
          booking.business_phone_number_id,
        );
        wamid = res?.messages?.[0]?.id ?? null;
      } catch {
        /* out of window / non-Meta provider — recorded below regardless */
      }
    }
  }

  // 2. Record it in the thread + refresh the inbox preview.
  const nowIso = new Date().toISOString();
  await admin.from("messages").insert({
    contact_id: booking.contact_id,
    wa_message_id: wamid,
    direction: "outbound",
    type: msgType,
    content,
    status: wamid ? "sent" : "pending",
    timestamp: nowIso,
    business_phone_number_id: booking.business_phone_number_id,
  });
  await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: content.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: wamid ? "sent" : "pending",
    })
    .eq("id", booking.contact_id);

  // 3. Instant inbox push (same broadcast the webhooks use).
  void broadcastInbox({
    business_phone_number_id: booking.business_phone_number_id,
    contact_id: booking.contact_id,
    wa_id: booking.wa_id,
    direction: "outbound",
  });
}
