// =====================================================================
// Interakt webhook — parallel inbound/outbound routing alongside Meta.
//
//   GET  /api/interakt/webhook/<secret>  → 200 (Interakt verify probe)
//   POST /api/interakt/webhook/<secret>  → ingest every Interakt event
//
// The <secret> in the URL is matched against app_settings
// ('interakt_webhook_secret'). Events are written into the SAME contacts
// / messages tables Meta uses, so the existing inbox renders Interakt
// chats with no UI changes. The Meta + Evolution paths are untouched.
//
// Interakt numbers get a synthetic phone_number_id of `interakt:<number>`
// (same convention as Evolution's `evo:<instance>`), auto-created on the
// first event. Always responds 200 so Interakt doesn't retry-storm.
// =====================================================================

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  resolveInteraktNumberBySecret,
  parseInteraktMessage,
  parseInteraktStatus,
  previewForInterakt,
  isStatusEvent,
} from "@/lib/interakt";
import { broadcastInbox } from "@/lib/realtime-inbox";
import { AI_SENDER_EMAIL } from "@/lib/automation";
import { getCredential } from "@/lib/credentials";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Marks an outbound row that arrived via the Interakt webhook but did NOT
// originate from our dashboard/AI (i.e. an agent replied from the Interakt
// panel). The human-takeover guard treats this like a real agent reply and
// pauses the bot — same as a dashboard send. Unlike Meta, Interakt echoes
// every outbound back to us, so we must attribute these explicitly.
const INTERAKT_AGENT_EMAIL = "interakt-agent";

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 99 };

export async function GET() {
  // Interakt (and a manual browser check) just want a 200 here.
  return new NextResponse("OK", { status: 200 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { secret: string } },
) {
  // The secret in the URL identifies WHICH Interakt number this event is
  // for (Interakt's payload only carries the customer number).
  const resolved = await resolveInteraktNumberBySecret(params.secret);
  if (!resolved) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Read once as text so we can both parse AND forward the exact payload.
  const rawText = await request.text();

  // Fan-out: forward the exact event to every operator-configured relay URL
  // (n8n, their own backend, etc.). Fire-and-forget — never blocks or fails
  // the 200 we owe Interakt.
  for (const url of resolved.forwardUrls) {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawText,
      signal: AbortSignal.timeout(10_000),
    }).catch((e) =>
      console.warn(`[interakt] forward to ${url} failed:`, e instanceof Error ? e.message : e),
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  try {
    await processInteraktEvent(body, resolved.phoneNumberId);
  } catch (err) {
    console.error(
      "[interakt] processing error:",
      err instanceof Error ? err.message : err,
    );
    // Still 200 so Interakt does not retry-storm us.
  }
  return new NextResponse("OK", { status: 200 });
}

async function processInteraktEvent(body: unknown, bpid: string) {
  const type = (body as { type?: string })?.type;
  const supabase = createServiceRoleClient();

  // ---- Status updates (sent / delivered / read / failed) ----
  if (isStatusEvent(type)) {
    const st = parseInteraktStatus(body);
    if (!st) return;
    const { data: existing } = await supabase
      .from("messages")
      .select("id, status")
      .eq("wa_message_id", st.messageId)
      .maybeSingle();
    if (!existing) return;
    const rank = STATUS_RANK[st.status] ?? 0;
    const curRank = existing.status
      ? STATUS_RANK[existing.status as keyof typeof STATUS_RANK] ?? 0
      : 0;
    if (st.status !== "failed" && rank <= curRank) return;
    await supabase
      .from("messages")
      .update({ status: st.status })
      .eq("wa_message_id", st.messageId);
    return;
  }

  // ---- Chat messages (inbound from customer, or outbound mirror) ----
  const msg = parseInteraktMessage(body);
  if (!msg) {
    console.warn(`[interakt] unhandled event type=${type ?? "?"}`);
    return;
  }

  // bpid is resolved from the webhook secret (which Interakt number this is).
  // Dedup — Interakt may retry. Skip if we already have this message id.
  if (msg.messageId) {
    const { data: dup } = await supabase
      .from("messages")
      .select("id")
      .eq("wa_message_id", msg.messageId)
      .maybeSingle();
    if (dup) return;
  }

  const direction = msg.isInbound ? "inbound" : "outbound";
  const preview = previewForInterakt(msg);

  const { data: contact, error: upsertErr } = await supabase
    .from("contacts")
    .upsert(
      {
        wa_id: msg.waId,
        profile_name: msg.profileName,
        // Inbound re-engagement reopens the chat (mirrors Meta webhook).
        ...(msg.isInbound ? { status: "open", last_inbound_at: msg.timestamp } : {}),
        last_message_at: msg.timestamp,
        last_message_preview: preview,
        last_message_direction: direction,
        last_message_status: msg.isInbound ? "received" : "sent",
        business_phone_number_id: bpid,
      },
      { onConflict: "wa_id,business_phone_number_id" },
    )
    .select("id, unread_count")
    .single();

  if (upsertErr || !contact) {
    console.error("[interakt] contact upsert failed:", upsertErr?.message);
    return;
  }

  if (msg.isInbound) {
    // Atomic unread bump (migration 0084) — no read-modify-write race.
    await supabase.rpc("bump_unread", { p_contact_id: contact.id });
  } else {
    // Outbound (incl. marketing template blasts). The 24h customer-service
    // window only OPENS on an inbound client message — an outbound never
    // does. So if this contact has no inbound in the last 24h, its window
    // is closed: mark it 'closed' so it stays out of the "Open" inbox.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contact.id)
      .eq("direction", "inbound")
      .gte("timestamp", cutoff);
    if (!count) {
      await supabase.from("contacts").update({ status: "closed" }).eq("id", contact.id);
    }
  }

  // Attribute outbound echoes. Interakt mirrors EVERY outbound (incl. our own
  // AI / dashboard sends and agent replies typed in the Interakt panel). If
  // this echo matches a send we already recorded (same text in the last 2 min),
  // inherit that row's sender so the AI never counts its own reply as a human
  // takeover. Otherwise it's an agent replying from the Interakt panel → mark
  // it as a human agent so the takeover guard pauses the bot.
  let outboundSender: string | null = null;
  if (!msg.isInbound) {
    outboundSender = INTERAKT_AGENT_EMAIL;
    const since = new Date(Date.now() - 120_000).toISOString();
    const body = (msg.content ?? "").trim();
    const { data: recent } = await supabase
      .from("messages")
      .select("sent_by_email, content")
      .eq("contact_id", contact.id)
      .eq("direction", "outbound")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false })
      .limit(8);
    const mine = (recent ?? []).find((r) => (r.content ?? "").trim() === body);
    if (mine) outboundSender = (mine.sent_by_email as string | null) ?? AI_SENDER_EMAIL;
  }

  const isTemplate = msg.kind === "template";
  const { data: insertedMsg, error: insertErr } = await supabase
    .from("messages")
    .insert({
      contact_id: contact.id,
      wa_message_id: msg.messageId,
      direction,
      type: msg.kind,
      content: msg.content,
      media_url: msg.mediaUrl,
      media_mime_type: msg.mediaMime,
      status: msg.isInbound ? "delivered" : "sent",
      timestamp: msg.timestamp,
      business_phone_number_id: bpid,
      sent_by_email: msg.isInbound ? null : outboundSender,
      // Template card metadata — drives the rendered template bubble.
      template_name: isTemplate ? msg.templateName ?? null : null,
      template_footer: isTemplate ? msg.templateFooter ?? null : null,
      template_buttons:
        isTemplate && msg.templateButtons && msg.templateButtons.length > 0
          ? msg.templateButtons
          : null,
      raw_payload: body as object,
    })
    .select("id")
    .single();
  // 23505 = duplicate wa_message_id (Interakt retried mid-insert) — ignore.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[interakt] insert message failed:", insertErr.message);
  }

  // AI bot + CRM lead push for inbound — ONLY for Interakt numbers explicitly
  // enabled in their automation_config. Most Interakt numbers run their own
  // CRM/routing and must stay untouched, so this is opt-in per number. Mirrors
  // the Meta webhook's fire-and-forget triggers.
  if (msg.isInbound && insertedMsg) {
    await fireInteraktBotAndLsq(supabase, bpid, contact.id, insertedMsg.id as string, msg);
  }

  // Campaign attribution (mirrors the Meta webhook). An inbound reply / button
  // tap on a recently-sent campaign template marks that recipient replied and
  // records the tapped button so the campaign's Button-clicks report populates.
  if (msg.isInbound) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentRecipient } = await supabase
      .from("campaign_recipients")
      .select("id, status, campaign_id")
      .eq("wa_id", msg.waId)
      .gte("sent_at", sevenDaysAgo)
      .in("status", ["sent", "delivered", "read"])
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentRecipient) {
      const buttonText = msg.buttonReply ?? null;
      const replyText = (msg.content ?? "").slice(0, 1000) || null;
      await supabase
        .from("campaign_recipients")
        .update({ status: "replied", replied_at: new Date().toISOString() })
        .eq("id", recentRecipient.id);
      const extras: Record<string, unknown> = {};
      if (replyText) extras.reply_text = replyText;
      if (buttonText) {
        extras.button_clicked = buttonText;
        extras.button_clicked_at = new Date().toISOString();
      }
      if (Object.keys(extras).length > 0) {
        await supabase.from("campaign_recipients").update(extras).eq("id", recentRecipient.id).then(
          () => {},
          () => {},
        );
      }
      if (recentRecipient.campaign_id) {
        const { recomputeCounters } = await import("@/lib/campaigns");
        await recomputeCounters(recentRecipient.campaign_id as string).catch(() => {});
      }
    }
  }

  // Live-push the inbox the instant the message lands. See lib/realtime-inbox.
  void broadcastInbox({
    business_phone_number_id: bpid,
    contact_id: contact.id,
    wa_id: msg.waId,
    direction,
  });
}

// Fire the AI bot + CRM lead-push for an inbound Interakt message — gated on
// the number's automation_config being enabled, so unmanaged Interakt numbers
// stay exactly as before (no bot, no LSQ). Fire-and-forget, mirrors the Meta
// webhook. The downstream routes re-check `enabled` / `lsq_lead_create_enabled`.
async function fireInteraktBotAndLsq(
  supabase: SupabaseClient,
  bpid: string,
  contactId: string,
  triggerMessageId: string,
  msg: ReturnType<typeof parseInteraktMessage>,
) {
  if (!msg) return;
  const { data: cfg } = await supabase
    .from("automation_configs")
    .select("enabled")
    .eq("business_phone_number_id", bpid)
    .maybeSingle();
  if (!cfg?.enabled) return; // opt-in only

  const internalToken = await getCredential("webhook_internal_token");
  if (!internalToken) return;
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const json = { "Content-Type": "application/json" };

  // Audio inbound gets no immediate bot trigger (no transcribed text yet).
  const isAudio = msg.kind === "audio" || (msg.mediaMime ?? "").startsWith("audio/");
  if (!isAudio) {
    void fetch(`${origin}/api/automation/process`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ contact_id: contactId, trigger_message_id: triggerMessageId, token: internalToken }),
    }).catch((e) => console.error("[interakt] automation trigger failed:", e instanceof Error ? e.message : e));
  }

  void fetch(`${origin}/api/lsq/ensure-lead`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ contact_id: contactId, token: internalToken }),
  }).catch((e) => console.error("[interakt] LSQ ensure-lead failed:", e instanceof Error ? e.message : e));

  if (msg.kind === "image" && msg.mediaUrl) {
    void fetch(`${origin}/api/lsq/photo-received`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        contact_id: contactId,
        media_url: msg.mediaUrl,
        media_mime: msg.mediaMime,
        timestamp: msg.timestamp,
        token: internalToken,
      }),
    }).catch((e) => console.error("[interakt] LSQ photo pipeline failed:", e instanceof Error ? e.message : e));
  }
}
