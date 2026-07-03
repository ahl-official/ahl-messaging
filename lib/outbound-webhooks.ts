// Outbound webhook fan-out.
//
// Whenever a noteworthy event happens on a business phone number
// (inbound message of any type, status update, call event, campaign
// progress, etc.) the inbound webhook handler / sender code calls
// `dispatchOutboundWebhook` with a typed payload. We look up every
// enabled outbound_webhooks row for that BPID and fire a POST to each
// URL in the background.
//
// Delivery is fire-and-forget — slow / dead URLs MUST NOT block message
// processing. We swallow errors but record the last attempt's status
// code and any error string back onto the row so operators can see at a
// glance if their endpoint is healthy.
//
// Security: each webhook gets a unique HMAC secret. We sign the raw
// request body with HMAC-SHA256 and send it as `X-AHL-Signature`
// (`sha256=<hex>` style, like Meta's own format). Receivers should
// recompute this and compare in constant time before trusting the body.

import crypto from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

export interface OutboundEvent {
  /** Coarse-grained event family — easy to filter on in n8n / Make. */
  type:
    | "message.inbound"
    | "message.status"
    | "call.event"
    | "campaign.recipient.update"
    | string;
  /** Phone number the event happened on. */
  business_phone_number_id: string;
  /** ISO timestamp of when *we* observed the event. */
  occurred_at: string;
  /** Free-form event-specific payload. */
  data: Record<string, unknown>;
}

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  enabled: boolean;
}

/** Generate a fresh secret for a new webhook subscription. */
export function generateWebhookSecret(): string {
  return "whsec_" + crypto.randomBytes(24).toString("hex");
}

/** CRM's WhatsApp ("haptik"/Interakt) inbound connector. It does
 *  NOT understand our generic event shape — it reads
 *  `data.customer.channel_phone_number` + `data.message`, so a raw event
 *  POST 400s with "Cannot read properties of undefined". We detect these
 *  URLs and re-shape the body into the Interakt envelope they expect. */
function isLsqConnector(url: string): boolean {
  return /leadsquaredapps\.com\/inbound\//i.test(url) || /\/haptik\b/i.test(url);
}

/** Pull display text out of a raw Meta inbound message object. */
function metaMessageText(raw: Record<string, unknown>, type: string): string {
  const t = (k: string) => (raw[k] as { body?: string; caption?: string; text?: string; filename?: string } | undefined);
  switch (type) {
    case "text": return t("text")?.body ?? "";
    case "image": return t("image")?.caption ?? "";
    case "video": return t("video")?.caption ?? "";
    case "document": return t("document")?.caption ?? t("document")?.filename ?? "";
    case "button": return t("button")?.text ?? "";
    default: {
      const it = raw["interactive"] as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
      return it?.button_reply?.title ?? it?.list_reply?.title ?? "";
    }
  }
}

/** Re-shape one of our events into the Interakt/Haptik envelope LSQ's
 *  connector parses. Only inbound customer messages map cleanly — status
 *  / call events have no `customer`+`message` pair, so we return null and
 *  skip delivery to LSQ for those. */
function buildLsqBody(event: OutboundEvent): string | null {
  if (event.type !== "message.inbound") return null;
  const d = event.data as {
    wa_id?: string;
    wa_message_id?: string;
    type?: string;
    profile_name?: string | null;
    raw?: Record<string, unknown>;
  };
  const waId = String(d.wa_id ?? "").trim();
  if (!waId) return null;
  const msgType = String(d.type ?? "text");
  return JSON.stringify({
    type: "message_received",
    timestamp: event.occurred_at,
    data: {
      customer: {
        channel_phone_number: waId,
        phone_number: waId,
        country_code: "",
        traits: { name: d.profile_name ?? null },
      },
      message: {
        id: d.wa_message_id ?? "",
        message: metaMessageText(d.raw ?? {}, msgType),
        message_content_type: msgType,
        received_at_utc: event.occurred_at,
        chat_message_type: "CustomerMessage",
        is_inbound: true,
      },
    },
  });
}

/**
 * Fan-out an event to every enabled webhook for a given BPID. Returns
 * immediately (Promise resolves once dispatch tasks have been *queued*,
 * not awaited) — callers should not await this if they're on the hot
 * path of message processing.
 */
export async function dispatchOutboundWebhook(event: OutboundEvent): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: rows } = await admin
    .from("outbound_webhooks")
    .select("id, url, secret, enabled")
    .eq("business_phone_number_id", event.business_phone_number_id)
    .eq("enabled", true);

  const subs = (rows ?? []) as WebhookRow[];
  if (subs.length === 0) return;

  const genericBody = JSON.stringify(event);

  // Fire each in the background. We don't await so a slow webhook
  // can't backpressure the caller. Each task records its own outcome.
  for (const sub of subs) {
    // LSQ connector URLs get the Interakt-shaped body; everything else
    // gets our generic event JSON. Non-inbound events to an LSQ URL have
    // no usable mapping → skip (don't rack up guaranteed 400s).
    let body = genericBody;
    if (isLsqConnector(sub.url)) {
      const lsqBody = buildLsqBody(event);
      if (!lsqBody) continue;
      body = lsqBody;
    }
    void deliverOne(sub, body, event.type);
  }
}

async function deliverOne(sub: WebhookRow, body: string, eventType: string): Promise<void> {
  const admin = createServiceRoleClient();
  const signature = "sha256=" + crypto
    .createHmac("sha256", sub.secret)
    .update(body)
    .digest("hex");

  let statusCode: number | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AHL-Signature": signature,
        "X-AHL-Event": eventType,
      },
      body,
      // 10s ceiling — receivers shouldn't be doing heavy work in their
      // webhook handler. Anything slower than this is treated as a
      // failure for this attempt.
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      errorMsg = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : "fetch failed";
  }

  const ok = !errorMsg;
  // Read-then-write the counter — small race window is fine for
  // monitoring stats (we accept ±1 under concurrent fan-out).
  const { data: existing } = await admin
    .from("outbound_webhooks")
    .select("delivery_count, failure_count")
    .eq("id", sub.id)
    .maybeSingle();
  const dc = (existing?.delivery_count as number | undefined) ?? 0;
  const fc = (existing?.failure_count as number | undefined) ?? 0;

  await admin
    .from("outbound_webhooks")
    .update({
      last_attempt_at: new Date().toISOString(),
      last_status_code: statusCode,
      last_error: errorMsg,
      delivery_count: ok ? dc + 1 : dc,
      failure_count: ok ? fc : fc + 1,
    })
    .eq("id", sub.id);
}
