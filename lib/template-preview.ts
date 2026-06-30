// Render an outbound template's body text the way the recipient will
// see it, by:
//   1. Fetching the approved template from Meta (cached in-process for
//      5 min so repeated sends of the same template don't slam Meta).
//   2. Substituting {{1}}, {{2}}, ... placeholders with the parameter
//      values supplied in the send-request's components.
//
// Used by /api/v1/messages so the dashboard chat bubble shows the same
// text the customer received, instead of a bare "[Template: name]".

import { getApiVersion } from "@/lib/whatsapp";

interface CachedButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE" | string;
  text: string;
  /** URL templates contain {{1}} placeholders the sender fills in. */
  url?: string | null;
  phone_number?: string | null;
}

interface CachedHeader {
  format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | string;
  /** TEXT header copy with `{{1}}` placeholders intact. */
  text?: string | null;
  /** Example media URL Meta keeps for IMAGE / VIDEO / DOCUMENT headers,
   *  used as a fallback preview when the sender didn't pass a fresh
   *  media id. */
  example?: string | null;
}

interface CachedTemplate {
  /** Body text with `{{1}}` / `{{name}}` placeholders intact. */
  body: string;
  footer: string | null;
  header: CachedHeader | null;
  buttons: CachedButton[];
  /** Stored to filter out stale rows in the future if needed. */
  fetched_at: number;
}

const CACHE = new Map<string, CachedTemplate>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(waba: string, name: string, lang: string): string {
  return `${waba}::${name}::${lang}`;
}

/**
 * Fetch the body+footer of an approved template. Best-effort — returns
 * null on any failure so callers can fall back to a generic placeholder.
 */
async function fetchTemplate(
  waba: string,
  accessToken: string,
  name: string,
  language: string,
): Promise<CachedTemplate | null> {
  const cached = CACHE.get(cacheKey(waba, name, language));
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;

  try {
    const apiVersion = await getApiVersion();
    // Filter by name on Meta side to keep the response tiny. We still
    // verify language client-side because Meta returns all language
    // variants of a name.
    const url =
      `https://graph.facebook.com/${apiVersion}/${waba}/message_templates` +
      `?fields=name,language,components&name=${encodeURIComponent(name)}&limit=20`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    type RawComponent = {
      type?: string;
      format?: string;
      text?: string;
      example?: { header_handle?: string[]; header_text?: string[][] };
      buttons?: Array<{
        type?: string;
        text?: string;
        url?: string;
        phone_number?: string;
      }>;
    };
    const json = (await res.json()) as {
      data?: Array<{
        name?: string;
        language?: string;
        components?: RawComponent[];
      }>;
    };
    const row =
      json.data?.find(
        (t) => t.name === name && (t.language === language || !language),
      ) ?? json.data?.[0];
    if (!row?.components) return null;

    const comps = row.components;
    const body =
      comps.find((c) => (c.type ?? "").toUpperCase() === "BODY")?.text ?? "";
    const footer =
      comps.find((c) => (c.type ?? "").toUpperCase() === "FOOTER")?.text ?? null;

    const headerComp = comps.find((c) => (c.type ?? "").toUpperCase() === "HEADER");
    const header: CachedHeader | null = headerComp
      ? {
          format: (headerComp.format ?? "TEXT").toUpperCase(),
          text: headerComp.text ?? null,
          example: headerComp.example?.header_handle?.[0] ?? null,
        }
      : null;

    const buttonsComp = comps.find((c) => (c.type ?? "").toUpperCase() === "BUTTONS");
    const buttons: CachedButton[] = (buttonsComp?.buttons ?? []).map((b) => ({
      type: (b.type ?? "QUICK_REPLY").toUpperCase(),
      text: (b.text ?? "").toString(),
      url: b.url ?? null,
      phone_number: b.phone_number ?? null,
    }));

    const entry: CachedTemplate = {
      body,
      footer,
      header,
      buttons,
      fetched_at: Date.now(),
    };
    CACHE.set(cacheKey(waba, name, language), entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Substitute Meta-style positional placeholders ({{1}}, {{2}}) with the
 * values from the body component's parameters array.
 */
function applyBodyParams(
  body: string,
  components: Array<Record<string, unknown>> | undefined,
): string {
  if (!components) return body;
  const bodyComp = components.find(
    (c) => (c.type as string | undefined)?.toLowerCase() === "body",
  );
  const params = bodyComp?.parameters as Array<Record<string, unknown>> | undefined;
  if (!params) return body;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, idx) => {
    const i = parseInt(idx, 10) - 1;
    const p = params[i] as { text?: unknown } | undefined;
    if (!p) return _m;
    return (p.text ?? "").toString();
  });
}

/**
 * Public entry — given the raw send-message body the integrator posted,
 * return what the rendered template should look like on the customer's
 * screen. Returns null when we can't reconstruct it (Meta call failed,
 * template not found, etc.) so the caller can fall back to a placeholder.
 */
export interface RenderedTemplate {
  text: string;
  footer: string | null;
  /** Header text (rendered with vars) or media URL pulled from the
   *  send-request first, then from the approved template example. */
  header_text: string | null;
  header_media_url: string | null;
  /** Buttons in the order Meta will render them. URL buttons have
   *  their `{{1}}` placeholders substituted from the send-request. */
  buttons: Array<{
    type: string;
    text: string;
    url: string | null;
    phone_number: string | null;
  }>;
}

// ---------------------------------------------------------------------
// Pre-send validator — fetches the template definition and compares
// against the user's send payload. Returns a list of human-readable
// problems (empty array = OK to send). Catches the common cause of
// Meta's vague "(#135000) Generic user error":
//
//   • Body has {{N}} vars but caller sent fewer params
//   • Template has a HEADER (image/text) but no header component sent
//   • Template has a URL button with {{1}} but no button component sent
//
// Quick-reply buttons don't need params at send time, so we don't
// require them in the payload.
// ---------------------------------------------------------------------
export async function validateTemplatePayload(opts: {
  waba_id: string | null;
  access_token: string;
  body: Record<string, unknown>;
}): Promise<string[]> {
  const tpl = opts.body.template as
    | {
        name?: string;
        language?: { code?: string };
        components?: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!tpl?.name || !opts.waba_id) return [];
  const t = await fetchTemplate(
    opts.waba_id,
    opts.access_token,
    tpl.name,
    tpl.language?.code ?? "en_US",
  );
  if (!t) return []; // can't validate without definition — let Meta decide
  const sent = tpl.components ?? [];
  const findSent = (type: string, sub?: string, index?: number) =>
    sent.find((c) => {
      const cType = (c.type as string | undefined)?.toLowerCase();
      if (cType !== type) return false;
      if (sub != null) {
        const cSub = (c.sub_type as string | undefined)?.toLowerCase();
        if (cSub !== sub) return false;
      }
      if (index != null) {
        const cIdx = Number((c.index as string | undefined) ?? -1);
        if (cIdx !== index) return false;
      }
      return true;
    });
  const problems: string[] = [];

  // Body var count
  const bodyVars =
    (t.body.match(/\{\{\s*(\d+)\s*\}\}/g) ?? []).map((m) =>
      parseInt(m.replace(/[^\d]/g, ""), 10),
    );
  if (bodyVars.length > 0) {
    const sentBody = findSent("body");
    const sentParams = (sentBody?.parameters as unknown[] | undefined) ?? [];
    const expected = Math.max(...bodyVars);
    if (sentParams.length < expected) {
      problems.push(
        `body expects ${expected} variable(s), got ${sentParams.length}`,
      );
    }
  }

  // Header
  if (t.header) {
    const sentHeader = findSent("header");
    if (!sentHeader) {
      if (t.header.format === "TEXT" && (t.header.text ?? "").includes("{{")) {
        problems.push("header has {{...}} variable but no header component sent");
      } else if (
        t.header.format === "IMAGE" ||
        t.header.format === "VIDEO" ||
        t.header.format === "DOCUMENT"
      ) {
        problems.push(
          `header is ${t.header.format} — send components[].header with { type: "${t.header.format.toLowerCase()}", "${t.header.format.toLowerCase()}": { id: "<media_id>" } }`,
        );
      }
    }
  }

  // URL buttons with placeholders
  t.buttons.forEach((b, i) => {
    if (b.type === "URL" && b.url && b.url.includes("{{")) {
      const sentBtn = findSent("button", "url", i);
      const sentParams = (sentBtn?.parameters as unknown[] | undefined) ?? [];
      if (sentParams.length < 1) {
        problems.push(
          `URL button index=${i} has {{...}} placeholder but no button component sent`,
        );
      }
    }
  });

  return problems;
}

export async function renderTemplatePreview(opts: {
  waba_id: string | null;
  access_token: string;
  body: Record<string, unknown>;
}): Promise<RenderedTemplate | null> {
  const tpl = opts.body.template as
    | {
        name?: string;
        language?: { code?: string };
        components?: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!tpl?.name || !opts.waba_id) return null;
  const t = await fetchTemplate(
    opts.waba_id,
    opts.access_token,
    tpl.name,
    tpl.language?.code ?? "en_US",
  );
  if (!t) return null;

  // Header — sender may have passed a fresh media id for image / video /
  // document templates, or text values for a TEXT header.
  const sendHeader = tpl.components?.find(
    (c) => (c.type as string | undefined)?.toLowerCase() === "header",
  );
  const sendHeaderParam = (sendHeader?.parameters as Array<Record<string, unknown>> | undefined)?.[0];

  let header_text: string | null = null;
  let header_media_url: string | null = null;
  if (t.header) {
    if (t.header.format === "TEXT" && t.header.text) {
      // {{1}} substitution for TEXT headers
      header_text = (t.header.text as string).replace(/\{\{\s*(\d+)\s*\}\}/g, (_m) => {
        const v = sendHeaderParam?.text as string | undefined;
        return v ?? _m;
      });
    } else if (t.header.format === "IMAGE" || t.header.format === "VIDEO" || t.header.format === "DOCUMENT") {
      const kind = t.header.format.toLowerCase();
      const provided = sendHeaderParam?.[kind] as
        | { id?: string; link?: string }
        | undefined;
      header_media_url = provided?.link ?? t.header.example ?? null;
    }
  }

  // Buttons — start from the approved template's button list (which
  // includes the labels), then patch any URL templates with the
  // send-request's parameters (sub_type='url').
  const buttons: RenderedTemplate["buttons"] = t.buttons.map((b, i) => {
    let url: string | null = b.url ?? null;
    if (b.type === "URL" && url && url.includes("{{")) {
      const btnComp = tpl.components?.find(
        (c) =>
          (c.type as string | undefined)?.toLowerCase() === "button" &&
          (c.sub_type as string | undefined)?.toLowerCase() === "url" &&
          Number((c.index as string | undefined) ?? -1) === i,
      );
      const p = (btnComp?.parameters as Array<Record<string, unknown>> | undefined)?.[0];
      const v = p?.text as string | undefined;
      if (v) url = url.replace(/\{\{\s*\d+\s*\}\}/, v);
    }
    return {
      type: b.type,
      text: b.text,
      url,
      phone_number: b.phone_number ?? null,
    };
  });

  return {
    text: applyBodyParams(t.body, tpl.components),
    footer: t.footer,
    header_text,
    header_media_url,
    buttons,
  };
}
