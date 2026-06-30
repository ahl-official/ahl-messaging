// Campaign worker — picks pending recipients off active campaigns and
// sends each one via WhatsApp Cloud API. Called from the in-process
// scheduler (instrumentation.ts) every 30s.
//
// Two modes share the same recipient loop:
//   • template campaigns send a pre-approved template via sendTemplate
//   • magic_message campaigns generate text per-recipient via OpenAI
//     against the configured persona, then send via sendTextMessage
//
// Webhook ingest (already wired) updates each recipient's
// delivered/read/replied state by matching wa_message_id, and STOP
// replies append to campaign_unsubscribes so future campaigns skip them.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getApiVersion, sendTemplate } from "@/lib/whatsapp";
import { requireCredential } from "@/lib/credentials";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { resolveTemplateCreds } from "@/lib/template-creds";
import { renderMagicCardPng } from "@/lib/magic-card";
import { getInteraktApiKeyForNumber, fetchInteraktTemplates, sendInteraktTemplate, sendInteraktMagicMessage } from "@/lib/interakt";
import { uploadMediaBytes } from "@/lib/storage";

export interface CampaignTickResult {
  scanned: number;
  sent: number;
  failed: number;
}

interface CampaignRow {
  id: string;
  type: "template" | "magic_message";
  status: string;
  business_phone_number_id: string;
  template_name: string | null;
  template_language: string | null;
  template_components: unknown;
  template_body_preview: string | null;
  template_media_url: string | null;
  magic_prompt: string | null;
  magic_persona_override: string | null;
  magic_tone: string | null;
  schedule_at: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  rate_limit_per_minute: number;
  total_recipients: number;
  sent_count: number;
}

interface RecipientRow {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  wa_id: string;
  display_name: string | null;
  variables: Record<string, string>;
  status: string;
}

/**
 * One worker tick. Picks all `scheduled` / `sending` campaigns whose
 * schedule_at has passed (or is null), sends up to `rate_limit / 2`
 * recipients each (we run twice per minute), then marks the campaign
 * as `completed` when all recipients have a terminal status.
 */
export async function runCampaignTick(): Promise<CampaignTickResult> {
  const admin = createServiceRoleClient();

  // 1) Promote 'scheduled' → 'sending' when schedule_at has elapsed.
  await admin
    .from("campaigns")
    .update({ status: "sending", started_at: new Date().toISOString() })
    .eq("status", "scheduled")
    .lte("schedule_at", new Date().toISOString())
    .select("id");

  // Also promote scheduled rows with no schedule_at (= "send now").
  await admin
    .from("campaigns")
    .update({ status: "sending", started_at: new Date().toISOString() })
    .eq("status", "scheduled")
    .is("schedule_at", null)
    .select("id");

  // 1b) Orphan recovery — a recipient is claimed (status 'sending') right
  // before dispatch; if the worker process dies mid-tick (deploy/restart,
  // a hung send), it's left stuck in 'sending' forever because the tick
  // only picks up 'pending'. Reset any 'sending' row untouched for >3 min
  // back to 'pending' so the next tick re-sends it.
  const staleCutoff = new Date(Date.now() - 3 * 60_000).toISOString();
  await admin
    .from("campaign_recipients")
    .update({ status: "pending" })
    .eq("status", "sending")
    .lt("updated_at", staleCutoff);

  // 2) Fetch active sending campaigns.
  const { data: campaigns } = await admin
    .from("campaigns")
    .select("*")
    .eq("status", "sending");

  let totalSent = 0;
  let totalFailed = 0;

  for (const c of (campaigns ?? []) as CampaignRow[]) {
    if (isInQuietHours(c.quiet_hours_start, c.quiet_hours_end)) continue;

    const batch = Math.max(1, Math.floor((c.rate_limit_per_minute || 30) / 2));
    const { data: pending } = await admin
      .from("campaign_recipients")
      .select("*")
      .eq("campaign_id", c.id)
      .eq("status", "pending")
      .limit(batch);

    const recipients = (pending ?? []) as RecipientRow[];
    if (recipients.length === 0) {
      // No more pending — close out the campaign if everyone has a
      // terminal status (sent/delivered/read/replied/failed/skipped/unsubscribed).
      const { count } = await admin
        .from("campaign_recipients")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", c.id)
        .in("status", ["pending", "sending"]);
      if ((count ?? 0) === 0) {
        await admin
          .from("campaigns")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", c.id);
      }
      continue;
    }

    for (const r of recipients) {
      // Skip globally-unsubscribed wa_ids without burning a send.
      const { data: optOut } = await admin
        .from("campaign_unsubscribes")
        .select("wa_id")
        .eq("wa_id", r.wa_id)
        .eq("business_phone_number_id", c.business_phone_number_id)
        .maybeSingle();
      if (optOut) {
        await admin
          .from("campaign_recipients")
          .update({ status: "unsubscribed" })
          .eq("id", r.id);
        await admin.rpc("noop").select().limit(0); // no-op (counter bump below)
        await admin
          .from("campaigns")
          .update({ unsubscribed_count: c.total_recipients }) // approximate; recompute below
          .eq("id", c.id);
        continue;
      }

      // Send-once guard — if this wa_id already RECEIVED this same template on
      // this number in ANY campaign, skip it (the same offer must never reach
      // someone twice). Only successful deliveries count — a FAILED attempt
      // never reached the person, so it stays retryable (via "Retry failed").
      if (c.template_name) {
        const { data: prior } = await admin
          .from("campaign_recipients")
          .select("id, campaigns!inner(template_name, business_phone_number_id)")
          .eq("wa_id", r.wa_id)
          .neq("id", r.id)
          .in("status", ["sent", "delivered", "read", "replied"])
          .eq("campaigns.template_name", c.template_name)
          .eq("campaigns.business_phone_number_id", c.business_phone_number_id)
          .limit(1);
        if (prior && prior.length > 0) {
          await admin
            .from("campaign_recipients")
            .update({ status: "skipped", failed_reason: "Already sent this template earlier (send-once)" })
            .eq("id", r.id);
          continue;
        }
      }

      // Mark as 'sending' to claim the row, then dispatch.
      await admin
        .from("campaign_recipients")
        .update({ status: "sending" })
        .eq("id", r.id);

      try {
        const result = await sendOne(c, r);
        await admin
          .from("campaign_recipients")
          .update({
            status: "sent",
            wa_message_id: result.wa_message_id ?? null,
            sent_at: new Date().toISOString(),
            generated_text: result.generated_text ?? null,
            prompt_tokens: result.prompt_tokens ?? null,
            completion_tokens: result.completion_tokens ?? null,
          })
          .eq("id", r.id);
        // Log the send into `messages` (creating the contact if needed) so
        // the campaign shows up in the chat AND a template-reply trigger
        // can see the preceding outbound template when the patient taps a
        // button. Without this, campaign templates exist only on
        // campaign_recipients — invisible to the chat and the trigger engine.
        if (result.wa_message_id) {
          await logCampaignSend(
            admin,
            c,
            r,
            result.wa_message_id,
            result.generated_text ?? null,
            result.header_media_url ?? null,
            result.header_media_mime ?? null,
          );
        }
        totalSent++;
      } catch (e) {
        const reason = e instanceof Error ? e.message : "send failed";
        // Pull the Meta error code out of the message text when present
        // — sendOne re-throws "Meta API X: ...code Y..." style strings.
        // Lets the detail UI group failures by code (131026, 131056,
        // 100, etc.) without a second JSON parse.
        const codeMatch = reason.match(/code[\s:]+(\d{3,5})|\(#(\d{3,5})\)/i);
        const errorCode = codeMatch?.[1] ?? codeMatch?.[2] ?? null;
        // Mark failed using ONLY guaranteed columns. Previously this wrote
        // `error_code` in the same update; on a schema where that column is
        // missing the WHOLE update fails, leaving the recipient stuck in
        // 'sending' forever (the worker only re-picks 'pending'). The code
        // is embedded in failed_reason so it's never lost.
        await admin
          .from("campaign_recipients")
          .update({
            status: "failed",
            failed_reason: (errorCode ? `(#${errorCode}) ${reason}` : reason).slice(0, 500),
          })
          .eq("id", r.id);
        // Best-effort: store the parsed code in its own column for the
        // failure-breakdown grouping. Tolerate the column being absent.
        if (errorCode) {
          const { error: ecErr } = await admin
            .from("campaign_recipients")
            .update({ error_code: errorCode })
            .eq("id", r.id);
          if (ecErr) {
            console.warn(
              `[campaigns] error_code column missing — run migration 0093. (${ecErr.message})`,
            );
          }
        }
        totalFailed++;
      }
    }

    // Recompute counters from the source of truth.
    await recomputeCounters(c.id);
  }

  return { scanned: (campaigns ?? []).length, sent: totalSent, failed: totalFailed };
}

/** Substitute {{1}}/{{name}}/{{key}} placeholders in a template body for
 *  the chat-preview content. display_name fills {{1}} and {{name}}. */
function renderTemplateText(body: string, r: RecipientRow): string {
  const vars: Record<string, string> = { ...(r.variables ?? {}) };
  if (r.display_name) {
    vars.name = vars.name ?? r.display_name;
    vars["1"] = vars["1"] ?? r.display_name;
  }
  return (body ?? "").replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k) => vars[k] ?? "");
}

/** Mirror a successful campaign send into `messages` + ensure the contact
 *  exists. Best-effort — a logging failure must never fail the send. */
async function logCampaignSend(
  admin: ReturnType<typeof createServiceRoleClient>,
  c: CampaignRow,
  r: RecipientRow,
  waMessageId: string,
  generatedText: string | null,
  headerMediaUrl: string | null = null,
  headerMediaMime: string | null = null,
): Promise<void> {
  try {
    let contactId = r.contact_id;
    if (!contactId) {
      // A campaign send must NOT open the conversation — these go to
      // closed-window contacts and should stay under "Closed" until the
      // customer replies (the inbound webhook flips them to "open"). So a
      // new contact is created as 'closed', and an existing contact's status
      // is left untouched (never reopened by an outbound campaign).
      const { data: existing } = await admin
        .from("contacts")
        .select("id")
        .eq("wa_id", r.wa_id)
        .eq("business_phone_number_id", c.business_phone_number_id)
        .maybeSingle();
      if (existing?.id) {
        contactId = existing.id as string;
      } else {
        const { data: ins } = await admin
          .from("contacts")
          .insert({
            wa_id: r.wa_id,
            business_phone_number_id: c.business_phone_number_id,
            profile_name: r.display_name ?? null,
            status: "closed",
          })
          .select("id")
          .single();
        contactId = (ins?.id as string | undefined) ?? null;
      }
      if (contactId) {
        await admin.from("campaign_recipients").update({ contact_id: contactId }).eq("id", r.id);
      }
    }
    if (!contactId) return;

    const isTemplate = c.type === "template";
    const content =
      generatedText ??
      (isTemplate ? renderTemplateText(c.template_body_preview ?? "", r) : "");
    const nowIso = new Date().toISOString();
    await admin.from("messages").insert({
      contact_id: contactId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: isTemplate ? "template" : "text",
      template_name: isTemplate ? c.template_name : null,
      content,
      media_url: headerMediaUrl,
      media_mime_type: headerMediaMime,
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: c.business_phone_number_id,
    });
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: content.slice(0, 120),
        last_message_direction: "outbound",
        last_message_status: "sent",
      })
      .eq("id", contactId);
  } catch (e) {
    console.warn("[campaigns] message log failed:", e instanceof Error ? e.message : e);
  }
}

interface SendResult {
  wa_message_id?: string | null;
  generated_text?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  /** Header media sent with a template — logged so the inbox renders it. */
  header_media_url?: string | null;
  header_media_mime?: string | null;
}

// Resolve a template's OWN approved header media (image/video/document) and
// upload it to the sending number so it can be sent as a reusable media_id.
// Lets image-header templates send without the operator manually attaching a
// file (else Meta rejects every recipient with #132012). Cached per
// number+template for the whole campaign run — one upload, reused for all
// recipients.
type TemplateHeaderMedia = {
  type: "image" | "video" | "document";
  id: string;
  /** Public sample URL — stored on the logged message so the inbox shows it. */
  url: string;
  mime: string;
};
const templateHeaderCache = new Map<string, TemplateHeaderMedia | null>();

async function resolveTemplateHeaderMedia(
  phoneNumberId: string,
  templateName: string,
  language: string,
): Promise<TemplateHeaderMedia | null> {
  const cacheKey = `${phoneNumberId}:${templateName}:${language}`;
  const cached = templateHeaderCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: TemplateHeaderMedia | null = null;
  try {
    const creds = await resolveTemplateCreds({ phoneNumberId });
    const numberCreds = await resolveCredsForPhoneNumberId(phoneNumberId);
    if (creds && numberCreds) {
      const apiVersion = await getApiVersion();
      const wabas = [creds.waba, creds.fallbackWaba].filter(Boolean) as string[];
      type MetaComp = { type?: string; format?: string; example?: { header_handle?: string[] } };
      type MetaTpl = { name?: string; language?: string; components?: MetaComp[] };
      let tpl: MetaTpl | null = null;
      for (const waba of wabas) {
        for (const token of creds.candidateTokens) {
          const res = await fetch(
            `https://graph.facebook.com/${apiVersion}/${waba}/message_templates?name=${encodeURIComponent(templateName)}&access_token=${token}`,
          );
          const j = (await res.json()) as { data?: MetaTpl[] };
          const list = j?.data ?? [];
          tpl = list.find((t) => t.name === templateName && (!language || t.language === language)) ?? list[0] ?? null;
          if (tpl) break;
        }
        if (tpl) break;
      }
      const header = (tpl?.components ?? []).find((cc) => cc.type === "HEADER");
      const fmt = (header?.format ?? "").toUpperCase();
      const sample = header?.example?.header_handle?.[0];
      if (sample && (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT")) {
        const bytes = Buffer.from(await (await fetch(sample)).arrayBuffer());
        const mime = fmt === "VIDEO" ? "video/mp4" : fmt === "DOCUMENT" ? "application/pdf" : "image/jpeg";
        const ext = fmt === "VIDEO" ? "mp4" : fmt === "DOCUMENT" ? "pdf" : "jpg";
        const fd = new FormData();
        fd.append("messaging_product", "whatsapp");
        fd.append("type", mime);
        fd.append("file", new Blob([bytes], { type: mime }), `header.${ext}`);
        const up = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`, {
          method: "POST",
          headers: { Authorization: `Bearer ${numberCreds.access_token}` },
          body: fd,
        });
        const uj = (await up.json()) as { id?: string };
        if (uj?.id) {
          result = {
            type: fmt === "VIDEO" ? "video" : fmt === "DOCUMENT" ? "document" : "image",
            id: uj.id,
            url: sample,
            mime,
          };
        }
      }
    }
  } catch {
    result = null;
  }
  templateHeaderCache.set(cacheKey, result);
  return result;
}

async function sendOne(c: CampaignRow, r: RecipientRow): Promise<SendResult> {
  const isInterakt = c.business_phone_number_id.startsWith("interakt:");

  if (c.type === "template") {
    if (!c.template_name) throw new Error("template_name missing on campaign");
    if (isInterakt) return sendInteraktTemplateCampaign(c, r);
    // Components dispatch — three paths in priority order:
    //   1. Operator passed ready-made template_components → just substitute
    //      {{name}} / {{1}} placeholders inside the strings.
    //   2. Otherwise auto-build a body component from the recipient's
    //      variables, using either positional ({{1}}, {{2}}…) or named
    //      ({{name}}, {{date}}…) keys parsed off template_body_preview.
    //   3. If the template has no placeholders at all, send with no
    //      components (sendTemplate strips them when undefined).
    let components = applyTemplateVars(c.template_components, r.variables, r.display_name);
    if (!components || components.length === 0) {
      components = buildBodyComponents(c.template_body_preview ?? "", r.variables, r.display_name);
    }
    // Image/video/document header — templates with a media HEADER need the
    // media supplied per send (else Meta rejects with #132012). When the
    // operator set a header media URL, prepend the header component.
    const hasHeader = Array.isArray(components) && components.some(
      (x) => (x as { type?: string })?.type === "header",
    );
    // Header media is resolved for TWO independent purposes:
    //   • attach it to the send (only when components don't already carry a
    //     header) so Meta doesn't reject media-header templates with #132012;
    //   • log a media_url on the message so the inbox renders the image —
    //     done WHENEVER the template has a media header, even if the header
    //     was already present in template_components (else half the sends
    //     show no image in the chat).
    let headerMediaUrl: string | null = null;
    let headerMediaMime: string | null = null;
    const mediaUrl = (c.template_media_url ?? "").trim();
    if (mediaUrl) {
      const isVideo = /\.(mp4|mov|3gp)(\?|$)/i.test(mediaUrl);
      const isPdf = /\.pdf(\?|$)/i.test(mediaUrl);
      if (!hasHeader) {
        const headerParam = isVideo
          ? { type: "video", video: { link: mediaUrl } }
          : isPdf
            ? { type: "document", document: { link: mediaUrl } }
            : { type: "image", image: { link: mediaUrl } };
        components = [{ type: "header", parameters: [headerParam] }, ...(components ?? [])];
      }
      headerMediaUrl = mediaUrl;
      headerMediaMime = isVideo ? "video/mp4" : isPdf ? "application/pdf" : "image/jpeg";
    } else {
      // Resolve the template's own approved header media (cached per
      // number+template). No-op for text-only templates.
      const auto = await resolveTemplateHeaderMedia(
        c.business_phone_number_id,
        c.template_name,
        c.template_language || "en",
      );
      if (auto) {
        if (!hasHeader) {
          const headerParam =
            auto.type === "video"
              ? { type: "video", video: { id: auto.id } }
              : auto.type === "document"
                ? { type: "document", document: { id: auto.id } }
                : { type: "image", image: { id: auto.id } };
          components = [{ type: "header", parameters: [headerParam] }, ...(components ?? [])];
        }
        headerMediaUrl = auto.url;
        headerMediaMime = auto.mime;
      }
    }
    const resp = await sendTemplate(
      r.wa_id,
      c.template_name,
      c.template_language || "en",
      components,
      c.business_phone_number_id,
    );
    return {
      wa_message_id: resp.messages?.[0]?.id ?? null,
      header_media_url: headerMediaUrl,
      header_media_mime: headerMediaMime,
    };
  }

  // magic_message branch — same pipeline as the chat-board Magic Message:
  //   1. Generate per-recipient text via OpenAI persona
  //   2. Render that text onto a magic-card PNG (next/og)
  //   3. Upload the PNG to Meta → media_id
  //   4. Send the `magic_message` UTILITY template with that image as
  //      the header. Utility template = punches through the 24h window,
  //      so re-engagement campaigns don't silently fail to deliver.
  const generated = await generateMagicBody(c, r);
  if (isInterakt) return sendInteraktMagicCampaign(c, r, generated);

  // The card renderer caps at 600 chars (matches the chat-board limit).
  // Truncate gracefully if the model overshoots so we don't 400 here.
  const cardText = generated.text.length > 600
    ? generated.text.slice(0, 597).trimEnd() + "…"
    : generated.text;
  const card = await renderMagicCardPng({
    text: cardText,
    agentName: "AHL Team",
  });

  const creds = await resolveCredsForPhoneNumberId(c.business_phone_number_id);
  if (!creds) {
    throw new Error(
      `No portfolio creds for phone_number_id ${c.business_phone_number_id}`,
    );
  }
  const apiVersion = await getApiVersion();
  const metaForm = new FormData();
  metaForm.append("messaging_product", "whatsapp");
  metaForm.append("type", card.mime);
  metaForm.append(
    "file",
    new Blob([card.bytes], { type: card.mime }),
    `magic-${Date.now()}.${card.mime.split("/")[1] ?? "png"}`,
  );
  const metaRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${c.business_phone_number_id}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.access_token}` },
      body: metaForm,
    },
  );
  const metaJson = (await metaRes.json()) as { id?: string; error?: { message?: string } };
  if (!metaRes.ok || !metaJson.id) {
    throw new Error(metaJson.error?.message ?? `Meta upload HTTP ${metaRes.status}`);
  }

  const customerName = r.display_name?.trim() || r.variables?.name || "there";
  const components = [
    { type: "header", parameters: [{ type: "image", image: { id: metaJson.id } }] },
    { type: "body", parameters: [{ type: "text", text: customerName }] },
  ];
  const resp = await sendTemplate(
    r.wa_id,
    "magic_message",
    "en_US",
    components,
    c.business_phone_number_id,
  );
  return {
    wa_message_id: resp.messages?.[0]?.id ?? null,
    generated_text: generated.text,
    prompt_tokens: generated.prompt_tokens ?? null,
    completion_tokens: generated.completion_tokens ?? null,
  };
}

// ---------------------------------------------------------------------
// Interakt template send for a campaign recipient. Builds the body values via
// the same {{name}}/{{1}} substitution as the Meta path, then sends via
// Interakt's API. Body-only — header media isn't carried on Interakt sends.
// ---------------------------------------------------------------------
async function sendInteraktTemplateCampaign(c: CampaignRow, r: RecipientRow): Promise<SendResult> {
  if (!c.template_name) throw new Error("template_name missing on campaign");
  const apiKey = await getInteraktApiKeyForNumber(c.business_phone_number_id);
  if (!apiKey) throw new Error(`No Interakt API key for ${c.business_phone_number_id}`);

  // Ordered body values — reuse the Meta-component substitution, then pull the
  // body parameters' text out.
  let comps = applyTemplateVars(c.template_components, r.variables, r.display_name);
  if (!comps || comps.length === 0) {
    comps = buildBodyComponents(c.template_body_preview ?? "", r.variables, r.display_name);
  }
  const bodyComp = (comps ?? []).find((x) => (x as { type?: string })?.type === "body") as
    | { parameters?: { text?: string }[] }
    | undefined;
  const bodyValues = (bodyComp?.parameters ?? []).map((p) => p.text ?? "");

  // Resolve the exact language + var count from the live template.
  const tpls = await fetchInteraktTemplates(apiKey).catch(() => []);
  const short = (c.template_language || "en").split(/[_-]/)[0];
  const tpl =
    tpls.find((t) => t.name === c.template_name && (t.language === c.template_language || t.language === short)) ??
    tpls.find((t) => t.name === c.template_name);
  const varCount = ((tpl?.body ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
  const fallback = r.display_name?.trim() || r.variables?.name || "there";
  while (varCount && bodyValues.length < varCount) bodyValues.push(fallback);

  // Media header — templates with an image/video/document header need the
  // media URL passed per send (else Interakt rejects: "Media Url is missing
  // for header's image"). Prefer the campaign's own media URL, else the
  // template's approved header sample.
  const opMediaUrl = (c.template_media_url ?? "").trim();
  const headerFmt = (tpl?.header_format ?? "").toUpperCase();
  const isMediaHeader = !!opMediaUrl || !!tpl?.header_url || ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFmt);
  const mediaUrl = opMediaUrl || tpl?.header_url || "";
  const headerValues = isMediaHeader && mediaUrl ? [mediaUrl] : undefined;

  const resp = await sendInteraktTemplate(apiKey, r.wa_id, {
    name: c.template_name,
    languageCode: tpl?.language || c.template_language || "en",
    bodyValues: varCount ? bodyValues.slice(0, varCount) : bodyValues,
    headerValues,
  });
  return { wa_message_id: resp.messageId ?? null, header_media_url: headerValues?.[0] ?? null };
}

// ---------------------------------------------------------------------
// Interakt Magic Message for a campaign recipient. Renders the per-recipient
// card, uploads it for a public URL Interakt can fetch, then sends the
// magic_message utility template with that image as the header.
// ---------------------------------------------------------------------
async function sendInteraktMagicCampaign(
  c: CampaignRow,
  r: RecipientRow,
  generated: { text: string; prompt_tokens?: number; completion_tokens?: number },
): Promise<SendResult> {
  const apiKey = await getInteraktApiKeyForNumber(c.business_phone_number_id);
  if (!apiKey) throw new Error(`No Interakt API key for ${c.business_phone_number_id}`);

  const cardText = generated.text.length > 600 ? generated.text.slice(0, 597).trimEnd() + "…" : generated.text;
  const card = await renderMagicCardPng({ text: cardText, agentName: "AHL Team" });
  const uploaded = await uploadMediaBytes(card.bytes, { mime: card.mime, folder: "outbound", suggestedName: "magic-message" });

  const customerName = r.display_name?.trim() || r.variables?.name || "there";
  const resp = await sendInteraktMagicMessage(apiKey, r.wa_id, {
    imageUrl: uploaded.publicUrl,
    fileName: "magic-message.png",
    customerName,
  });
  return {
    wa_message_id: resp.messageId ?? null,
    generated_text: generated.text,
    prompt_tokens: generated.prompt_tokens ?? null,
    completion_tokens: generated.completion_tokens ?? null,
  };
}

// ---------------------------------------------------------------------
// Magic-message body generation. Uses gpt-4o-mini against:
//   - the operator's campaign brief (magic_prompt)
//   - optional persona override (magic_persona_override)
//   - the recipient's variables / name as personalization context
// Falls back to magic_prompt as-is if generation fails so we don't
// silently drop the recipient.
// ---------------------------------------------------------------------
async function generateMagicBody(
  c: CampaignRow,
  r: RecipientRow,
): Promise<{ text: string; prompt_tokens?: number; completion_tokens?: number }> {
  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");
  const tone = (c.magic_tone || "warm, conversational, professional").trim();
  const persona =
    (c.magic_persona_override || "").trim() ||
    "You are a friendly customer-care representative writing a personalized WhatsApp message.";
  const briefRaw = (c.magic_prompt || "").trim();
  if (!briefRaw) throw new Error("magic_prompt missing on campaign");

  // Pre-substitute {{name}} / {{1}} / {{date}} etc. in the operator's
  // brief so the model sees the recipient's actual name+context rather
  // than the literal placeholder. Whatever's left untouched stays as a
  // hint for the model to use the recipient context block.
  const merged: Record<string, string> = { ...(r.variables ?? {}) };
  if (r.display_name) {
    merged.name = merged.name ?? r.display_name;
    merged["1"] = merged["1"] ?? r.display_name;
  }
  const brief = briefRaw.replace(
    /\{\{\s*([\w-]+)\s*\}\}/g,
    (_m, key) => merged[key] ?? `{{${key}}}`,
  );

  const recipientCtx = JSON.stringify({
    name: r.display_name ?? r.variables?.name ?? null,
    ...r.variables,
  });

  const messages = [
    {
      role: "system" as const,
      content:
        `${persona}\n\nTone: ${tone}\n\nRules:\n` +
        `- One WhatsApp message, 40-80 words.\n` +
        `- Mirror the recipient's likely language (Hindi / Hinglish / English).\n` +
        `- Personalize using the context block but never fabricate details.\n` +
        `- No markdown, no asterisks, no bullets.\n` +
        `- FORMATTING: Break the message into 2-4 short paragraphs separated by a blank line ("\\n\\n").\n` +
        `  Greeting on its own line. Main message on its own paragraph. Soft CTA / sign-off on its own line.\n` +
        `  Use single newlines ("\\n") inside a paragraph only when listing.\n` +
        `- Keep sentences short — under 18 words each.\n` +
        `- Max 2 emojis, only when culturally appropriate.`,
    },
    {
      role: "user" as const,
      content: `Brief:\n${brief}\n\nRecipient context:\n${recipientCtx}\n\nWrite the message body only, formatted with proper line breaks.`,
    },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.6, messages }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("empty magic-message response");
  return {
    text,
    prompt_tokens: json.usage?.prompt_tokens,
    completion_tokens: json.usage?.completion_tokens,
  };
}

// ---------------------------------------------------------------------
// Auto-build a body component from the recipient's variables. Used when
// the operator didn't pre-build template_components (the common case —
// they pick a template by name and we infer the parameters from the
// template body preview).
//
// Detects placeholder style:
//   • positional   "Hi {{1}}, your appt on {{2}}"   → keys "1","2"
//   • named        "Hi {{name}}, on {{date}}"       → keys "name","date"
//
// Falls back to recipient's display_name for {{1}} / {{name}} when the
// CSV didn't supply that key, so a single-variable template "Hi {{1}}"
// works out of the box.
// ---------------------------------------------------------------------
export function detectPlaceholders(body: string): string[] {
  const matches = (body ?? "").match(/\{\{\s*([\w-]+)\s*\}\}/g) ?? [];
  const seen: string[] = [];
  for (const m of matches) {
    const key = m.replace(/[{}\s]/g, "");
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

function buildBodyComponents(
  body: string,
  vars: Record<string, string>,
  displayName: string | null,
): unknown[] | undefined {
  const placeholders = detectPlaceholders(body);
  if (placeholders.length === 0) return undefined;
  const merged: Record<string, string> = { ...(vars ?? {}) };
  if (displayName) {
    merged.name = merged.name ?? displayName;
    merged["1"] = merged["1"] ?? displayName;
  }
  const parameters = placeholders.map((key) => ({
    type: "text" as const,
    text: (merged[key] ?? "").toString(),
  }));
  return [{ type: "body", parameters }];
}

// ---------------------------------------------------------------------
// Template variable substitution. Walks template_components looking for
// {{1}}, {{2}}, {{name}}-style placeholders and replaces each with the
// matching value from `vars`. Untouched if components are absent.
// ---------------------------------------------------------------------
function applyTemplateVars(
  components: unknown,
  vars: Record<string, string>,
  displayName: string | null,
): unknown[] | undefined {
  if (!Array.isArray(components)) return undefined;
  const merged: Record<string, string> = { ...(vars ?? {}) };
  if (displayName && !merged.name) merged.name = displayName;

  const replace = (s: string): string =>
    s.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) => merged[key] ?? `{{${key}}}`);

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replace(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return components.map((c) => walk(c)) as unknown[];
}

// ---------------------------------------------------------------------
// Quiet-hours check. start / end are "HH:MM" strings in IST. When both
// are set and current IST time falls inside the half-open [start, end)
// window, return true so the worker skips this campaign for now.
// ---------------------------------------------------------------------
function isInQuietHours(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const istNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const cur = istNow.getHours() * 60 + istNow.getMinutes();
  const [sh, sm] = start.split(":").map((n) => parseInt(n, 10));
  const [eh, em] = end.split(":").map((n) => parseInt(n, 10));
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  // Same-day window: [s, e). Wrap-around (e.g. 21:00 → 09:00) flips.
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

// ---------------------------------------------------------------------
// Recompute campaign counters from campaign_recipients. Cheaper to do
// this once at end-of-tick than to bump on every status update.
// ---------------------------------------------------------------------
export async function recomputeCounters(campaignId: string): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: rows } = await admin
    .from("campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as { status: string }[]) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  const sentLike =
    (counts.sent ?? 0) +
    (counts.delivered ?? 0) +
    (counts.read ?? 0) +
    (counts.replied ?? 0);
  await admin
    .from("campaigns")
    .update({
      total_recipients: rows?.length ?? 0,
      sent_count: sentLike,
      delivered_count:
        (counts.delivered ?? 0) + (counts.read ?? 0) + (counts.replied ?? 0),
      read_count: (counts.read ?? 0) + (counts.replied ?? 0),
      replied_count: counts.replied ?? 0,
      failed_count: counts.failed ?? 0,
      unsubscribed_count: counts.unsubscribed ?? 0,
    })
    .eq("id", campaignId);
}
