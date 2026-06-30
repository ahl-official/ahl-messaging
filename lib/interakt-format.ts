// Client-safe (no server imports) — shared between the Interakt webhook
// parser, the chat bubble, and the contact-list preview.
//
// Some Interakt outbound template events arrive with the raw Meta-style
// `components` array stored as the message body, e.g.
//   [{"type":"header","parameters":[{"type":"text","text":"…"}]},
//    {"type":"body","parameters":[{"type":"text","text":"Som Jain"}]},
//    {"type":"button","sub_type":"url","index":0,"parameters":[…]}]
// which renders as an unreadable JSON blob. Turn that into a clean preview.
// Plain text / non-template content passes straight through unchanged.

// Pull the human-readable title out of an interactive button/list reply blob.
function interactiveReplyTitle(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as Record<string, { title?: string }> & {
      interactive?: Record<string, { title?: string }>;
    };
    const title =
      o.button_reply?.title ??
      o.list_reply?.title ??
      o.interactive?.button_reply?.title ??
      o.interactive?.list_reply?.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

export function interaktTemplatePreview(content: string | null | undefined): string {
  const t = (content ?? "").trim();
  // Interactive button / list reply blob — show the tapped option's title
  // instead of the raw {"type":"button_reply","button_reply":{…}} JSON.
  if (t.startsWith("{") && t.includes("_reply")) {
    const title = interactiveReplyTitle(t);
    if (title) return title;
  }
  if (!t.startsWith("[")) return content ?? "";
  let arr: unknown;
  try {
    arr = JSON.parse(t);
  } catch {
    return content ?? "";
  }
  if (!Array.isArray(arr) || arr.length === 0) return content ?? "";
  const comps = arr as Array<{
    type?: string;
    parameters?: Array<{ type?: string; text?: string }>;
  }>;
  if (!comps.every((c) => c && typeof c === "object" && "type" in c)) return content ?? "";

  const texts: string[] = [];
  for (const c of comps) {
    const type = String(c.type).toLowerCase();
    if (type === "header" || type === "body") {
      for (const p of c.parameters ?? []) {
        if (p?.type === "text" && p.text) texts.push(p.text);
      }
    }
  }
  const joined = texts.join(" · ");
  return joined ? `📋 Template · ${joined}` : "📋 Template message";
}

// ---------------------------------------------------------------------
// Full template render — Interakt template events carry the complete
// template definition in `raw_template` plus the per-send parameter
// values in `message` (components). We fill the body placeholders and
// return everything the chat's template card needs to look like Interakt.
// ---------------------------------------------------------------------
export interface RenderedInteraktTemplate {
  name: string | null;
  body: string;
  footer: string | null;
  buttons: Array<{ type: string; text?: string; url?: string }> | null;
  headerUrl: string | null;
}

function parseMaybeJson(v: unknown): unknown {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.trim()) {
    try {
      let parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") parsed = JSON.parse(parsed); // double-encoded
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function buttonsFrom(v: unknown): RenderedInteraktTemplate["buttons"] {
  const arr = parseMaybeJson(v);
  if (!Array.isArray(arr)) return null;
  const out = (arr as Array<Record<string, unknown>>)
    .map((b) => ({
      type: String(b.type ?? ""),
      text: b.text ? String(b.text) : undefined,
      url: b.url ? String(b.url) : undefined,
    }))
    .filter((b) => b.text || b.url);
  return out.length ? out : null;
}

export function renderInteraktTemplate(
  rawTemplate: unknown,
  components: unknown,
  mediaUrl?: string | null,
): RenderedInteraktTemplate | null {
  const tpl = parseMaybeJson(rawTemplate) as Record<string, unknown> | null;
  if (!tpl) return null;

  // Parameter values from the message components.
  const comps = parseMaybeJson(components);
  const bodyParams: string[] = [];
  let compHeaderUrl: string | null = null;
  if (Array.isArray(comps)) {
    for (const c of comps as Array<Record<string, unknown>>) {
      const type = String(c.type ?? "").toLowerCase();
      const params = Array.isArray(c.parameters) ? (c.parameters as Array<Record<string, unknown>>) : [];
      if (type === "body") {
        for (const p of params) if (p.type === "text") bodyParams.push(String(p.text ?? ""));
      } else if (type === "header") {
        for (const p of params) {
          const img = p.image as { link?: string } | undefined;
          if (img?.link) compHeaderUrl = img.link;
        }
      }
    }
  }

  const bodyTpl = tpl.body ? String(tpl.body) : "";
  const body = bodyTpl
    ? bodyTpl.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => bodyParams[Number(n) - 1] ?? `{{${n}}}`)
    : bodyParams.join(" ");

  const headerHandle = Array.isArray(tpl.header_handle) ? tpl.header_handle : null;
  return {
    name: tpl.name ? String(tpl.name) : null,
    body,
    footer: tpl.footer ? String(tpl.footer) : null,
    buttons: buttonsFrom(tpl.buttons),
    headerUrl:
      compHeaderUrl ||
      (mediaUrl ?? null) ||
      (headerHandle && headerHandle[0] ? String(headerHandle[0]) : null),
  };
}
