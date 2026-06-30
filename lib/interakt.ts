// Interakt (WhatsApp BSP) integration — server-only. Parallel routing to
// Meta/Evolution: Interakt POSTs events to our webhook, and we send
// replies through Interakt's public message API.
//
// Config lives in app_settings:
//   • interakt_webhook_secret — the <secret> embedded in the webhook URL
//   • interakt_api_key        — workspace-level API key (per-number key on
//                               business_numbers.interakt_api_key wins)
//
// Docs: https://www.interakt.shop/resource-center/ (public API + webhooks)

import { getAppSetting, setAppSetting } from "@/lib/app-settings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { interaktTemplatePreview, renderInteraktTemplate } from "@/lib/interakt-format";

export const INTERAKT_WEBHOOK_SECRET_KEY = "interakt_webhook_secret";
export const INTERAKT_API_KEY_KEY = "interakt_api_key";
export const INTERAKT_BUSINESS_NUMBER_KEY = "interakt_business_number";
/** Public origin (e.g. https://wa.hairmedindia.com) used to build the
 *  webhook URL shown in settings — kept stable across local/live so the
 *  displayed URL always matches what's registered in Interakt. */
export const INTERAKT_WEBHOOK_BASE_KEY = "interakt_webhook_base";

const INTERAKT_API_BASE = "https://api.interakt.ai/v1/public";

// ---------------------------------------------------------------------
// Config accessors
// ---------------------------------------------------------------------
export async function getInteraktWebhookSecret(): Promise<string | null> {
  const v = (await getAppSetting(INTERAKT_WEBHOOK_SECRET_KEY))?.trim();
  return v && v.length > 0 ? v : null;
}

export async function setInteraktWebhookSecret(secret: string): Promise<void> {
  await setAppSetting(INTERAKT_WEBHOOK_SECRET_KEY, secret.trim());
}

export async function getInteraktApiKey(): Promise<string | null> {
  const v = (await getAppSetting(INTERAKT_API_KEY_KEY))?.trim();
  return v && v.length > 0 ? v : null;
}

export async function setInteraktApiKey(key: string): Promise<void> {
  await setAppSetting(INTERAKT_API_KEY_KEY, key.trim());
}

/** Per-number Interakt API key (business_numbers.interakt_api_key), falling
 *  back to the workspace key. Use this for any per-number Interakt API call
 *  (templates, sends) so each number hits its own account. */
export async function getInteraktApiKeyForNumber(
  phoneNumberId: string,
): Promise<string | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("business_numbers")
    .select("interakt_api_key")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  const perNumber = (data?.interakt_api_key as string | null) ?? null;
  return perNumber || (await getInteraktApiKey());
}

/** Sync a dashboard chat assignment to Interakt so the chat is routed to
 *  the same agent there. No-op for non-Interakt contacts / missing email.
 *  Fire-and-forget — never throws.
 *
 *  POST /v1/public/assignment/  { user_phone_number, agent_email } */
export async function syncInteraktAssignment(
  contactId: string,
  agentEmail: string | null | undefined,
): Promise<void> {
  if (!agentEmail) return;
  try {
    const admin = createServiceRoleClient();
    const { data: contact } = await admin
      .from("contacts")
      .select("wa_id, business_phone_number_id")
      .eq("id", contactId)
      .maybeSingle();
    const bpid = (contact?.business_phone_number_id as string | null) ?? "";
    if (!bpid.startsWith("interakt:")) return;
    const key = await getInteraktApiKeyForNumber(bpid);
    if (!key) return;
    await fetch(`${INTERAKT_API_BASE}/assignment/`, {
      method: "POST",
      headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        user_phone_number: String(contact?.wa_id ?? "").replace(/\D/g, ""),
        agent_email: agentEmail,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.warn("[interakt] assignment sync failed:", e instanceof Error ? e.message : e);
  }
}

/** The Interakt WABA (business) number — digits only. Interakt's webhook
 *  payload only carries the CUSTOMER number, so the business number must
 *  be configured here. All Interakt chats are filed under
 *  `interakt:<this>`. */
export async function getInteraktBusinessNumber(): Promise<string | null> {
  const v = (await getAppSetting(INTERAKT_BUSINESS_NUMBER_KEY))?.replace(/\D/g, "");
  return v && v.length >= 6 ? v : null;
}

export async function setInteraktBusinessNumber(num: string): Promise<void> {
  await setAppSetting(INTERAKT_BUSINESS_NUMBER_KEY, num.replace(/\D/g, ""));
}

/** Stored public origin → falls back to NEXT_PUBLIC_APP_URL. No trailing slash. */
export async function getInteraktWebhookBase(): Promise<string | null> {
  const stored = (await getAppSetting(INTERAKT_WEBHOOK_BASE_KEY))?.trim();
  const base = stored || process.env.NEXT_PUBLIC_APP_URL?.trim() || null;
  return base ? base.replace(/\/+$/, "") : null;
}

export async function setInteraktWebhookBase(origin: string): Promise<void> {
  await setAppSetting(INTERAKT_WEBHOOK_BASE_KEY, origin.trim().replace(/\/+$/, ""));
}

/** A fresh random secret for the webhook URL. UUID-shaped to match what
 *  Interakt's own "Secret key" field expects. */
export function generateWebhookSecret(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Per-number registry — each Interakt account = one business_numbers row
// (provider='interakt') carrying its own api key + webhook secret. The
// webhook secret in the URL is what tells us which number an event is for
// (Interakt's payload only carries the customer number).
// ---------------------------------------------------------------------
export interface InteraktNumber {
  phoneNumberId: string; // 'interakt:<waba>'
  waba: string;
  apiKey: string | null;
  webhookSecret: string | null;
  nickname: string | null;
}

/** Parse the stored forward-url value into a list. Stored as a JSON array;
 *  falls back to treating a bare string as one URL (legacy). */
export function parseForwardUrls(raw: string | null | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  try {
    const arr = JSON.parse(t);
    if (Array.isArray(arr)) {
      return arr.map((s) => String(s ?? "").trim()).filter(Boolean);
    }
  } catch {
    /* legacy single-URL value */
  }
  return [t];
}

/** Resolve the Interakt number that owns this webhook secret. */
export async function resolveInteraktNumberBySecret(
  secret: string,
): Promise<{ phoneNumberId: string; apiKey: string | null; forwardUrls: string[] } | null> {
  if (!secret) return null;
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("business_numbers")
    .select("phone_number_id, interakt_api_key, interakt_forward_url")
    .eq("provider", "interakt")
    .eq("interakt_webhook_secret", secret)
    .maybeSingle();
  if (!data) return null;
  return {
    phoneNumberId: data.phone_number_id as string,
    apiKey: (data.interakt_api_key as string | null) ?? null,
    forwardUrls: parseForwardUrls(data.interakt_forward_url as string | null),
  };
}

// ---------------------------------------------------------------------
// Inbound payload parsing
// ---------------------------------------------------------------------
export type InteraktKind = "text" | "image" | "video" | "audio" | "document" | "sticker" | "template" | "location";

export interface ParsedInteraktMessage {
  /** Customer's full number — digits only (country code + local). */
  waId: string;
  /** Customer's display/profile name, if Interakt sent one. */
  profileName: string | null;
  /** Provider message id (for dedup). */
  messageId: string | null;
  kind: InteraktKind;
  /** Text body or media caption (for templates: the rendered body). */
  content: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  timestamp: string;
  isInbound: boolean;
  /** The tapped button/list title when this inbound is an interactive reply
   *  (Quick Reply / list pick) — used for campaign button-click attribution. */
  buttonReply?: string | null;
  /** Template-message metadata (kind === "template"). */
  templateName?: string | null;
  templateFooter?: string | null;
  templateButtons?: Array<{ type: string; text?: string; url?: string }> | null;
}

export interface ParsedInteraktStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
}

function digits(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

/** Split a full phone into Interakt's { countryCode: "+91", phoneNumber }
 *  shape. The last 10 digits are the national number, the rest the country
 *  code (covers India/US 10-digit nationals; defaults cc to +91). */
function splitPhone(s: unknown): { countryCode: string; phoneNumber: string } {
  const d = digits(s);
  if (d.length > 10) return { countryCode: `+${d.slice(0, d.length - 10)}`, phoneNumber: d.slice(-10) };
  return { countryCode: "+91", phoneNumber: d };
}

function mapContentType(t: unknown): InteraktKind {
  switch (String(t ?? "").toLowerCase()) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "audio";
    case "document":
    case "file":
      return "document";
    case "sticker":
      return "sticker";
    case "location":
      return "location";
    default:
      return "text";
  }
}

/** Interakt's event envelope. Kept loose — we read defensively and stash
 *  the whole thing in messages.raw_payload so nothing is lost if a field
 *  name differs from what we expect. */
interface InteraktEnvelope {
  type?: string;
  timestamp?: string;
  data?: {
    customer?: {
      channel_phone_number?: string;
      country_code?: string;
      phone_number?: string;
      traits?: { name?: string } | null;
    };
    message?: {
      id?: string;
      message?: string;
      caption?: string | null;
      media_url?: string | null;
      media_type?: string | null;
      message_content_type?: string;
      received_at_utc?: string;
      is_inbound?: boolean;
      // Location messages — Interakt's exact field names vary, so we read
      // both flat and nested shapes defensively (rest lives in raw_payload).
      latitude?: number | string;
      longitude?: number | string;
      address?: string;
      location?: { latitude?: number | string; longitude?: number | string; name?: string; address?: string };
      // Template messages carry the full definition here + a flag.
      is_template_message?: boolean;
      raw_template?: unknown;
      // Interakt's real field. "CustomerMessage" = inbound; anything else
      // (UserMessage / APIMessage / CampaignMessage) = outbound.
      chat_message_type?: string;
      // Status lives here ("Sent" | "Delivered" | "Read" | "Failed").
      message_status?: string;
      status?: string;
    };
  };
}

/** True for event types we treat as a chat message (vs account/template
 *  alerts which we ack-and-ignore). */
export function isMessageEvent(type: string | undefined): boolean {
  const t = (type ?? "").toLowerCase();
  return t.includes("message") && !t.includes("template");
}

export function isStatusEvent(type: string | undefined): boolean {
  const t = (type ?? "").toLowerCase();
  return t.includes("status");
}

// Pull the title out of an interactive button/list reply blob. Interakt sends
// these as a raw JSON string; we want the human-readable option text.
function interactiveReplyTitle(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s.startsWith("{") || !s.includes("_reply")) return null;
  try {
    const o = JSON.parse(s) as Record<string, { title?: string }> & {
      interactive?: Record<string, { title?: string }>;
    };
    const t =
      o.button_reply?.title ??
      o.list_reply?.title ??
      o.interactive?.button_reply?.title ??
      o.interactive?.list_reply?.title;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

export function parseInteraktMessage(body: unknown): ParsedInteraktMessage | null {
  const env = body as InteraktEnvelope;
  const cust = env?.data?.customer;
  const msg = env?.data?.message;
  if (!cust || !msg) return null;

  // Customer's full number. channel_phone_number is already the full
  // customer number; fall back to country_code + phone_number.
  const cc = digits(cust.country_code);
  const pn = digits(cust.phone_number);
  const composed = pn.startsWith(cc) || !cc ? pn : `${cc}${pn}`;
  const waId = digits(cust.channel_phone_number) || composed;
  if (!waId) return null;

  // Interakt's real field is chat_message_type ("CustomerMessage" =
  // inbound). is_inbound is a defensive fallback.
  const cmt = msg.chat_message_type;
  const isInbound = cmt ? cmt === "CustomerMessage" : msg.is_inbound !== false;
  const timestamp = msg.received_at_utc || env.timestamp || new Date().toISOString();

  // Template message — render the full card from raw_template + the
  // per-send parameter values so the chat shows it like Interakt does.
  const isTemplate =
    msg.is_template_message === true ||
    String(msg.message_content_type ?? "").toLowerCase() === "template";
  if (isTemplate) {
    const tpl = renderInteraktTemplate(msg.raw_template, msg.message, msg.media_url);
    if (tpl) {
      return {
        waId,
        profileName: cust.traits?.name?.trim() || null,
        messageId: msg.id ?? null,
        kind: "template",
        content: tpl.body || null,
        mediaUrl: tpl.headerUrl,
        mediaMime: tpl.headerUrl ? "image/*" : null,
        timestamp,
        isInbound,
        templateName: tpl.name,
        templateFooter: tpl.footer,
        templateButtons: tpl.buttons,
      };
    }
  }

  // Interakt sends the literal string "None" for media messages with no
  // caption — treat it (and "null") as empty so the chat/list don't show "None".
  const rawBody = msg.message ?? msg.caption ?? "";
  const cleanedBody = rawBody === "None" || rawBody === "null" ? "" : rawBody;
  const kind = mapContentType(msg.message_content_type ?? msg.media_type);

  // Interactive button / list reply — Interakt delivers the raw JSON
  // {"type":"button_reply","button_reply":{"id","title"}}. Show the tapped
  // option's title instead of the JSON blob.
  const replyTitle = interactiveReplyTitle(cleanedBody);

  // Fallback for any other component-JSON content — clean blob to label.
  let content = replyTitle || interaktTemplatePreview(cleanedBody) || null;
  if (kind === "location") {
    // "📍 <label> (lat,lng)" — same format as the Meta + Evolution webhooks so
    // MessageBubble renders one clickable map link. If Interakt didn't send
    // coords we keep whatever text it put in `message` (often a maps URL,
    // which the bubble linkifies).
    const lat = msg.latitude ?? msg.location?.latitude;
    const lng = msg.longitude ?? msg.location?.longitude;
    const label = [msg.location?.name, msg.address ?? msg.location?.address]
      .map((s) => (s ?? "").toString().trim())
      .filter(Boolean)
      .join(" — ");
    if (lat != null && lng != null) {
      content = label ? `📍 ${label} (${lat},${lng})` : `📍 (${lat},${lng})`;
    } else if (!content) {
      content = label ? `📍 ${label}` : "📍 Location";
    }
  }

  return {
    waId,
    profileName: cust.traits?.name?.trim() || null,
    messageId: msg.id ?? null,
    kind,
    content,
    mediaUrl: msg.media_url ?? null,
    mediaMime: null,
    timestamp,
    isInbound,
    buttonReply: replyTitle || null,
  };
}

export function parseInteraktStatus(body: unknown): ParsedInteraktStatus | null {
  const env = body as InteraktEnvelope;
  const msg = env?.data?.message;
  const raw = String(msg?.message_status ?? msg?.status ?? "").toLowerCase();
  const status =
    raw === "delivered" || raw === "read" || raw === "failed" ? raw : raw === "sent" ? "sent" : null;
  if (!msg?.id || !status) return null;
  return {
    messageId: msg.id,
    status,
    timestamp: msg.received_at_utc || env.timestamp || new Date().toISOString(),
  };
}

export function previewForInterakt(m: ParsedInteraktMessage): string {
  if (m.kind === "image") return m.content ? `📷 ${m.content}` : "📷 Photo";
  if (m.kind === "video") return m.content ? `🎥 ${m.content}` : "🎥 Video";
  if (m.kind === "audio") return "🎙️ Voice message";
  if (m.kind === "document") return m.content ? `📄 ${m.content}` : "📄 Document";
  if (m.kind === "sticker") return "🟪 Sticker";
  if (m.kind === "location") return m.content?.startsWith("📍") ? m.content.slice(0, 120) : "📍 Location";
  return (m.content ?? "").slice(0, 120);
}

// ---------------------------------------------------------------------
// Outbound send — Interakt public message API.
// ---------------------------------------------------------------------
export interface InteraktSendResult {
  messageId: string | null;
}

/** Send a free-form (session) text message via Interakt's public message
 *  API. `toPhone` is the customer's full number (digits); Interakt expects
 *  it as `fullPhoneNumber` with a leading "+". Throws on a non-2xx response.
 *
 *  POST https://api.interakt.ai/v1/public/message/
 *    Authorization: Basic <api_key>
 *    { fullPhoneNumber, type:"Text", data:{ message } }
 */
export async function sendInteraktText(
  apiKey: string,
  toPhone: string,
  text: string,
): Promise<InteraktSendResult> {
  const res = await fetch(`${INTERAKT_API_BASE}/message/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fullPhoneNumber: `+${digits(toPhone)}`,
      type: "Text",
      data: { message: text },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    message_id?: string;
    result?: boolean;
    message?: string;
  };
  if (!res.ok || json.result === false) {
    throw new Error(json.message ?? `Interakt send HTTP ${res.status}`);
  }
  return { messageId: json.id ?? json.message_id ?? null };
}

const MEDIA_TYPE: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
};

/** Send a media message (image / video / audio / document) via Interakt.
 *  `mediaUrl` must be a public URL Interakt can fetch.
 *
 *  POST https://api.interakt.ai/v1/public/message/
 *    { fullPhoneNumber, type:"Audio", data:{ message, mediaUrl, fileName } }
 */
export async function sendInteraktMedia(
  apiKey: string,
  toPhone: string,
  opts: {
    kind: "image" | "video" | "audio" | "document";
    mediaUrl: string;
    message?: string;
    fileName?: string;
  },
): Promise<InteraktSendResult> {
  const { countryCode, phoneNumber } = splitPhone(toPhone);
  const res = await fetch(`${INTERAKT_API_BASE}/message/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      countryCode,
      phoneNumber,
      type: MEDIA_TYPE[opts.kind] ?? "Document",
      data: {
        message: opts.message ?? "",
        mediaUrl: opts.mediaUrl,
        // Audio/Video want a fileName; default one so they don't fail.
        ...(opts.fileName
          ? { fileName: opts.fileName }
          : opts.kind === "audio" || opts.kind === "video"
            ? { fileName: "file" }
            : {}),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    message_id?: string;
    result?: boolean;
    message?: string;
  };
  if (!res.ok || json.result === false) {
    throw new Error(json.message ?? `Interakt media send HTTP ${res.status}`);
  }
  return { messageId: json.id ?? json.message_id ?? null };
}

/** Send an approved template via Interakt.
 *  POST /v1/public/message/  { fullPhoneNumber, type:"Template",
 *    template:{ name, languageCode, bodyValues?, headerValues?, fileName? } } */
export async function sendInteraktTemplate(
  apiKey: string,
  toPhone: string,
  opts: {
    name: string;
    languageCode: string;
    bodyValues?: string[];
    headerValues?: string[];
    fileName?: string;
    buttonValues?: Record<string, string[]>;
  },
): Promise<InteraktSendResult> {
  const template: Record<string, unknown> = {
    name: opts.name,
    languageCode: opts.languageCode || "en",
  };
  if (opts.bodyValues?.length) template.bodyValues = opts.bodyValues;
  if (opts.headerValues?.length) template.headerValues = opts.headerValues;
  if (opts.fileName) template.fileName = opts.fileName;
  if (opts.buttonValues && Object.keys(opts.buttonValues).length) {
    template.buttonValues = opts.buttonValues;
  }

  const res = await fetch(`${INTERAKT_API_BASE}/message/`, {
    method: "POST",
    headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fullPhoneNumber: `+${digits(toPhone)}`,
      type: "Template",
      template,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    message_id?: string;
    result?: boolean;
    message?: string;
  };
  if (!res.ok || json.result === false) {
    throw new Error(json.message ?? `Interakt template send HTTP ${res.status}`);
  }
  return { messageId: json.id ?? json.message_id ?? null };
}

/** Magic Message over Interakt.
 *
 *  Plain text/media can't punch through a closed 24h window — only an
 *  approved UTILITY template can. So the Interakt Magic Message sends the
 *  `magic_message_llp` utility template with the generated/uploaded image
 *  as its header and the customer name as the body variable.
 *
 *  We FIRST fetch the template (so we send with its exact language code and
 *  only pass a body value when the template actually has a variable), then
 *  fire the send. `imageUrl` must be a public URL Interakt can fetch. */
export async function sendInteraktMagicMessage(
  apiKey: string,
  toPhone: string,
  opts: { imageUrl: string; fileName?: string; customerName: string; templateName?: string; languageCode?: string },
): Promise<InteraktSendResult> {
  const templateName = opts.templateName || "magic_message_llp";
  // Best-effort: resolve the exact language + whether the body has a
  // variable from the template list. The list API does NOT surface
  // magic_message_llp (verified — it's filtered out / lags), so a miss MUST
  // NOT block the send: Interakt's send endpoint is the real authority.
  // Default to en_US — magic_message_llp is approved under en_US (confirmed
  // via a live send; plain "en" returns "no approved template found"). The
  // body still carries a single {{1}} name var + IMAGE header.
  let language = opts.languageCode || "en_US";
  let bodyHasVar = true;
  try {
    const templates = await fetchInteraktTemplates(apiKey);
    const tpl = templates.find((t) => t.name === templateName);
    if (tpl) {
      language = tpl.language || language;
      bodyHasVar = /\{\{\s*\d+\s*\}\}/.test(tpl.body || "");
    }
  } catch {
    // List fetch failed — proceed with the defaults; the send still tries.
  }
  return sendInteraktTemplate(apiKey, toPhone, {
    name: templateName,
    languageCode: language,
    headerValues: [opts.imageUrl],
    bodyValues: bodyHasVar ? [opts.customerName] : [],
    fileName: opts.fileName,
  });
}

/** Convert a Meta-style `template_components` array (what the dashboard's
 *  template-send modal builds) into Interakt's flat value arrays. */
export function metaTemplateComponentsToInterakt(components: unknown): {
  bodyValues: string[];
  headerValues: string[];
  fileName?: string;
} {
  const bodyValues: string[] = [];
  const headerValues: string[] = [];
  let fileName: string | undefined;
  if (Array.isArray(components)) {
    for (const c of components as Array<Record<string, unknown>>) {
      const type = String(c.type ?? "").toLowerCase();
      const params = Array.isArray(c.parameters) ? (c.parameters as Array<Record<string, unknown>>) : [];
      if (type === "body") {
        for (const p of params) if (p.type === "text") bodyValues.push(String(p.text ?? ""));
      } else if (type === "header") {
        for (const p of params) {
          const pt = String(p.type ?? "").toLowerCase();
          if (pt === "text") headerValues.push(String(p.text ?? ""));
          else if (pt === "image") headerValues.push(String((p.image as { link?: string })?.link ?? ""));
          else if (pt === "video") headerValues.push(String((p.video as { link?: string })?.link ?? ""));
          else if (pt === "document") {
            const doc = p.document as { link?: string; filename?: string } | undefined;
            headerValues.push(String(doc?.link ?? ""));
            if (doc?.filename) fileName = doc.filename;
          }
        }
      }
    }
  }
  return { bodyValues, headerValues, fileName };
}

// ---------------------------------------------------------------------
// Templates — list approved/other templates from Interakt. Mapped to the
// same shape /api/templates returns for Meta so the existing picker UI
// works unchanged.
// ---------------------------------------------------------------------
export interface InteraktTemplateRow {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  header_text: string | null;
  header_format: string | null;
  header_url: string | null;
  body: string;
  footer: string | null;
  buttons: unknown[] | null;
}

// Interakt's actual template row (results.templates[]). Header media lives
// in header_handle_file_url; buttons arrive as a JSON-encoded string.
interface RawInteraktTemplate {
  id?: string | number;
  name?: string;
  language?: string;
  category?: string;
  approval_status?: string;
  status?: string;
  body?: string;
  footer?: string;
  header?: string | null;
  header_format?: string | null;
  header_handle_file_url?: string | null;
  buttons?: unknown;
}

function parseInteraktButtons(b: unknown): unknown[] | null {
  if (Array.isArray(b)) return b;
  if (typeof b === "string" && b.trim()) {
    try {
      let parsed: unknown = JSON.parse(b);
      // Interakt double-encodes — the parsed value is often itself a string.
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeInteraktTemplate(t: RawInteraktTemplate): InteraktTemplateRow {
  return {
    id: String(t.id ?? t.name ?? ""),
    name: t.name ?? "",
    language: t.language ?? "",
    category: t.category ?? "",
    status: (t.approval_status ?? t.status ?? "APPROVED").toUpperCase(),
    header_text:
      (t.header_format ?? "").toUpperCase() === "TEXT" ? t.header ?? null : null,
    header_format: t.header_format ?? null,
    header_url: t.header_handle_file_url ?? null,
    body: t.body ?? "",
    footer: t.footer ?? null,
    buttons: parseInteraktButtons(t.buttons),
  };
}

/** GET https://api.interakt.ai/v1/public/track/organization/templates
 *  Interakt only accepts a concrete approval_status (no "all"); we pull
 *  APPROVED since those are the sendable ones.
 *
 *  Interakt returns ~100 templates per page and ONLY honours `offset`
 *  (the `name` filter is silently ignored). Accounts here carry 800+
 *  templates, so a single offset=0 request misses most of them — the
 *  template picker showed "No matches" for anything past the first page.
 *  We page through until a page comes back empty. */
export async function fetchInteraktTemplates(apiKey: string): Promise<InteraktTemplateRow[]> {
  const out: InteraktTemplateRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 60; page++) {
    const qs = new URLSearchParams({ offset: String(offset), approval_status: "APPROVED" });
    const res = await fetch(`${INTERAKT_API_BASE}/track/organization/templates?${qs.toString()}`, {
      headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      results?: { templates?: RawInteraktTemplate[] };
      message?: string;
    };
    if (!res.ok) {
      if (page === 0) throw new Error(json.message ?? `Interakt templates HTTP ${res.status}`);
      break; // got some pages already — return what we have
    }
    const rows = json.results?.templates ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const norm = normalizeInteraktTemplate(r);
      if (norm.name && !seen.has(norm.name)) {
        seen.add(norm.name);
        out.push(norm);
      }
    }
    offset += rows.length;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
