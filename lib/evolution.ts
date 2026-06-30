// Typed client for the self-hosted Evolution API (Baileys-based
// unofficial WhatsApp gateway). All calls go through this module so
// the rest of the app never has to know Evolution's URL shape or
// `apikey:` header convention.
//
// Server-side only — reads EVOLUTION_SERVER_URL + EVOLUTION_GLOBAL_API_KEY
// from process.env. Per-instance API keys (issued at instance create)
// are stored on business_numbers.evolution_api_key; callers pass them
// explicitly to the send helpers so we never accidentally use the
// global key for outbound traffic.

const SERVER_URL = process.env.EVOLUTION_SERVER_URL ?? "";
const GLOBAL_KEY = process.env.EVOLUTION_GLOBAL_API_KEY ?? "";

function ensureConfigured(): void {
  if (!SERVER_URL || !GLOBAL_KEY) {
    throw new Error(
      "Evolution API not configured. Set EVOLUTION_SERVER_URL + " +
        "EVOLUTION_GLOBAL_API_KEY in .env.local.",
    );
  }
}

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Override the API key. Defaults to the global admin key — only
   *  use that for instance-management calls. For send/chat calls pass
   *  the per-instance key stored on business_numbers row. */
  apiKey?: string;
  body?: Record<string, unknown>;
  /** Per-attempt hard timeout (ms). Without it a hung Evolution instance
   *  blocks the request forever — which, in the bulk-status loop, froze
   *  the whole run. Opt-in so existing long-running calls are unaffected. */
  timeoutMs?: number;
}

async function call<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  ensureConfigured();
  const url = `${SERVER_URL.replace(/\/$/, "")}${path}`;

  // Auto-retry on Evolution's per-instance rate limit. The proxy
  // returns either HTTP 429 or a 4xx body containing "exceeded the
  // limit"; both mean "back off and try again in a few seconds". We
  // back off 5s → 10s → 20s, max 4 attempts total. Non-rate-limit
  // failures (auth, bad JSON, server bugs like the prisma jsonb
  // crash) throw immediately — retrying those just multiplies the
  // wasted requests.
  const MAX_ATTEMPTS = 4;
  const BACKOFFS_MS = [5_000, 10_000, 20_000];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        apikey: opts.apiKey ?? GLOBAL_KEY,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response — keep raw text for the error */
    }
    if (res.ok) return json as T;

    const msg =
      (json && typeof json === "object" && "message" in json
        ? String((json as { message: unknown }).message)
        : null) ?? text.slice(0, 200) ?? `HTTP ${res.status}`;

    // NOTE: WhatsApp's "rate-overlimit" on media uploads is usually PERSISTENT
    // (the number is throttled for media), not transient — retrying just holds
    // the request open for 35s and then still fails, which also corrupts other
    // in-flight sends. So we do NOT retry it; only the per-instance "exceeded
    // the limit" throttle (which clears in seconds) is retried.
    const isRateLimited =
      res.status === 429 || /exceeded the limit/i.test(msg);
    if (isRateLimited && attempt < MAX_ATTEMPTS) {
      const waitMs = BACKOFFS_MS[attempt - 1] ?? 20_000;
      console.warn(
        `[evolution] rate-limited on ${path} (attempt ${attempt}/${MAX_ATTEMPTS}) — sleeping ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Evolution ${path} failed: ${msg}`);
  }
  // Unreachable — the loop either returns or throws. Keep TS happy.
  throw new Error(`Evolution ${path} failed: exhausted retries`);
}

export interface EvolutionGroup {
  /** Group JID, e.g. "1203630...@g.us". */
  id: string;
  /** Group subject / display name. */
  subject: string;
}

/** Fetches every WhatsApp group the instance is a member of. Used by
 *  the "Sync groups" action to populate the inbox Groups list without
 *  waiting for a message to arrive. Pass the per-instance API key. */
export async function fetchEvolutionGroups(
  instanceName: string,
  apiKey: string,
): Promise<EvolutionGroup[]> {
  const data = await call<unknown>(
    `/group/fetchAllGroups/${encodeURIComponent(instanceName)}?getParticipants=false`,
    { apiKey },
  );
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((g) => {
      const o = (g ?? {}) as { id?: unknown; subject?: unknown };
      return {
        id: typeof o.id === "string" ? o.id : "",
        subject: typeof o.subject === "string" ? o.subject : "",
      };
    })
    .filter((g) => g.id.endsWith("@g.us"));
}

// ----------------------------------------------------------------- //
// Instance lifecycle                                                 //
// ----------------------------------------------------------------- //

/** The full set of Evolution webhook events we subscribe to. Centralised
 *  so createInstance + the "refresh webhook" admin endpoint stay in sync —
 *  forgetting to update both meant CALL events silently weren't delivered
 *  on legacy instances. */
export const WEBHOOK_EVENTS = [
  "QRCODE_UPDATED",
  "CONNECTION_UPDATE",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "CONTACTS_UPSERT",
  "CONTACTS_UPDATE",
  "PRESENCE_UPDATE",
  "CHATS_UPSERT",
  "CHATS_UPDATE",
  "CALL",
  // Baileys fires bulk historical messages through messaging-history.set
  // (not messages.upsert) when syncFullHistory is on. Without this
  // subscription the phone's history never reaches our webhook.
  "MESSAGING_HISTORY_SET",
] as const;

/** Refresh an existing instance's webhook URL + event subscription.
 *  Used after we add a new event to WEBHOOK_EVENTS so already-connected
 *  numbers start delivering it without a re-scan. */
export async function setInstanceWebhook(opts: {
  instanceName: string;
  apiKey: string;
  url: string;
}): Promise<void> {
  await call(`/webhook/set/${encodeURIComponent(opts.instanceName)}`, {
    method: "POST",
    apiKey: opts.apiKey,
    body: {
      webhook: {
        enabled: true,
        url: opts.url,
        byEvents: false,
        base64: true,
        events: WEBHOOK_EVENTS,
      },
    },
  });
}

export interface InstanceWebhookInfo {
  enabled: boolean;
  url: string | null;
  byEvents: boolean;
  events: string[];
}

/** Read an instance's CURRENT webhook config from Evolution — i.e. the URL
 *  it will actually POST events to, the enabled flag, and the subscribed
 *  events. Lets us diagnose drift (stale URL after a domain change, a
 *  disabled webhook, or a missing event) vs what we expect. Returns null if
 *  Evolution has no webhook on file or the read fails. */
export async function getInstanceWebhook(
  instanceName: string,
  apiKey: string,
): Promise<InstanceWebhookInfo | null> {
  try {
    const raw = await call<Record<string, unknown>>(
      `/webhook/find/${encodeURIComponent(instanceName)}`,
      { apiKey },
    );
    // Some builds wrap it as { webhook: {...} }, others return it flat.
    const w = (raw && typeof raw === "object" && "webhook" in raw
      ? (raw as { webhook: Record<string, unknown> }).webhook
      : raw) as Record<string, unknown> | null;
    if (!w || typeof w !== "object") return null;
    return {
      enabled: Boolean(w.enabled),
      url: typeof w.url === "string" ? w.url : null,
      byEvents: Boolean(w.byEvents ?? w.webhookByEvents),
      events: Array.isArray(w.events) ? (w.events as string[]) : [],
    };
  } catch {
    return null;
  }
}

export interface CreateInstanceResponse {
  instance: {
    instanceName: string;
    instanceId?: string;
    status?: string;
  };
  hash?: { apikey: string } | string;
  qrcode?: {
    code?: string;
    base64?: string;
  };
  webhook?: unknown;
}

/**
 * Create a fresh Evolution instance and immediately request its QR.
 * Returns the per-instance API key + QR base64 so the operator can
 * scan it on their phone. After scan, `getConnectionState` returns
 * `state: "open"` and the JID is available via `fetchInstance`.
 *
 * The `webhook` block here hooks Evolution's events back to our
 * dashboard's /api/evolution/webhook/<instance> route in one call —
 * cleaner than a separate POST /webhook/set after create.
 */
export async function createInstance(opts: {
  instanceName: string;
  webhookUrl: string;
}): Promise<CreateInstanceResponse> {
  return call<CreateInstanceResponse>("/instance/create", {
    method: "POST",
    body: {
      instanceName: opts.instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      // syncFullHistory tells Baileys to replay every message the phone
      // currently has after QR scan, firing them through messages.upsert
      // events that our webhook handler de-dupes by wa_message_id. Without
      // this, only forward-going messages arrive — historical chats are
      // invisible to the inbox.
      syncFullHistory: true,
      webhook: {
        url: opts.webhookUrl,
        byEvents: false,
        base64: true,
        events: WEBHOOK_EVENTS,
      },
    },
  });
}

export interface ConnectionStateResponse {
  instance: {
    instanceName: string;
    state: "open" | "connecting" | "close";
  };
}

export async function getConnectionState(
  instanceName: string,
): Promise<ConnectionStateResponse> {
  return call<ConnectionStateResponse>(
    `/instance/connectionState/${encodeURIComponent(instanceName)}`,
  );
}

export interface InstanceInfo {
  instance: {
    instanceName: string;
    instanceId: string;
    owner?: string; // WhatsApp JID (e.g. "919876543210@s.whatsapp.net")
    profileName?: string;
    profilePictureUrl?: string;
    profileStatus?: string;
    status?: string;
  };
}

/** Fetch a single instance's metadata. After scan, `owner` is the JID
 *  we use as the source-of-truth phone identifier. */
export async function fetchInstance(
  instanceName: string,
): Promise<InstanceInfo | null> {
  const all = await call<InstanceInfo[] | { instance: InstanceInfo[] }>(
    `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
  );
  // Evolution returns either an array or { instance: [...] } depending
  // on version — normalize.
  if (Array.isArray(all)) return all[0] ?? null;
  if (all && Array.isArray((all as { instance: InstanceInfo[] }).instance)) {
    return (all as { instance: InstanceInfo[] }).instance[0] ?? null;
  }
  return null;
}

/** Re-issue a QR for an existing instance that disconnected (without
 *  destroying the instance). Returns base64 QR. */
export async function reconnectInstance(
  instanceName: string,
): Promise<{ base64?: string; code?: string }> {
  return call(`/instance/connect/${encodeURIComponent(instanceName)}`);
}

/** Fetch a contact / instance's WhatsApp profile picture URL. The URL
 *  Evolution returns is a Meta-CDN link that expires in ~24h, so we
 *  re-fetch on demand rather than caching long-term. Pass the linked
 *  number's JID (e.g. "<digits>@s.whatsapp.net") OR raw digits — v2.3
 *  expects just digits in the `number` field and 500s with
 *  "Cannot read properties of undefined" otherwise. */
export async function fetchProfilePictureUrl(opts: {
  instanceName: string;
  apiKey: string;
  jidOrNumber: string;
}): Promise<string | null> {
  const number = jidToWaId(opts.jidOrNumber);
  if (!number) return null;
  try {
    const r = await call<{
      profilePictureUrl?: string;
      profilePicUrl?: string;
    }>(
      `/chat/fetchProfilePictureUrl/${encodeURIComponent(opts.instanceName)}`,
      {
        method: "POST",
        apiKey: opts.apiKey,
        body: { number },
      },
    );
    // Evolution swapped the response key between minor versions
    // (profilePictureUrl in v2.2, profilePicUrl in some v2.3 builds).
    // Accept either.
    return r?.profilePictureUrl ?? r?.profilePicUrl ?? null;
  } catch (e) {
    // Common reasons this errors: account has no pic, privacy locked
    // to contacts only, instance disconnected. Log for debugging but
    // return null so the caller falls back to initials cleanly.
    console.warn(
      "[evolution] fetchProfilePictureUrl failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export async function logoutInstance(instanceName: string): Promise<void> {
  await call(`/instance/logout/${encodeURIComponent(instanceName)}`, {
    method: "DELETE",
  });
}

export async function deleteInstance(instanceName: string): Promise<void> {
  await call(`/instance/delete/${encodeURIComponent(instanceName)}`, {
    method: "DELETE",
  });
}

// ----------------------------------------------------------------- //
// Sending messages                                                   //
// ----------------------------------------------------------------- //

export interface SendResponse {
  key: { remoteJid: string; fromMe: boolean; id: string };
  message?: unknown;
  messageTimestamp?: number | string;
  status?: string;
}

export async function sendText(opts: {
  instanceName: string;
  apiKey: string;
  number: string; // digits only, country-code included; no '@s.whatsapp.net'
  text: string;
  quotedWaMessageId?: string;
  quotedText?: string;
}): Promise<SendResponse> {
  const body: Record<string, unknown> = {
    number: opts.number,
    text: opts.text,
  };
  if (opts.quotedWaMessageId) {
    body.quoted = {
      key: { id: opts.quotedWaMessageId },
      message: { conversation: opts.quotedText ?? "" },
    };
  }
  return call<SendResponse>(
    `/message/sendText/${encodeURIComponent(opts.instanceName)}`,
    { method: "POST", apiKey: opts.apiKey, body },
  );
}

export type EvolutionMediaType = "image" | "video" | "document" | "audio";

export async function sendMedia(opts: {
  instanceName: string;
  apiKey: string;
  number: string;
  mediatype: EvolutionMediaType;
  media: string; // public URL or base64
  caption?: string;
  fileName?: string;
  mimetype?: string;
}): Promise<SendResponse> {
  return call<SendResponse>(
    `/message/sendMedia/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        number: opts.number,
        mediatype: opts.mediatype,
        media: opts.media,
        caption: opts.caption,
        fileName: opts.fileName,
        mimetype: opts.mimetype,
      },
    },
  );
}

export async function sendAudio(opts: {
  instanceName: string;
  apiKey: string;
  number: string;
  audio: string; // public URL or base64
}): Promise<SendResponse> {
  return call<SendResponse>(
    `/message/sendWhatsAppAudio/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: { number: opts.number, audio: opts.audio },
    },
  );
}

export async function sendReaction(opts: {
  instanceName: string;
  apiKey: string;
  remoteJid: string;
  fromMe: boolean;
  messageId: string;
  reaction: string; // single emoji; "" to clear
}): Promise<SendResponse> {
  return call<SendResponse>(
    `/message/sendReaction/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        key: {
          remoteJid: opts.remoteJid,
          fromMe: opts.fromMe,
          id: opts.messageId,
        },
        reaction: opts.reaction,
      },
    },
  );
}

// ----------------------------------------------------------------- //
// Per-instance settings (call rejection, read receipts, etc.)        //
// ----------------------------------------------------------------- //

export interface InstanceSettings {
  rejectCall: boolean;
  msgCall: string;
  groupsIgnore: boolean;
  alwaysOnline: boolean;
  readMessages: boolean;
  readStatus: boolean;
  syncFullHistory: boolean;
}

// ----------------------------------------------------------------- //
// History backfill                                                   //
// ----------------------------------------------------------------- //

/** Pull a page of messages from Evolution's own DB for an instance.
 *  Used by the manual "sync history" backfill — webhook events are
 *  fire-and-forget so any history Baileys delivered before our webhook
 *  was subscribed is irrecoverable via events; this endpoint reads
 *  Evolution's persisted store directly.
 *
 *  Evolution v2 returns paginated results shaped as:
 *    { messages: { total, pages, currentPage, records: [...] } }
 *  Pass `page` starting at 1 and walk until `currentPage >= pages`. */
export interface EvolutionMessagesPage {
  messages?: {
    total?: number;
    pages?: number;
    currentPage?: number;
    records?: unknown[];
  };
}

export async function findMessages(opts: {
  instanceName: string;
  apiKey: string;
  page?: number;
  pageSize?: number;
  /** Limit to one chat (e.g. a group JID). Omit for the whole instance. */
  remoteJid?: string;
}): Promise<EvolutionMessagesPage> {
  return call<EvolutionMessagesPage>(
    `/chat/findMessages/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        where: opts.remoteJid
          ? { key: { remoteJid: opts.remoteJid } }
          : {},
        page: opts.page ?? 1,
        offset: opts.pageSize ?? 100,
      },
    },
  );
}

/** Lightweight "how much does Evolution have for this instance" probe.
 *  Asks for one message + one contact and reads the `total` field from
 *  Evolution's paginated wrapper — far cheaper than enumerating either
 *  list. Used by the per-number stats card so the operator can compare
 *  Evolution-side vs locally-synced counts and tell whether a backfill
 *  is still pending. */
export async function fetchEvolutionInstanceTotals(opts: {
  instanceName: string;
  apiKey: string;
}): Promise<{ messages: number; contacts: number }> {
  // We compare CHAT THREADS, not saved phonebook entries.
  // findContacts (Evolution's address-book list) was a poor proxy:
  // a clinic talks to lots of unsaved customers, so Evolution's
  // "saved" count is structurally smaller than our `contacts` table
  // (one row per chat partner). findChats returns one entry per
  // conversation thread — same semantics as our local table — so the
  // two numbers should agree once sync-history has been run.
  //
  // We filter the same non-1:1 JIDs we drop on ingest (groups,
  // broadcasts, status, channels, newsletter) so apples-to-apples
  // holds exactly.
  const [m, ch] = await Promise.all([
    call<{ messages?: { total?: number } }>(
      `/chat/findMessages/${encodeURIComponent(opts.instanceName)}`,
      {
        method: "POST",
        apiKey: opts.apiKey,
        body: { where: {}, page: 1, offset: 1 },
      },
    ).catch(() => ({ messages: { total: 0 } })),
    call<unknown>(
      `/chat/findChats/${encodeURIComponent(opts.instanceName)}`,
      {
        method: "POST",
        apiKey: opts.apiKey,
        body: { where: {} },
      },
    ).catch(() => null),
  ]);

  // Only count JIDs that match what our webhook ingests (1:1 chats).
  // Excludes groups (@g.us), status (status@broadcast), broadcast
  // lists (@broadcast), channels / newsletters (@newsletter), and any
  // other special suffix WhatsApp may add later.
  function isOneToOne(jid: unknown): boolean {
    if (typeof jid !== "string" || jid.length === 0) return false;
    if (jid.endsWith("@g.us")) return false;
    if (jid.endsWith("@broadcast")) return false;
    if (jid.endsWith("@newsletter")) return false;
    if (jid === "status@broadcast") return false;
    return true;
  }
  function rowJid(c: unknown): string | undefined {
    if (!c || typeof c !== "object") return undefined;
    const obj = c as { remoteJid?: string; id?: string };
    return obj.remoteJid ?? obj.id ?? undefined;
  }

  let chatsTotal = 0;
  if (Array.isArray(ch)) {
    chatsTotal = ch.filter((c) => isOneToOne(rowJid(c))).length;
  } else if (ch && typeof ch === "object") {
    const obj = ch as {
      total?: number;
      chats?: { total?: number; records?: unknown[] };
    };
    if (Array.isArray(obj.chats?.records)) {
      chatsTotal = obj.chats!.records!.filter((c) =>
        isOneToOne(rowJid(c)),
      ).length;
    } else {
      // Older forks expose only `total` — assume it's already 1:1 only.
      chatsTotal = obj.total ?? obj.chats?.total ?? 0;
    }
  }
  return {
    messages: m.messages?.total ?? 0,
    contacts: chatsTotal,
  };
}

/** Pull per-recipient receipts for a single message (e.g. a status
 *  broadcast) from Evolution. This build does NOT populate `userReceipt`
 *  (it's always absent) — receipts live in the joined `MessageUpdate`
 *  array as status transitions (SERVER_ACK → DELIVERY_ACK → READ /
 *  PLAYED), with the viewer JID in `participant` when present. A READ /
 *  PLAYED entry means that recipient viewed it. Returns a normalised
 *  summary the status panel can render.
 *
 *  NOTE: WhatsApp only reports status viewers when the account's Read
 *  Receipts privacy setting is ON. With it off, no READ receipts ever
 *  arrive for status@broadcast, so viewers will legitimately read 0.
 *
 *  Evolution v2 surfaces this via the regular `/chat/findMessages`
 *  search — there's no dedicated "status views" endpoint. We filter by
 *  the message id directly so the response is one row at most. */
export interface StatusViewSummary {
  viewers: number;
  delivered: number;
  viewerJids: string[];
}

export async function fetchStatusViews(opts: {
  instanceName: string;
  apiKey: string;
  waMessageId: string;
}): Promise<StatusViewSummary> {
  const res = await call<{ messages?: { records?: unknown[] } }>(
    `/chat/findMessages/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        where: { key: { id: opts.waMessageId } },
        page: 1,
        offset: 1,
      },
    },
  ).catch(() => ({ messages: { records: [] } }));

  const records = Array.isArray(res.messages?.records)
    ? (res.messages!.records as Array<{
        MessageUpdate?: Array<{
          status?: string | number;
          participant?: string;
          remoteJid?: string;
        }>;
      }>)
    : [];
  if (records.length === 0) {
    return { viewers: 0, delivered: 0, viewerJids: [] };
  }
  const updates = records[0].MessageUpdate ?? [];

  // Normalise both the string statuses ("READ") and the numeric ones
  // some builds send (3=delivered, 4=read, 5=played).
  const norm = (s: string | number | undefined): string =>
    typeof s === "number"
      ? ({ 2: "SERVER_ACK", 3: "DELIVERY_ACK", 4: "READ", 5: "PLAYED" }[s] ??
        String(s))
      : String(s ?? "").toUpperCase();
  const READ = new Set(["READ", "PLAYED"]);
  const DELIVERED = new Set(["SERVER_ACK", "DELIVERY_ACK", "READ", "PLAYED"]);

  const viewerJids = new Set<string>();
  let viewers = 0;
  let delivered = 0;
  for (const u of updates) {
    if (!u || typeof u !== "object") continue;
    const st = norm(u.status);
    if (DELIVERED.has(st)) delivered += 1;
    if (READ.has(st)) {
      viewers += 1;
      if (typeof u.participant === "string") viewerJids.add(u.participant);
    }
  }
  // Prefer distinct viewer JIDs when Evolution includes them; otherwise
  // fall back to the READ-receipt count.
  return {
    viewers: viewerJids.size > 0 ? viewerJids.size : viewers,
    delivered,
    viewerJids: [...viewerJids],
  };
}

export async function fetchInstanceSettings(
  instanceName: string,
  apiKey: string,
): Promise<InstanceSettings> {
  const res = await call<{ rejectCall?: boolean; msgCall?: string; groupsIgnore?: boolean; alwaysOnline?: boolean; readMessages?: boolean; readStatus?: boolean; syncFullHistory?: boolean }>(
    `/settings/find/${encodeURIComponent(instanceName)}`,
    { apiKey },
  );
  return {
    rejectCall: !!res.rejectCall,
    msgCall: res.msgCall ?? "",
    groupsIgnore: !!res.groupsIgnore,
    alwaysOnline: !!res.alwaysOnline,
    readMessages: !!res.readMessages,
    readStatus: !!res.readStatus,
    syncFullHistory: !!res.syncFullHistory,
  };
}

/** Update per-instance settings on Evolution. `rejectCall` auto-rejects
 *  every incoming WhatsApp voice/video call without ringing; `msgCall`
 *  is the text message Evolution sends to the caller right after the
 *  reject (empty = no message). */
export async function updateInstanceSettings(opts: {
  instanceName: string;
  apiKey: string;
  patch: Partial<InstanceSettings>;
}): Promise<void> {
  await call(`/settings/set/${encodeURIComponent(opts.instanceName)}`, {
    method: "POST",
    apiKey: opts.apiKey,
    body: opts.patch as Record<string, unknown>,
  });
}

// ----------------------------------------------------------------- //
// Status / Story                                                     //
// ----------------------------------------------------------------- //

export type StatusType = "text" | "image" | "video" | "audio";

/** Post a WhatsApp Status (the 24-hour "story" surface). Visible to
 *  the contacts in `statusJidList`, or to all saved contacts when
 *  `allContacts` is true. Text statuses accept an optional bg color
 *  hex + a font index 0..5 to match the official UI's font picker. */
export async function sendStatus(opts: {
  instanceName: string;
  apiKey: string;
  type: StatusType;
  /** For type=text → the status text. For media → a public URL. */
  content: string;
  caption?: string;
  backgroundColor?: string;
  font?: number;
  statusJidList?: string[];
  allContacts?: boolean;
  timeoutMs?: number;
}): Promise<SendResponse> {
  return call<SendResponse>(
    `/message/sendStatus/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      body: {
        type: opts.type,
        content: opts.content,
        caption: opts.caption,
        backgroundColor: opts.backgroundColor,
        font: opts.font,
        statusJidList: opts.statusJidList,
        allContacts: opts.allContacts ?? true,
      },
    },
  );
}

// ----------------------------------------------------------------- //
// Chat operations — edit, delete, presence, read receipts            //
// ----------------------------------------------------------------- //

/** Edit a previously-sent text message. Evolution / WhatsApp Web
 *  allows this within 15 minutes of the original send.
 *
 *  v2.3 requires `number` at the top level — internally it does a
 *  `number.replace(/\D/g, "")` to derive the JID, and crashes with a
 *  500 "Cannot read properties of undefined (reading 'replace')" when
 *  the field is missing. We derive it from the remoteJid. */
export async function editMessage(opts: {
  instanceName: string;
  apiKey: string;
  remoteJid: string;
  messageId: string;
  newText: string;
}): Promise<SendResponse> {
  const number = jidToWaId(opts.remoteJid);
  return call<SendResponse>(
    `/chat/updateMessage/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        number,
        key: { remoteJid: opts.remoteJid, fromMe: true, id: opts.messageId },
        text: opts.newText,
      },
    },
  );
}

/** Delete for everyone — Evolution supports this. */
export async function deleteMessage(opts: {
  instanceName: string;
  apiKey: string;
  remoteJid: string;
  messageId: string;
  fromMe?: boolean;
}): Promise<void> {
  await call(
    `/chat/deleteMessageForEveryone/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "DELETE",
      apiKey: opts.apiKey,
      body: {
        id: opts.messageId,
        remoteJid: opts.remoteJid,
        fromMe: opts.fromMe ?? true,
      },
    },
  );
}

export async function markAsRead(opts: {
  instanceName: string;
  apiKey: string;
  remoteJid: string;
  messageId: string;
  fromMe?: boolean;
}): Promise<void> {
  await call(
    `/chat/markMessageAsRead/${encodeURIComponent(opts.instanceName)}`,
    {
      method: "POST",
      apiKey: opts.apiKey,
      body: {
        readMessages: [
          {
            remoteJid: opts.remoteJid,
            fromMe: opts.fromMe ?? false,
            id: opts.messageId,
          },
        ],
      },
    },
  );
}

export type Presence =
  | "available"
  | "composing"
  | "recording"
  | "paused"
  | "unavailable";

export async function sendPresence(opts: {
  instanceName: string;
  apiKey: string;
  number: string;
  presence: Presence;
  delay?: number;
}): Promise<void> {
  await call(`/chat/sendPresence/${encodeURIComponent(opts.instanceName)}`, {
    method: "POST",
    apiKey: opts.apiKey,
    body: {
      number: opts.number,
      presence: opts.presence,
      delay: opts.delay ?? 1200,
    },
  });
}

// ----------------------------------------------------------------- //
// Helpers                                                            //
// ----------------------------------------------------------------- //

/** Strip the JID suffix ("@s.whatsapp.net" / "@g.us") and return just
 *  the digits — matches the shape we already use for contacts.wa_id. */
export function jidToWaId(jid: string): string {
  return jid.replace(/@.*/, "").replace(/\D/g, "");
}

// Re-exported from lib/phone for convenience — server-side callers that
// already pull from lib/evolution shouldn't need a second import.
export { isWaIdLikelyReal } from "@/lib/phone";

/** Build a 1-on-1 chat JID from a contacts.wa_id (digits only). */
export function waIdToJid(waId: string): string {
  return `${waId.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** Build the public webhook URL Evolution should POST events to. Throws if
 *  the public base URL isn't configured — registering a relative URL would
 *  silently break inbound delivery (Evolution would never reach us), so we
 *  fail loudly at create/refresh time instead. */
export function webhookUrlFor(instanceName: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL (or APP_URL) is not set — cannot register a valid " +
        "Evolution webhook. Set it so inbound messages can reach the app.",
    );
  }
  return `${base}/api/evolution/webhook/${encodeURIComponent(instanceName)}`;
}

export function isEvolutionConfigured(): boolean {
  return Boolean(SERVER_URL && GLOBAL_KEY);
}
