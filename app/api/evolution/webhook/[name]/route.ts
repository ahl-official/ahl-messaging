// POST /api/evolution/webhook/[name]
//
// Endpoint Evolution API posts events to. The instance name in the
// path tells us which business_numbers row to attach inbound rows
// to — Evolution doesn't include workspace context. Auth is implicit:
// the URL is only known to Evolution (set at instance create time)
// and the column is unique on our side.
//
// Events handled:
//   • CONNECTION_UPDATE  — update evolution_connection_state + JID
//   • QRCODE_UPDATED     — log only (UI polls the GET endpoint
//                          instead of subscribing here)
//   • MESSAGES_UPSERT    — new inbound (or our own outbound echo) →
//                          insert into messages + upsert contact
//   • MESSAGES_UPDATE    — status update (delivery_ack / read_ack /
//                          edited)  → patch messages row by wa_message_id
//   • MESSAGES_DELETE    — patch deleted_at on local row
//
// Anything else is logged and ignored so a new Evolution release that
// adds events doesn't crash us.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { jidToWaId } from "@/lib/evolution";
import {
  handleMessageUpsert,
  mapEvolutionStatus,
  type EvoMessageData,
} from "./ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EvoBaseEvent {
  event: string;
  instance?: string;
  data?: Record<string, unknown>;
  date_time?: string;
  destination?: string;
  server_url?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  let evt: EvoBaseEvent;
  try {
    evt = (await request.json()) as EvoBaseEvent;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Evolution sometimes posts a confirmation `{ instance, ... }` body
  // without an `event` field at webhook-set time. Acknowledge silently.
  if (!evt.event) return NextResponse.json({ ok: true });

  const admin = createServiceRoleClient();

  // Resolve the local business_numbers row once — every event needs it.
  const { data: bn } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, evolution_jid, evolution_instance_name, evolution_api_key, provider",
    )
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (!bn || bn.provider !== "evolution") {
    // Unknown instance — surface a 200 so Evolution doesn't retry-bomb
    // us, but log for diagnosis.
    console.warn("[evolution-webhook] unknown instance:", name);
    return NextResponse.json({ ok: true, ignored: true });
  }
  const bpid = bn.phone_number_id;
  // Credentials for pulling + persisting media (null when the instance
  // row is missing a key — then we just keep the raw expiring url).
  const evo =
    bn.evolution_instance_name && bn.evolution_api_key
      ? {
          instanceName: bn.evolution_instance_name as string,
          apiKey: bn.evolution_api_key as string,
        }
      : null;

  try {
    switch (evt.event) {
      case "connection.update":
      case "CONNECTION_UPDATE":
        await handleConnectionUpdate(admin, bpid, name, evt.data);
        break;
      case "qrcode.updated":
      case "QRCODE_UPDATED":
        // UI polls GET endpoint for the QR — no state change needed here.
        break;
      case "messages.upsert":
      case "MESSAGES_UPSERT":
        await handleMessageUpsert(admin, bpid, evt.data, evo);
        break;
      case "messaging-history.set":
      case "MESSAGING_HISTORY_SET":
        // Bulk historical sync after a QR scan with syncFullHistory:true.
        // Payload shape is the same { messages: [...] } chunk we already
        // know how to ingest — handleMessageUpsert iterates the array and
        // dedupes by wa_message_id so chunks overlapping with regular
        // inbound traffic are safe.
        await handleMessageUpsert(admin, bpid, evt.data, evo);
        break;
      case "messages.update":
      case "MESSAGES_UPDATE":
        await handleMessageUpdate(admin, bpid, evt.data);
        break;
      case "messages.delete":
      case "MESSAGES_DELETE":
        await handleMessageDelete(admin, bpid, evt.data);
        break;
      case "contacts.upsert":
      case "CONTACTS_UPSERT":
      case "contacts.update":
      case "CONTACTS_UPDATE":
        await handleContactsUpsert(admin, bpid, evt.data);
        break;
      case "send.message":
      case "SEND_MESSAGE":
        // Our own outbound send confirmation — we already mirror sends
        // when we call sendText/sendMedia, so this is informational.
        break;
      case "call":
      case "CALL":
      case "call.upsert":
      case "CALL_UPSERT":
        // Evolution call events are DISABLED. They created contacts for
        // @lid/privacy callers (non-real "numbers") that cluttered the inbox.
        // The inbox now only shows real numbers from actual messages.
        // (Re-enable by restoring handleIncomingCall(admin, bpid, evt.data).)
        break;
      case "chats.upsert":
      case "CHATS_UPSERT":
      case "chats.update":
      case "CHATS_UPDATE":
        await handleChatsUpdate(admin, bpid, evt.data);
        break;
      default:
        console.log("[evolution-webhook] ignored event:", evt.event);
    }
  } catch (e) {
    // Don't 500 — Evolution's retry policy would re-deliver and cause
    // duplicates. Log and ack.
    console.error(
      "[evolution-webhook] handler failed for",
      evt.event,
      e instanceof Error ? e.message : e,
    );
  }

  return NextResponse.json({ ok: true });
}

// ----------------------------------------------------------------- //
// Handlers                                                           //
// ----------------------------------------------------------------- //

type Admin = ReturnType<typeof createServiceRoleClient>;

async function handleConnectionUpdate(
  admin: Admin,
  bpid: string,
  instanceName: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  const state = (data?.state ?? data?.status) as
    | "open"
    | "connecting"
    | "close"
    | undefined;
  if (!state) return;

  // Evolution's payload on `open` includes the owner JID + profile info.
  const wuid =
    (data?.wuid as string | undefined) ??
    (data?.owner as string | undefined) ??
    null;
  const profileName = (data?.profileName as string | undefined) ?? null;
  const profilePictureUrl =
    (data?.profilePictureUrl as string | undefined) ?? null;

  const patch: Record<string, unknown> = {
    evolution_connection_state: state,
    evolution_last_state_at: new Date().toISOString(),
  };
  if (state === "open" && wuid) {
    patch.evolution_jid = wuid;
    patch.display_phone_number = `+${jidToWaId(wuid)}`;
    if (profileName) patch.verified_name = profileName;
    // Evolution sometimes ships the profile pic URL right inside the
    // CONNECTION_UPDATE payload (Baileys ships it when the linked
    // device handshake includes it). When it does, cache it so the
    // dashboard avatar doesn't have to do an extra round-trip.
    if (profilePictureUrl) patch.profile_pic_url = profilePictureUrl;
  }
  await admin
    .from("business_numbers")
    .update(patch)
    .eq("evolution_instance_name", instanceName);

  // Log every close event so the health badge has a window of disconnect
  // history to draw from. statusReason 401 = LOGGED_OUT / unlinked
  // (number was kicked from Linked Devices or banned by WhatsApp) and
  // means the number is dead until rescanned — the badge treats it
  // separately from transient blips.
  if (state === "close") {
    const reasonRaw = data?.statusReason;
    const reasonCode =
      typeof reasonRaw === "number"
        ? reasonRaw
        : typeof reasonRaw === "string"
          ? parseInt(reasonRaw, 10) || 0
          : 0;
    await admin.from("evolution_disconnects").insert({
      business_phone_number_id: bpid,
      reason_code: reasonCode,
    });
  }

}

async function handleMessageUpdate(
  admin: Admin,
  _bpid: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!data) return;
  // Evolution v2.x posts a few different shapes here:
  //   1) { messages: [{ key:{id}, status:"DELIVERY_ACK" }, …] }
  //   2) { key:{id}, status:"READ" }
  //   3) { keyId:"…", status:3 }                  (flat — newer builds)
  //   4) { messageId:"…", status:"read" }         (some forks)
  // Normalise the id + status before mapping so the bubble's
  // double-tick / blue-tick render regardless of build.
  type StatusUpdate = {
    key?: { id?: string };
    keyId?: string;
    messageId?: string;
    status?: string | number;
    update?: { status?: string | number };
  };
  const list: StatusUpdate[] = Array.isArray(data.messages)
    ? (data.messages as StatusUpdate[])
    : [data as StatusUpdate];
  for (const u of list) {
    const id = u.key?.id ?? u.keyId ?? u.messageId;
    if (!id) continue;
    const raw = u.status ?? u.update?.status;
    const next = mapEvolutionStatus(raw, "outbound");
    if (!next) continue;
    await admin.from("messages").update({ status: next }).eq("wa_message_id", id);
  }
}

async function handleMessageDelete(
  admin: Admin,
  _bpid: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!data) return;
  const list: EvoMessageData[] = Array.isArray(data.messages)
    ? (data.messages as EvoMessageData[])
    : [data as EvoMessageData];
  for (const u of list) {
    const id = u.key?.id;
    if (!id) continue;
    await admin
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("wa_message_id", id);
  }
}

// Evolution emits a `call` event whenever WhatsApp signals an incoming
// voice / video call to a linked device. The Baileys client can't pick
// the call up (linked-device API limit) but we DO want a record in the
// chat thread so the operator sees it happened — otherwise auto-rejected
// calls vanish without trace. We materialise it as a plain inbound
// system message so the bubble feed orders it correctly.
interface EvoCallEvent {
  id?: string;
  from?: string;          // caller JID
  chatId?: string;        // some Evolution builds use this
  isVideo?: boolean;
  status?: string;        // "offer" | "accept" | "reject" | "timeout"
  // Different builds use different field names + scales for the call's
  // wall-clock. Some send unix seconds, some milliseconds, some a
  // formatted ISO string. We try each in order.
  date?: number | string;
  timestamp?: number | string;
  t?: number | string;
}

/** Parse the various timestamp shapes Evolution ships call events with.
 *  Falls back to "now" rather than 1970 when nothing usable is found. */
function parseCallTimestamp(c: EvoCallEvent): string {
  const candidates = [c.date, c.timestamp, c.t];
  for (const raw of candidates) {
    if (raw == null || raw === "" || raw === 0) continue;
    if (typeof raw === "string") {
      // ISO-ish string? Try Date directly first.
      const direct = Date.parse(raw);
      if (!Number.isNaN(direct)) return new Date(direct).toISOString();
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n) && n > 0) {
        return new Date(n > 1e12 ? n : n * 1000).toISOString();
      }
      continue;
    }
    if (typeof raw === "number" && raw > 0) {
      // Heuristic: anything > 1e12 is ms, otherwise seconds. Both work
      // for any timestamp after the year 2001.
      return new Date(raw > 1e12 ? raw : raw * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}

async function handleIncomingCall(
  admin: Admin,
  bpid: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!data) return;
  // Evolution wraps single calls in `call: {...}` or `calls: [...]`
  // depending on the build. Normalise to an array.
  const list: EvoCallEvent[] = Array.isArray((data as Record<string, unknown>).calls)
    ? ((data as { calls: EvoCallEvent[] }).calls ?? [])
    : (Array.isArray(data) ? (data as EvoCallEvent[]) : [data as EvoCallEvent]);

  for (const c of list) {
    // WhatsApp privacy: a call can arrive with a Linked-ID (@lid) instead
    // of the real number. The real @s.whatsapp.net JID sometimes sits in
    // the other field — prefer whichever candidate is a real number.
    const jidCandidates = [c.from, c.chatId].filter(
      (j): j is string => typeof j === "string" && j.length > 0,
    );
    const fromJid =
      jidCandidates.find((j) => j.endsWith("@s.whatsapp.net")) ??
      jidCandidates[0];
    if (!fromJid) continue;
    if (fromJid.endsWith("@g.us")) continue; // skip group rings
    const waId = jidToWaId(fromJid);

    // If this caller already exists on ANOTHER of our numbers (e.g.
    // they previously messaged the Meta business number), reuse their
    // name + LSQ link instead of creating an anonymous fresh row. Our
    // contacts table is keyed per (wa_id, business_phone_number_id), so
    // multi-number setups DO produce one row per number — but the
    // operator-facing identity should still match.
    const { data: sibling } = await admin
      .from("contacts")
      .select("name, profile_name, lsq_prospect_id, avatar_url")
      .eq("wa_id", waId)
      .neq("business_phone_number_id", bpid)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const upsertPayload: Record<string, unknown> = {
      wa_id: waId,
      business_phone_number_id: bpid,
      status: "open",
    };
    if (sibling?.name) upsertPayload.name = sibling.name;
    if (sibling?.profile_name) upsertPayload.profile_name = sibling.profile_name;
    if (sibling?.avatar_url) upsertPayload.avatar_url = sibling.avatar_url;

    const { data: contact } = await admin
      .from("contacts")
      .upsert(upsertPayload, {
        onConflict: "wa_id,business_phone_number_id",
        ignoreDuplicates: false,
      })
      .select("id")
      .single();
    if (!contact) continue;

    // Idempotency — Evolution may resend the same call on a status
    // change. Skip if we've already logged this id.
    const callId = c.id ?? `${fromJid}-${c.date ?? c.timestamp ?? Date.now()}`;
    const waMessageId = `evo-call-${callId}`;
    const { data: existing } = await admin
      .from("messages")
      .select("id")
      .eq("wa_message_id", waMessageId)
      .maybeSingle();
    if (existing) continue;

    const kind = c.isVideo ? "video call" : "voice call";
    const status = c.status ?? "offer";
    const action =
      status === "accept"
        ? "accepted"
        : status === "reject"
          ? "rejected"
          : status === "timeout"
            ? "missed"
            : "incoming";
    const body = `📞 ${kind} — ${action}`;
    const tsIso = parseCallTimestamp(c);

    await admin.from("messages").insert({
      contact_id: contact.id,
      wa_message_id: waMessageId,
      direction: "inbound",
      type: "text",
      content: body,
      status: "received",
      timestamp: tsIso,
      business_phone_number_id: bpid,
      // Keep the full call event — lets us inspect exactly what fields
      // Evolution sends (real number vs @lid) for future resolution.
      raw_payload: c as Record<string, unknown>,
    });
    await admin
      .from("contacts")
      .update({
        last_message_at: tsIso,
        last_message_preview: body.slice(0, 120),
        last_message_direction: "inbound",
        last_message_status: "received",
      })
      .eq("id", contact.id);
  }
}

// chats.upsert / chats.update — Evolution surfaces the chat list, where
// a group chat's `name` (or `subject`) is the group's display name. The
// messages.upsert path can't know the group subject (pushName there is
// the participant), so we keep the group contact's name fresh here.
async function handleChatsUpdate(
  admin: Admin,
  bpid: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!data) return;
  const list: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : Array.isArray((data as { chats?: unknown }).chats)
      ? ((data as { chats: Array<Record<string, unknown>> }).chats)
      : [data];

  for (const chat of list) {
    const jid = typeof chat.id === "string" ? chat.id : null;
    if (!jid || !jid.endsWith("@g.us")) continue;
    const rawName =
      (typeof chat.name === "string" && chat.name) ||
      (typeof chat.subject === "string" && chat.subject) ||
      "";
    const name = rawName.trim();
    if (!name) continue;
    const waId = jidToWaId(jid);
    if (!waId) continue;
    await admin.from("contacts").upsert(
      {
        wa_id: waId,
        business_phone_number_id: bpid,
        is_group: true,
        name,
        profile_name: name,
      },
      { onConflict: "wa_id,business_phone_number_id", ignoreDuplicates: false },
    );
  }
}

async function handleContactsUpsert(
  admin: Admin,
  bpid: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!data) return;
  const list = Array.isArray(data.contacts)
    ? (data.contacts as Array<{
        id?: string;
        pushName?: string;
        profilePictureUrl?: string;
      }>)
    : [];
  for (const c of list) {
    if (!c.id) continue;
    // Same allowlist as the messages.upsert path. Address-book entries
    // for LIDs / broadcasts / channels would otherwise create garbage
    // contact rows here even before any message arrives.
    if (
      !c.id.endsWith("@s.whatsapp.net") &&
      !c.id.endsWith("@c.us") &&
      !c.id.endsWith("@g.us")
    ) {
      continue;
    }
    const waId = jidToWaId(c.id);
    if (!waId) continue;
    await admin
      .from("contacts")
      .upsert(
        {
          wa_id: waId,
          business_phone_number_id: bpid,
          name: c.pushName ?? null,
          profile_name: c.pushName ?? null,
          avatar_url: c.profilePictureUrl ?? null,
          status: "open",
        },
        {
          onConflict: "wa_id,business_phone_number_id",
          ignoreDuplicates: false,
        },
      );
  }
}

