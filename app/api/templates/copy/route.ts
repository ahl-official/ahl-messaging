// POST /api/templates/copy
//   { templates: SourceTemplate[], target_phone_number_ids: string[] }
//
// "Copy" a template to other numbers/portfolios. Templates are WABA-scoped, so
// copy = CREATE the same template on each target's WABA via Meta's Create
// Template API (it goes through Meta review again). Category is preserved
// (MARKETING → MARKETING, UTILITY → UTILITY). Targets that resolve to the SAME
// WABA are de-duped (one create per WABA). Media-header templates re-upload the
// header sample to the target's app so the new WABA gets its own handle.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getApiVersion } from "@/lib/whatsapp";
import { extractPlaceholders, resolveTemplateCreds } from "@/lib/template-creds";
import { listPortfolios } from "@/lib/portfolios";

export const runtime = "nodejs";

type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

interface RawButton {
  type?: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

interface SourceTemplate {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language?: string | null;
  header_format?: HeaderFormat | null;
  header_text?: string | null;
  header_url?: string | null;
  body: string;
  footer?: string | null;
  buttons?: RawButton[] | null;
}

interface CopyBody {
  templates?: SourceTemplate[];
  template?: SourceTemplate;
  target_phone_number_ids?: string[];
}

interface MetaComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: HeaderFormat;
  text?: string;
  example?: { header_text?: string[]; header_handle?: string[]; body_text?: string[][] };
  buttons?: Array<Record<string, unknown>>;
}

interface CopyResult {
  template: string;
  portfolio: string;
  ok: boolean;
  status?: string;
  error?: string;
}

function mapButtons(raw?: RawButton[] | null): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const type = String(b.type ?? "").toUpperCase();
      const text = (b.text ?? "").trim();
      if (type === "URL") return { type: "URL", text, url: (b.url ?? "").trim() };
      if (type === "PHONE_NUMBER")
        return { type: "PHONE_NUMBER", text, phone_number: (b.phone_number ?? "").trim() };
      if (type === "COPY_CODE") {
        const ex = Array.isArray(b.example) ? b.example[0] : b.example;
        return { type: "COPY_CODE", example: (ex ?? "12345").toString() };
      }
      return { type: "QUICK_REPLY", text };
    })
    .filter((b) => (b.type === "COPY_CODE" ? true : Boolean(b.text)));
}

// Re-upload a header sample to the target's Meta App so the new WABA gets its
// own resumable-upload handle. Returns the handle or throws with a reason.
async function uploadHeaderSample(
  appId: string,
  token: string,
  url: string,
  apiVersion: string,
): Promise<string> {
  const fileRes = await fetch(url, { cache: "no-store" });
  if (!fileRes.ok) throw new Error(`fetch sample failed (${fileRes.status})`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const fileType = fileRes.headers.get("content-type") || "application/octet-stream";
  const fileName = url.split("/").pop()?.split("?")[0] || "sample";

  const sessionUrl = new URL(`https://graph.facebook.com/${apiVersion}/${appId}/uploads`);
  sessionUrl.searchParams.set("file_name", fileName);
  sessionUrl.searchParams.set("file_length", String(buf.length));
  sessionUrl.searchParams.set("file_type", fileType);
  sessionUrl.searchParams.set("access_token", token);
  const sRes = await fetch(sessionUrl.toString(), { method: "POST", cache: "no-store" });
  const sJson = (await sRes.json()) as { id?: string; error?: { message?: string } };
  if (!sRes.ok || !sJson.id) throw new Error(sJson.error?.message ?? "upload session failed");

  const uRes = await fetch(`https://graph.facebook.com/${apiVersion}/${sJson.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_offset: "0" },
    body: buf,
    cache: "no-store",
  });
  const uJson = (await uRes.json()) as { h?: string; error?: { message?: string } };
  if (!uRes.ok || !uJson.h) throw new Error(uJson.error?.message ?? "sample upload failed");
  return uJson.h;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CopyBody;
  try {
    body = (await request.json()) as CopyBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const templates = body.templates ?? (body.template ? [body.template] : []);
  if (templates.length === 0)
    return NextResponse.json({ error: "Select at least one template." }, { status: 400 });

  // Meta-only — Interakt/Evolution numbers can't host Meta templates.
  const targets = Array.from(
    new Set(
      (body.target_phone_number_ids ?? [])
        .map((s) => String(s).trim())
        .filter((s) => s && !s.startsWith("evo:") && !s.startsWith("interakt:")),
    ),
  );
  if (targets.length === 0)
    return NextResponse.json({ error: "Select at least one Meta number." }, { status: 400 });

  const apiVersion = await getApiVersion();
  const portfolios = listPortfolios();

  // Resolve every target number → its WABA, then de-dupe by WABA so two
  // numbers on the same account don't try to create the template twice.
  const byWaba = new Map<
    string,
    { waba: string; token: string; fallbackWaba: string | null; appId: string | null; label: string }
  >();
  for (const pid of targets) {
    const creds = await resolveTemplateCreds({ phoneNumberId: pid });
    if (!creds) continue;
    if (byWaba.has(creds.waba)) continue;
    const owner = portfolios.find((p) => p.phone_number_ids.includes(pid));
    byWaba.set(creds.waba, {
      waba: creds.waba,
      token: creds.token,
      fallbackWaba: creds.fallbackWaba,
      appId: owner?.app_id ?? null,
      label: owner?.display_name || owner?.name || owner?.key || creds.waba,
    });
  }
  if (byWaba.size === 0)
    return NextResponse.json({ error: "Could not resolve credentials for any target." }, { status: 400 });

  const results: CopyResult[] = [];

  for (const tpl of templates) {
    const name = String(tpl.name ?? "").trim();
    const language = (tpl.language || "en_US").trim();
    const category = tpl.category;
    const bodyText = String(tpl.body ?? "").trim();
    if (!name || !bodyText) {
      results.push({ template: name || "(unnamed)", portfolio: "—", ok: false, error: "Missing name/body." });
      continue;
    }
    const headerFormat = tpl.header_format ?? (tpl.header_text ? "TEXT" : null);
    const buttons = mapButtons(tpl.buttons);

    for (const t of byWaba.values()) {
      try {
        const components: MetaComponent[] = [];

        if (headerFormat === "TEXT" && tpl.header_text?.trim()) {
          const h: MetaComponent = { type: "HEADER", format: "TEXT", text: tpl.header_text };
          const vars = extractPlaceholders(tpl.header_text);
          if (vars.length === 1) h.example = { header_text: vars };
          components.push(h);
        } else if (headerFormat && headerFormat !== "TEXT") {
          if (!tpl.header_url) {
            results.push({
              template: name,
              portfolio: t.label,
              ok: false,
              error: "Media-header template has no sample URL to re-upload.",
            });
            continue;
          }
          if (!t.appId) {
            results.push({
              template: name,
              portfolio: t.label,
              ok: false,
              error: "Target portfolio has no App ID (needed to upload the media sample).",
            });
            continue;
          }
          const handle = await uploadHeaderSample(t.appId, t.token, tpl.header_url, apiVersion);
          components.push({ type: "HEADER", format: headerFormat, example: { header_handle: [handle] } });
        }

        const bodyComp: MetaComponent = { type: "BODY", text: bodyText };
        const bodyVars = extractPlaceholders(bodyText);
        if (bodyVars.length > 0) bodyComp.example = { body_text: [bodyVars] };
        components.push(bodyComp);

        if (tpl.footer?.trim()) components.push({ type: "FOOTER", text: tpl.footer.trim() });
        if (buttons.length > 0) components.push({ type: "BUTTONS", buttons });

        const payload = JSON.stringify({ name, language, category, components });
        const createUrl = (wid: string) =>
          `https://graph.facebook.com/${apiVersion}/${wid}/message_templates`;
        const doCreate = (wid: string) =>
          fetch(createUrl(wid), {
            method: "POST",
            headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
            body: payload,
            cache: "no-store",
          });

        let res = await doCreate(t.waba);
        let json = (await res.json()) as {
          id?: string;
          status?: string;
          error?: { message?: string; error_user_msg?: string; code?: number };
        };
        if (!res.ok && json.error?.code === 100 && t.fallbackWaba) {
          res = await doCreate(t.fallbackWaba);
          json = (await res.json()) as typeof json;
        }

        if (!res.ok) {
          results.push({
            template: name,
            portfolio: t.label,
            ok: false,
            error: json.error?.error_user_msg ?? json.error?.message ?? `Meta API ${res.status}`,
          });
        } else {
          results.push({
            template: name,
            portfolio: t.label,
            ok: true,
            status: json.status ?? "PENDING",
          });
        }
      } catch (e) {
        results.push({
          template: name,
          portfolio: t.label,
          ok: false,
          error: e instanceof Error ? e.message : "Copy failed.",
        });
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return NextResponse.json({ ok: true, created: ok, total: results.length, results });
}
