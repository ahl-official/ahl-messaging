// Meta WhatsApp Cloud API wrapper.
// Server-only — never import from a client component.

import { getCredential } from "@/lib/credentials";
import { requireCredsForPhoneNumberId } from "@/lib/portfolios";

// Meta API version — shared across portfolios (Meta numbers versions
// globally, not per-app). Falls back to a sensible default. Cached at module
// scope (per server instance) for 15min — it's read on every Meta call and
// only changes ~quarterly, so the lookup is pure overhead otherwise.
let apiVersionCache: { value: string; expiry: number } | null = null;
const API_VERSION_TTL_MS = 15 * 60 * 1000;
export async function getApiVersion(): Promise<string> {
  const now = Date.now();
  if (apiVersionCache && apiVersionCache.expiry > now) return apiVersionCache.value;
  const value = (await getCredential("whatsapp_api_version")) || "v22.0";
  apiVersionCache = { value, expiry: now + API_VERSION_TTL_MS };
  return value;
}

async function getAccessTokenFor(phoneNumberId: string): Promise<string> {
  const creds = await requireCredsForPhoneNumberId(phoneNumberId);
  return creds.access_token;
}

function ensurePhoneNumberId(phoneNumberId?: string): string {
  if (phoneNumberId) return phoneNumberId;
  throw new Error(
    "WhatsApp phone_number_id is required. Pass it explicitly when calling sendTextMessage / sendTemplate / sendMedia.",
  );
}

export interface SendMessageResponse {
  messaging_product: "whatsapp";
  contacts: { input: string; wa_id: string }[];
  messages: { id: string }[];
}

interface MetaErrorPayload {
  error?: { message?: string; type?: string; code?: number };
}

async function postToGraph(
  phoneNumberId: string,
  payload: Record<string, unknown>,
): Promise<SendMessageResponse> {
  const [token, apiVersion] = await Promise.all([
    getAccessTokenFor(phoneNumberId),
    getApiVersion(),
  ]);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const json = (await res.json()) as SendMessageResponse & MetaErrorPayload;
  if (!res.ok) {
    const msg = json.error?.message || `WhatsApp API ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export async function sendTextMessage(
  to: string,
  body: string,
  phoneNumberId?: string,
  /** When set, the message is sent as a quoted reply to this wamid —
   *  Meta renders it as a swipe-reply thread on the customer's phone. */
  replyToWaMessageId?: string | null,
): Promise<SendMessageResponse> {
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
  if (replyToWaMessageId) {
    payload.context = { message_id: replyToWaMessageId };
  }
  return postToGraph(ensurePhoneNumberId(phoneNumberId), payload);
}

/**
 * Send interactive reply buttons (the real tappable kind, not a numbered
 * text list). Meta caps this at 3 buttons, each title ≤ 20 chars, body
 * ≤ 1024 chars. Only valid inside the 24-hour customer-service window.
 * When the patient taps one, Meta delivers their reply as the button title.
 */
/** Build an interactive-message media header, uploading the link to Meta first
 *  (send by id) so Meta never has to fetch the external URL — same reliability
 *  win as sendMedia. Falls back to a link header if the upload fails. */
async function buildMediaHeader(
  phoneNumberId: string,
  header: { kind: "image" | "video" | "document"; link: string } | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!header?.link) return null;
  let ref: Record<string, unknown> = { link: header.link };
  try {
    ref = { id: await uploadMediaUrlToMeta(phoneNumberId, header.link, header.kind) };
  } catch {
    /* keep link fallback */
  }
  return header.kind === "video"
    ? { type: "video", video: ref }
    : header.kind === "document"
      ? { type: "document", document: ref }
      : { type: "image", image: ref };
}

export async function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id?: string; title: string }>,
  phoneNumberId?: string,
  /** Optional image/video/document header (public link). */
  header?: { kind: "image" | "video" | "document"; link: string } | null,
): Promise<SendMessageResponse> {
  const pnid = ensurePhoneNumberId(phoneNumberId);
  const replyButtons = buttons.slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: { id: (b.id ?? String(i + 1)).slice(0, 256), title: b.title.slice(0, 20) },
  }));
  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: bodyText.slice(0, 1024) },
    action: { buttons: replyButtons },
  };
  const hdr = await buildMediaHeader(pnid, header);
  if (hdr) interactive.header = hdr;
  return postToGraph(pnid, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive,
  });
}

/**
 * Send an interactive Call-to-Action URL message — body text + a single
 * tappable URL button, with an OPTIONAL image/video/document header (public
 * link). This is how we render "image/video + text + button" quick replies.
 * Only valid inside the 24-hour customer-service window.
 */
export async function sendCtaUrl(
  to: string,
  bodyText: string,
  buttonText: string,
  buttonUrl: string,
  header?: { kind: "image" | "video" | "document"; link: string } | null,
  phoneNumberId?: string,
): Promise<SendMessageResponse> {
  const pnid = ensurePhoneNumberId(phoneNumberId);
  const interactive: Record<string, unknown> = {
    type: "cta_url",
    body: { text: bodyText.slice(0, 1024) },
    action: {
      name: "cta_url",
      parameters: { display_text: buttonText.slice(0, 20), url: buttonUrl },
    },
  };
  const hdr = await buildMediaHeader(pnid, header);
  if (hdr) interactive.header = hdr;
  return postToGraph(pnid, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive,
  });
}

/**
 * Edit a previously-sent text message on the customer's WhatsApp.
 *
 * Meta exposes this via POST /{phone_number_id}/messages with a `text`
 * payload + `to: "<wamid>"` style `edit` object. Only text messages are
 * editable, and only within a 15-minute window of the original send.
 * On error we surface Meta's message directly so the caller can decide
 * whether to roll back the optimistic update.
 */
export async function editTextMessage(
  to: string,
  originalWaMessageId: string,
  newBody: string,
  phoneNumberId?: string,
): Promise<SendMessageResponse> {
  return postToGraph(ensurePhoneNumberId(phoneNumberId), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: newBody },
    edit: { message_id: originalWaMessageId },
  });
}

/**
 * STUB — Meta WhatsApp Cloud API does NOT support deleting messages
 * on the customer's phone. "Delete for everyone" is a WhatsApp client
 * feature only (the user does it from their own phone). The Cloud
 * API has SEND + EDIT but no DELETE endpoint.
 *
 * We keep this function so the rest of the code compiles, but it just
 * throws a clear message. The /api/messages/[id] DELETE handler
 * catches the throw and still soft-deletes the local row (dashboard
 * tombstone) — the message will keep showing on the customer's phone
 * until Meta adds API support.
 */
export async function deleteSentMessage(
  _to: string,
  _originalWaMessageId: string,
  _phoneNumberId?: string,
): Promise<SendMessageResponse> {
  throw new Error(
    "WhatsApp Cloud API does not support deleting sent messages — only local deletion is possible.",
  );
}

export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode = "en_US",
  components?: unknown[],
  phoneNumberId?: string,
): Promise<SendMessageResponse> {
  return postToGraph(ensurePhoneNumberId(phoneNumberId), {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
}

/** Download a public media URL and upload the bytes to Meta's /media endpoint,
 *  returning the resulting media_id. Used so we can send by media_id instead of
 *  by link — Meta fetching an external link itself is flaky (the host, e.g.
 *  Supabase storage, can throttle Meta's fetcher during a burst, surfacing as
 *  intermittent "Media upload error" / "Authentication Error"). Hosting the
 *  bytes on Meta removes that dependency. */
async function uploadMediaUrlToMeta(
  phoneNumberId: string,
  mediaUrl: string,
  mediaType: "image" | "document" | "audio" | "video",
): Promise<string> {
  const dl = await fetch(mediaUrl, { cache: "no-store" });
  if (!dl.ok) throw new Error(`media fetch failed (${dl.status})`);
  const mime = dl.headers.get("content-type")?.split(";")[0]?.trim() || `${mediaType}/jpeg`;
  const bytes = Buffer.from(await dl.arrayBuffer());
  const ext = (mime.split("/")[1] || "bin").replace("jpeg", "jpg");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([bytes], { type: mime }), `upload.${ext}`);
  const [token, apiVersion] = await Promise.all([getAccessTokenFor(phoneNumberId), getApiVersion()]);
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(json.error?.message ?? `Meta media upload failed (${res.status})`);
  return json.id;
}

export async function sendMedia(
  to: string,
  mediaType: "image" | "document" | "audio" | "video",
  mediaIdOrLink: string,
  caption?: string,
  phoneNumberId?: string,
  /** Document attachments only — sets the filename Meta displays on
   *  the recipient's WhatsApp document bubble. Ignored for non-document
   *  media types. */
  filename?: string,
): Promise<SendMessageResponse> {
  const pnid = ensurePhoneNumberId(phoneNumberId);
  let mediaRef = mediaIdOrLink;
  let refIsId = !/^https?:\/\//i.test(mediaIdOrLink);
  if (!refIsId) {
    // Upload the link to Meta first and send by id — far more reliable than
    // having Meta fetch the URL. Fall back to a plain link send if upload fails.
    try {
      mediaRef = await uploadMediaUrlToMeta(pnid, mediaIdOrLink, mediaType);
      refIsId = true;
    } catch {
      mediaRef = mediaIdOrLink;
      refIsId = false;
    }
  }
  const mediaPayload: Record<string, unknown> = refIsId
    ? { id: mediaRef }
    : { link: mediaRef };
  if (caption && (mediaType === "image" || mediaType === "video" || mediaType === "document")) {
    mediaPayload.caption = caption;
  }
  if (filename && mediaType === "document") {
    mediaPayload.filename = filename;
  }
  return postToGraph(pnid, {
    messaging_product: "whatsapp",
    to,
    type: mediaType,
    [mediaType]: mediaPayload,
  });
}

/**
 * Mark an inbound message as read. Optionally show "typing…" indicator on
 * the user's WhatsApp for the next ~25 seconds.
 *
 * Meta serves both behaviours via the same /messages endpoint:
 *   - Setting `status: "read"` delivers blue ticks to the user.
 *   - Adding `typing_indicator: { type: "text" }` makes the user's WhatsApp
 *     show "<business> is typing…" until we send a real reply or 25s elapse.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 */
export async function markMessageRead(
  messageId: string,
  options: { typing?: boolean; phoneNumberId?: string } = {},
): Promise<void> {
  const phoneNumberId = ensurePhoneNumberId(options.phoneNumberId);
  const [token, apiVersion] = await Promise.all([
    getAccessTokenFor(phoneNumberId),
    getApiVersion(),
  ]);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };
  if (options.typing) {
    payload.typing_indicator = { type: "text" };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mark-read failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

// Look up the verified business name + display phone for a phone_number_id.
// Used by the webhook the first time it sees a new business number.
export interface PhoneNumberDetails {
  display_phone_number: string;
  verified_name: string;
  id: string;
}

export async function fetchPhoneNumberDetails(
  phoneNumberId: string,
): Promise<PhoneNumberDetails | null> {
  try {
    const [token, apiVersion] = await Promise.all([
      getAccessTokenFor(phoneNumberId),
      getApiVersion(),
    ]);
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as PhoneNumberDetails;
  } catch {
    return null;
  }
}

/** Fetch the WhatsApp Business profile picture URL for a Meta phone
 *  number id. Reads directly from Meta's /whatsapp_business_profile
 *  endpoint — the same surface that Settings → WhatsApp Manager uses
 *  to edit the business logo. Cloud-API verified numbers expose their
 *  pic here even though they don't have a personal WhatsApp profile
 *  the way unofficial / Baileys numbers do.
 *
 *  Returns null when no profile picture has been uploaded on the Meta
 *  side. Network / auth errors also return null so the caller can fall
 *  back cleanly. */
export async function fetchMetaBusinessProfilePic(
  phoneNumberId: string,
): Promise<string | null> {
  try {
    const [token, apiVersion] = await Promise.all([
      getAccessTokenFor(phoneNumberId),
      getApiVersion(),
    ]);
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: Array<{ profile_picture_url?: string }>;
    };
    return j.data?.[0]?.profile_picture_url ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud Calling — settings + permission + signaling helpers
//
// Three things the operator-facing app needs to do:
//   1. enableCalling(phoneNumberId)         — one-time: turn calling on for
//                                             a Phone Number ID.
//   2. sendCallPermissionRequest(to, …)     — outbound: ask the user for
//                                             permission before we dial.
//   3. respondToCallSignal(callId, payload) — inbound + outbound signaling:
//                                             accept / reject / send SDP
//                                             answer for WebRTC.
//
// Webhook ingest (the `calls[]` change) lives in /api/webhook — it
// creates / updates rows in `whatsapp_calls` so the UI can render
// state. Actual audio capture/playback lives in the WebRTC client
// layer (browser side, separate phase).
// ---------------------------------------------------------------------------

export interface CallingSettings {
  /** "ENABLED" or "DISABLED". */
  status?: "ENABLED" | "DISABLED";
  /** Whether the business can call back after a missed user call. */
  callback_permission_status?: "ENABLED" | "DISABLED";
  /** SIP route — set hostname/port if you have a PBX; omit for the
   *  default WebRTC route. */
  sip?: {
    status: "ENABLED" | "DISABLED";
    servers?: Array<{ hostname: string; port?: number }>;
  };
  srtp_key_exchange_protocol?: "SDES" | "DTLS";
}

export async function enableCalling(
  phoneNumberId: string,
  settings: CallingSettings = { status: "ENABLED", callback_permission_status: "ENABLED" },
): Promise<{ ok: boolean; raw: unknown; error: string | null }> {
  const [token, apiVersion] = await Promise.all([
    getAccessTokenFor(phoneNumberId),
    getApiVersion(),
  ]);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/settings`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ calling: settings }),
      cache: "no-store",
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave as null */
    }
    if (!res.ok) {
      const errMsg =
        (parsed as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${res.status}: ${raw.slice(0, 200)}`;
      return { ok: false, raw: parsed, error: errMsg };
    }
    return { ok: true, raw: parsed, error: null };
  } catch (e) {
    return {
      ok: false,
      raw: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

/** Send an interactive `call_permission_request` so the user has
 *  to tap "Allow" before we can place an outbound call. Required by
 *  Meta — bypassing this returns "user did not consent" errors. */
export async function sendCallPermissionRequest(
  to: string,
  body: string,
  phoneNumberId?: string,
): Promise<SendMessageResponse> {
  return postToGraph(ensurePhoneNumberId(phoneNumberId), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "call_permission_request",
      action: { name: "call_permission_request" },
      body: { text: body.slice(0, 1024) },
    },
  });
}

/** Dial out — tells Meta to ring a user with a fresh WebRTC offer
 *  from us. The caller MUST have the user's call permission (either
 *  via a prior CPR grant or because the consumer can already call us
 *  back, code #138017). Returns Meta's call_id on success — that
 *  becomes our wa_call_id for the new whatsapp_calls row.
 *
 *  WhatsApp Cloud Calling expects:
 *    POST /{phoneNumberId}/calls
 *    { messaging_product: "whatsapp", to, action: "connect",
 *      session: { sdp_type: "offer", sdp } } */
export async function initiateOutboundCall(
  to: string,
  sdpOffer: string,
  phoneNumberId: string,
): Promise<{ ok: boolean; callId: string | null; raw: unknown; error: string | null }> {
  const [token, apiVersion] = await Promise.all([
    getAccessTokenFor(phoneNumberId),
    getApiVersion(),
  ]);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/calls`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        action: "connect",
        session: { sdp_type: "offer", sdp: sdpOffer },
      }),
      cache: "no-store",
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave as null */
    }
    if (!res.ok) {
      const errMsg =
        (parsed as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${res.status}: ${raw.slice(0, 200)}`;
      return { ok: false, callId: null, raw: parsed, error: errMsg };
    }
    const callId =
      (parsed as { calls?: Array<{ id?: string }> } | null)?.calls?.[0]?.id ??
      null;
    return { ok: true, callId, raw: parsed, error: null };
  } catch (e) {
    return {
      ok: false,
      callId: null,
      raw: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

/** WebRTC signaling — pre-accept / accept / reject / terminate the
 *  call referenced by `callId`. Meta documents these as POSTs to the
 *  same Graph endpoint with an `action` field. The SDP answer (when
 *  applicable) is generated by the browser's RTCPeerConnection. */
export async function respondToCallSignal(
  callId: string,
  action: "pre_accept" | "accept" | "reject" | "terminate",
  opts: {
    sdpAnswer?: string;
    phoneNumberId?: string;
  } = {},
): Promise<{ ok: boolean; raw: unknown; error: string | null }> {
  const phoneNumberId = ensurePhoneNumberId(opts.phoneNumberId);
  const [token, apiVersion] = await Promise.all([
    getAccessTokenFor(phoneNumberId),
    getApiVersion(),
  ]);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/calls`;
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    call_id: callId,
    action,
  };
  if (opts.sdpAnswer) {
    // Meta's schema names the type field `sdp_type`, not `type`. The
    // SDP itself goes in `sdp`. Sending `type` returns "Unexpected
    // key 'type' on param 'session'".
    payload.session = { sdp: opts.sdpAnswer, sdp_type: "answer" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave as null */
    }
    if (!res.ok) {
      const errMsg =
        (parsed as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${res.status}: ${raw.slice(0, 200)}`;
      return { ok: false, raw: parsed, error: errMsg };
    }
    return { ok: true, raw: parsed, error: null };
  } catch (e) {
    return {
      ok: false,
      raw: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}
