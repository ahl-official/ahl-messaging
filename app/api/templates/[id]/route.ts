import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getApiVersion } from "@/lib/whatsapp";
import {
  extractPlaceholders,
  resolveTemplateCreds,
  TEMPLATE_CREDS_MISSING_MSG as CREDS_MISSING_MSG,
} from "@/lib/template-creds";
import { listPortfolios } from "@/lib/portfolios";

export const runtime = "nodejs";

interface MetaTemplateDetail {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Array<{
    type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
    format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
    text?: string;
    buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string; example?: string }>;
    example?: { header_text?: string[]; header_handle?: string[]; body_text?: string[][] };
  }>;
}

// =====================================================================
// GET /api/templates/[id] — fetch a single template's full structure
// from Meta for the edit page to prefill.
// =====================================================================
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const portfolioKey = request.nextUrl.searchParams.get("portfolio_key")?.trim() || null;
  const phoneNumberId = request.nextUrl.searchParams.get("phone_number_id")?.trim() || null;
  const apiVersion = await getApiVersion();
  const creds = await resolveTemplateCreds({ phoneNumberId, portfolioKey });
  if (!creds) {
    return NextResponse.json({ error: CREDS_MISSING_MSG }, { status: 500 });
  }
  const accessToken = creds.token;

  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(
    id,
  )}?fields=name,language,status,category,components`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const json = (await res.json()) as MetaTemplateDetail & {
    error?: { message?: string };
  };
  if (!res.ok) {
    return NextResponse.json(
      { error: json.error?.message ?? `Meta API ${res.status}` },
      { status: 502 },
    );
  }

  // Surface the approved sample's public CDN URL at the top level so the edit
  // page can prefill the header preview even when no `template_assets` row
  // exists (e.g. for templates created in Meta Business Manager directly).
  const header = json.components?.find((c) => c.type === "HEADER");
  const metaSampleUrl = header?.example?.header_handle?.[0] ?? null;
  return NextResponse.json({
    template: { ...json, header_url: metaSampleUrl },
  });
}

// =====================================================================
// PATCH /api/templates/[id] — edit an existing template's components.
//
// Meta rules:
//   - Only APPROVED / REJECTED / PAUSED templates can be edited.
//   - Each template can be edited up to 10 times in 30 days.
//   - `name` and `language` cannot be changed.
//   - `category` can sometimes change (subject to Meta approval rules).
//   - Edits resubmit the template for review (status → PENDING).
// =====================================================================
type ButtonInput =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }
  | { type: "COPY_CODE"; example: string };

type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

interface EditTemplateBody {
  category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  header_format?: HeaderFormat | null;
  header_text?: string | null;
  header_handle?: string | null;
  /** Public Supabase Storage URL for the new sample — cached for previews. */
  header_preview_url?: string | null;
  body: string;
  footer?: string | null;
  buttons?: ButtonInput[];
}

interface MetaComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: HeaderFormat;
  text?: string;
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
  buttons?: ButtonInput[];
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const portfolioKey = request.nextUrl.searchParams.get("portfolio_key")?.trim() || null;
  const phoneNumberId = request.nextUrl.searchParams.get("phone_number_id")?.trim() || null;
  const apiVersion = await getApiVersion();
  const creds = await resolveTemplateCreds({ phoneNumberId, portfolioKey });
  if (!creds) {
    return NextResponse.json({ error: CREDS_MISSING_MSG }, { status: 500 });
  }
  const accessToken = creds.token;

  let input: EditTemplateBody;
  try {
    input = (await request.json()) as EditTemplateBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Lightweight validation — Meta rejects with cryptic errors otherwise.
  if (!input.body || input.body.trim().length === 0) {
    return NextResponse.json({ error: "Body is required." }, { status: 400 });
  }
  if (input.body.length > 1024) {
    return NextResponse.json({ error: "Body exceeds 1024 characters." }, { status: 400 });
  }
  if (input.header_text && input.header_text.length > 60) {
    return NextResponse.json({ error: "Header exceeds 60 characters." }, { status: 400 });
  }
  if (input.footer && input.footer.length > 60) {
    return NextResponse.json({ error: "Footer exceeds 60 characters." }, { status: 400 });
  }

  // Build components — same shape as create endpoint.
  const components: MetaComponent[] = [];

  const headerFormat = input.header_format ?? (input.header_text ? "TEXT" : null);
  if (headerFormat === "TEXT" && input.header_text && input.header_text.trim()) {
    const header: MetaComponent = {
      type: "HEADER",
      format: "TEXT",
      text: input.header_text,
    };
    const headerVars = extractPlaceholders(input.header_text);
    if (headerVars.length === 1) {
      header.example = { header_text: headerVars };
    }
    components.push(header);
  } else if (headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT") {
    if (!input.header_handle) {
      return NextResponse.json(
        { error: `A ${headerFormat.toLowerCase()} sample must be uploaded for this header.` },
        { status: 400 },
      );
    }
    components.push({
      type: "HEADER",
      format: headerFormat,
      example: { header_handle: [input.header_handle] },
    });
  }

  const body: MetaComponent = { type: "BODY", text: input.body };
  const bodyVars = extractPlaceholders(input.body);
  if (bodyVars.length > 0) {
    body.example = { body_text: [bodyVars] };
  }
  components.push(body);

  if (input.footer && input.footer.trim()) {
    components.push({ type: "FOOTER", text: input.footer });
  }

  if (input.buttons && input.buttons.length > 0) {
    components.push({ type: "BUTTONS", buttons: input.buttons });
  }

  // Submit to Meta. Edit endpoint = POST /{template_id} with body.
  const editPayload: Record<string, unknown> = { components };
  if (input.category) editPayload.category = input.category;

  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(editPayload),
    cache: "no-store",
  });

  const json = (await res.json()) as {
    success?: boolean;
    error?: { message?: string; error_user_msg?: string };
  };

  if (!res.ok) {
    return NextResponse.json(
      { error: json.error?.error_user_msg ?? json.error?.message ?? `Meta API ${res.status}` },
      { status: 502 },
    );
  }

  // Update cached header preview URL — only when a fresh upload happened.
  // Meta replaces the underlying sample on every edit; old URL is no longer
  // the source of truth.
  const isMediaHeader =
    headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT";
  const admin = createServiceRoleClient();
  if (isMediaHeader && input.header_preview_url) {
    // Resolve current name + language from Meta for the asset row.
    const metaUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(
      id,
    )}?fields=name,language`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const metaJson = (await metaRes.json()) as { name?: string; language?: string };
    await admin.from("template_assets").upsert(
      {
        template_id: id,
        template_name: metaJson.name ?? id,
        language: metaJson.language ?? "en_US",
        header_format: headerFormat,
        header_url: input.header_preview_url,
      },
      { onConflict: "template_id" },
    );
  } else if (!isMediaHeader) {
    // Header was changed to text/none — drop the cached media URL.
    await admin.from("template_assets").delete().eq("template_id", id);
  }

  // Meta puts the edited template back to PENDING for re-review.
  return NextResponse.json({ ok: true, status: "PENDING" });
}

// =====================================================================
// DELETE /api/templates/[id]
//
// Meta's delete API needs both the WABA id AND the template name (the id
// alone isn't enough because the same name can have multiple language
// variants). We fetch the name first, then call the delete endpoint with
// `hsm_id` to scope the deletion to this exact template variant.
// =====================================================================
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiVersion = await getApiVersion();
  const portfolioKey = request.nextUrl.searchParams.get("portfolio_key")?.trim() || null;
  const phoneNumberId = request.nextUrl.searchParams.get("phone_number_id")?.trim() || null;
  const creds = await resolveTemplateCreds({ phoneNumberId, portfolioKey });
  if (!creds) {
    return NextResponse.json({ error: CREDS_MISSING_MSG }, { status: 500 });
  }
  // Step 1: look up the template name (Meta DELETE requires it). The template
  // node id is global, but only a token whose business can see it returns the
  // name — a freshly-added number is often filed under a different portfolio,
  // so probe every candidate token (resolved-token first) until one reads it.
  let templateName: string | null = null;
  let nameToken = creds.token;
  for (const tok of creds.candidateTokens.length ? creds.candidateTokens : [creds.token]) {
    const fetchRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(id)}?fields=name`,
      { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" },
    );
    const fetchJson = (await fetchRes.json()) as { name?: string };
    if (fetchRes.ok && fetchJson.name) {
      templateName = fetchJson.name;
      nameToken = tok;
      break;
    }
  }
  if (!templateName) {
    return NextResponse.json({ error: "Template not found" }, { status: 502 });
  }

  // Step 2: delete the specific variant (hsm_id + name = single language).
  // The delete is WABA-scoped, but a template often lives on a WABA OTHER than
  // the number's per-number override (that's the whole #100 failure). hsm_id is
  // globally unique, so issuing the delete against the wrong WABA just returns
  // #100 "not found" — it can NEVER delete a same-named template on another
  // account. So we try every WABA we plausibly own, paired with a token that
  // can address it, until one succeeds. Order: resolved override, portfolio
  // default, then every active Meta portfolio's own WABA.
  const portfolios = listPortfolios();
  const pairs: Array<{ waba: string; token: string }> = [];
  const addPair = (w: string | null, t: string | null) => {
    if (w && t) pairs.push({ waba: w, token: t });
  };
  addPair(creds.waba, creds.token);
  addPair(creds.fallbackWaba, creds.token);
  // The token that successfully READ the template is the most likely to be able
  // to delete it — pair it with each portfolio WABA too.
  for (const p of portfolios) {
    if (p.is_active && p.provider !== "interakt" && p.business_account_id && p.access_token) {
      addPair(p.business_account_id, p.access_token);
      addPair(p.business_account_id, nameToken);
    }
  }
  const seenPair = new Set<string>();
  const candidates = pairs.filter((p) => {
    const k = `${p.waba}|${p.token}`;
    if (seenPair.has(k)) return false;
    seenPair.add(k);
    return true;
  });

  let lastErr = "";
  let deleted = false;
  for (const { waba, token } of candidates) {
    const deleteUrl =
      `https://graph.facebook.com/${apiVersion}/${waba}/message_templates` +
      `?hsm_id=${encodeURIComponent(id)}&name=${encodeURIComponent(templateName)}`;
    const deleteRes = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const deleteJson = (await deleteRes.json()) as {
      success?: boolean;
      error?: { message?: string; error_user_msg?: string; code?: number };
    };
    if (deleteRes.ok && deleteJson.success) {
      deleted = true;
      break;
    }
    const code = deleteJson.error?.code;
    lastErr =
      deleteJson.error?.error_user_msg ?? deleteJson.error?.message ?? `Meta API ${deleteRes.status}`;
    // #100 = wrong WABA / no permission on THIS account → try the next
    // candidate. Any other error (template in use, rate limit, …) is real and
    // WABA-correct, so stop and surface it rather than masking with a later
    // irrelevant #100.
    if (code !== 100) break;
  }

  if (!deleted) {
    const codeMatch = /\(#(\d+)\)/.exec(lastErr);
    const hint =
      codeMatch?.[1] === "100"
        ? " — token missing whatsapp_business_management scope OR this template's WABA isn't among your configured portfolios. Check Settings → Numbers."
        : "";
    return NextResponse.json({ error: lastErr + hint }, { status: 502 });
  }

  // Meta deleted the template — drop the local cache row too so the UI
  // refresh doesn't show a ghost entry and the next upload-from-url
  // cache hit doesn't return a dead Supabase URL.
  const svc = createServiceRoleClient();
  const { error: delErr } = await svc
    .from("template_assets")
    .delete()
    .eq("template_id", id);
  if (delErr) {
    return NextResponse.json(
      {
        ok: false,
        error: `Meta deleted but local cleanup failed: ${delErr.message}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
