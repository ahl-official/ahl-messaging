import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getApiVersion } from "@/lib/whatsapp";
import {
  extractPlaceholders,
  resolveTemplateCreds,
  TEMPLATE_CREDS_MISSING_MSG as CREDS_MISSING_MSG,
} from "@/lib/template-creds";

export const runtime = "nodejs";

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Array<{
    type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
    format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
    text?: string;
    buttons?: Array<{ type: string; text: string }>;
    /** Meta puts the approved sample's public CDN URL here for media headers
     *  (scontent.whatsapp.net/...). It's the only API-exposed handle on an
     *  approved template, so we use it as a fallback when our own
     *  template_assets cache doesn't have a row for this template. */
    example?: {
      header_handle?: string[];
      header_text?: string[];
      body_text?: string[][];
    };
  }>;
}

interface MetaListResponse {
  data?: MetaTemplate[];
  error?: { message?: string; code?: number };
  paging?: { cursors?: { after?: string } };
}

// In-memory cache of the raw Meta template list, keyed by WABA. The picker
// polls this endpoint often; without a cache every poll hit Meta's
// /message_templates and tripped the app-level rate limit ("(#4) Application
// request limit reached"). Templates change rarely, so a short TTL is plenty.
// ?refresh=1 bypasses it (the picker's manual refresh button).
const TEMPLATES_TTL_MS = 5 * 60 * 1000;
const templatesCache = new Map<string, { at: number; data: MetaTemplate[] }>();
// After a Meta error (esp. the app-level rate limit), don't re-hit Meta for
// this WABA for a bit — otherwise every poll retries and digs the rate limit
// deeper. Cleared on the next success.
const TEMPLATES_BACKOFF_MS = 90 * 1000;
const templatesBackoff = new Map<string, number>();

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ?portfolio_key= picks which Meta App's templates to fetch.
  // ?phone_number_id= is also accepted as a convenience — we resolve it to
  // the owning portfolio.
  const url0 = request.nextUrl.searchParams;
  const portfolioKey = url0.get("portfolio_key")?.trim() || null;
  const phoneNumberId = url0.get("phone_number_id")?.trim() || null;

  // Interakt numbers fetch templates from Interakt, not Meta. Same response
  // shape so the picker UI is unchanged. Meta path below untouched.
  if (phoneNumberId?.startsWith("interakt:")) {
    const { getInteraktApiKeyForNumber, fetchInteraktTemplates } = await import("@/lib/interakt");
    const key = await getInteraktApiKeyForNumber(phoneNumberId);
    if (!key) {
      return NextResponse.json(
        { error: "Interakt API key not set. Add it in Settings → Interakt." },
        { status: 400 },
      );
    }
    try {
      const templates = await fetchInteraktTemplates(key);
      return NextResponse.json({ templates, provider: "interakt" });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Interakt templates failed" },
        { status: 502 },
      );
    }
  }

  const apiVersion = await getApiVersion();
  const creds = await resolveTemplateCreds({ phoneNumberId, portfolioKey });
  if (!creds) {
    return NextResponse.json({ error: CREDS_MISSING_MSG }, { status: 500 });
  }
  const WABA_ID = creds.waba;
  const accessToken = creds.token;

  // Serve from cache unless a manual refresh was requested.
  const refresh = url0.get("refresh") === "1";
  const cached = templatesCache.get(WABA_ID);
  let rawTemplates: MetaTemplate[] | null =
    !refresh && cached && Date.now() - cached.at < TEMPLATES_TTL_MS
      ? cached.data
      : null;

  // Inside the back-off window with no fresh cache → don't hit Meta again.
  // Serve a stale copy if we have one, else an empty list (the picker stays
  // quiet and auto-recovers once the window clears).
  if (!rawTemplates && !refresh && Date.now() < (templatesBackoff.get(WABA_ID) ?? 0)) {
    if (cached) {
      rawTemplates = cached.data;
    } else {
      return NextResponse.json({ templates: [], rate_limited: true });
    }
  }

  if (!rawTemplates) {
    const listUrl = (wid: string) =>
      `https://graph.facebook.com/${apiVersion}/${wid}/message_templates?fields=name,language,status,category,components&limit=200`;
    // Try each active portfolio token against the number's WABA. A freshly
    // added number frequently isn't filed under the portfolio whose token can
    // read its WABA yet, so the resolved token returns a permission error and
    // the section showed "no templates". Probing every token finds the
    // authorized one automatically — no .env edit / restart needed.
    let res!: Response;
    let json!: MetaListResponse;
    for (const tok of creds.candidateTokens) {
      res = await fetch(listUrl(WABA_ID), {
        headers: { Authorization: `Bearer ${tok}` },
        cache: "no-store",
      });
      json = (await res.json()) as MetaListResponse;
      if (res.ok) break;
    }
    // Still failing on a #100 ("does not exist / no permission") AND an
    // override is in effect → retry once against the portfolio's own default
    // WABA so one bad override can't break the whole section.
    if (!res.ok && json.error?.code === 100 && creds.fallbackWaba) {
      console.warn(
        `[templates] WABA ${WABA_ID} failed (#100) — retrying with portfolio default ${creds.fallbackWaba}`,
      );
      res = await fetch(listUrl(creds.fallbackWaba), {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      json = (await res.json()) as MetaListResponse;
    }
    if (!res.ok) {
      // Back off so the next polls don't keep hammering a rate-limited app.
      templatesBackoff.set(WABA_ID, Date.now() + TEMPLATES_BACKOFF_MS);
      // Transient error (e.g. rate limit) + we have a stale copy → serve it
      // rather than failing the picker.
      if (cached) {
        rawTemplates = cached.data;
      } else {
        // Meta error #100 ("nonexisting field message_templates") almost
        // always means the ID we're calling isn't a WhatsApp Business
        // Account ID — it's an App ID, Phone Number ID, or some other
        // sibling. Mask the value and surface a hint so the operator can
        // fix the .env / portfolio config without having to grep server logs.
        const masked =
          WABA_ID.length > 8
            ? `${WABA_ID.slice(0, 4)}…${WABA_ID.slice(-4)}`
            : WABA_ID;
        const hint =
          json.error?.code === 100
            ? ` Check that WHATSAPP_BUSINESS_ACCOUNT_ID (or the portfolio's business_account_id) is the WABA ID — not an App ID or Phone Number ID. Currently using "${masked}".`
            : "";
        console.warn(
          `[templates] Meta API error using WABA_ID=${WABA_ID}: ${JSON.stringify(json.error)}`,
        );
        return NextResponse.json(
          { error: (json.error?.message ?? `Meta API ${res.status}`) + hint },
          { status: 502 },
        );
      }
    } else {
      rawTemplates = json.data ?? [];
      templatesCache.set(WABA_ID, { at: Date.now(), data: rawTemplates });
      templatesBackoff.delete(WABA_ID);
    }
  }

  // Pull cached header preview URLs for templates with media headers (we store
  // them at create/edit time because Meta doesn't expose a public URL for the
  // approved sample). Indexed by template_id.
  const admin = createServiceRoleClient();
  const { data: assets } = await admin
    .from("template_assets")
    .select("template_id, header_url");
  const headerUrlById = new Map(
    (assets ?? []).map((a: { template_id: string; header_url: string }) => [
      a.template_id,
      a.header_url,
    ]),
  );

  // Return all (caller decides what's sendable based on status)
  const templates = (rawTemplates ?? [])
    .map((t) => {
      const body = t.components.find((c) => c.type === "BODY");
      const header = t.components.find((c) => c.type === "HEADER");
      const footer = t.components.find((c) => c.type === "FOOTER");
      const buttonsComp = t.components.find((c) => c.type === "BUTTONS");
      // Prefer our own cached URL (uploaded via the dashboard) since it's
      // stable. Fall back to Meta's approved-sample CDN URL so templates
      // created outside the dashboard still show their header image.
      const metaSampleUrl = header?.example?.header_handle?.[0] ?? null;
      return {
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        header_text: header?.format === "TEXT" ? header.text ?? null : null,
        header_format: header?.format ?? null,
        header_url: headerUrlById.get(t.id) ?? metaSampleUrl,
        body: body?.text ?? "",
        footer: footer?.text ?? null,
        buttons: buttonsComp?.buttons ?? null,
      };
    })
    // Approved first, then alphabetical
    .sort((a, b) => {
      const aOk = a.status === "APPROVED" ? 0 : 1;
      const bOk = b.status === "APPROVED" ? 0 : 1;
      if (aOk !== bOk) return aOk - bOk;
      return a.name.localeCompare(b.name);
    });

  return NextResponse.json({ templates, business_account_id: WABA_ID });
}

// =====================================================================
// POST — create a new template in Meta (goes into review, PENDING status)
// =====================================================================
type ButtonInput =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }
  | { type: "COPY_CODE"; example: string }
  | { type: "CATALOG"; text: string };

type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

interface CreateTemplateBody {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string; // e.g. "en_US"
  header_format?: HeaderFormat | null;
  header_text?: string | null;
  header_handle?: string | null; // Meta Resumable Upload handle for media headers
  /** Public Supabase Storage URL for the same media — cached so the
   *  dashboard can show the preview Meta doesn't expose post-approval. */
  header_preview_url?: string | null;
  body: string;
  footer?: string | null;
  buttons?: ButtonInput[];
  /** Carousel cards. Each card: a media header (same format across all cards),
   *  optional card body, and up to 2 buttons. 2–10 cards. */
  carousel?: {
    cards: Array<{
      header_format: "IMAGE" | "VIDEO";
      header_handle: string;
      body?: string | null;
      buttons?: ButtonInput[];
    }>;
  } | null;
}

interface MetaCardComponent {
  type: "HEADER" | "BODY" | "BUTTONS";
  format?: HeaderFormat;
  text?: string;
  example?: { header_handle?: string[]; body_text?: string[][] };
  buttons?: ButtonInput[];
}

interface MetaComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS" | "CAROUSEL";
  format?: HeaderFormat;
  text?: string;
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
  buttons?: ButtonInput[];
  cards?: Array<{ components: MetaCardComponent[] }>;
}

export async function POST(request: NextRequest) {
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
  const WABA_ID = creds.waba;
  const accessToken = creds.token;

  let input: CreateTemplateBody;
  try {
    input = (await request.json()) as CreateTemplateBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Validate
  if (!/^[a-z0-9_]{1,512}$/.test(input.name)) {
    return NextResponse.json(
      { error: "Name must be lowercase letters, numbers, and underscores only." },
      { status: 400 },
    );
  }
  if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(input.category)) {
    return NextResponse.json({ error: "Invalid category." }, { status: 400 });
  }
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
  if (input.buttons && input.buttons.length > 10) {
    return NextResponse.json({ error: "Up to 10 buttons allowed." }, { status: 400 });
  }
  const urlButtons = (input.buttons ?? []).filter((b) => b.type === "URL").length;
  const phoneButtons = (input.buttons ?? []).filter((b) => b.type === "PHONE_NUMBER").length;
  const copyButtons = (input.buttons ?? []).filter((b) => b.type === "COPY_CODE").length;
  if (urlButtons > 2) return NextResponse.json({ error: "Up to 2 URL buttons allowed." }, { status: 400 });
  if (phoneButtons > 1) return NextResponse.json({ error: "Only 1 Phone Number button allowed." }, { status: 400 });
  if (copyButtons > 1) return NextResponse.json({ error: "Only 1 Copy Code button allowed." }, { status: 400 });

  // Build components
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
    components.push({
      type: "BUTTONS",
      buttons: input.buttons,
    });
  }

  // Carousel — a BODY plus a CAROUSEL of 2–10 cards, each with its own media
  // header, optional card body, and up to 2 buttons. Meta requires every card
  // to share the same header format + button structure; we surface its error
  // if they don't.
  if (input.carousel && Array.isArray(input.carousel.cards) && input.carousel.cards.length > 0) {
    const inCards = input.carousel.cards;
    if (inCards.length < 2 || inCards.length > 10) {
      return NextResponse.json({ error: "Carousel needs between 2 and 10 cards." }, { status: 400 });
    }
    const cards: Array<{ components: MetaCardComponent[] }> = [];
    for (let i = 0; i < inCards.length; i++) {
      const card = inCards[i];
      if (!card.header_handle) {
        return NextResponse.json(
          { error: `Card ${i + 1}: upload an image/video sample first.` },
          { status: 400 },
        );
      }
      const cardComps: MetaCardComponent[] = [
        {
          type: "HEADER",
          format: card.header_format === "VIDEO" ? "VIDEO" : "IMAGE",
          example: { header_handle: [card.header_handle] },
        },
      ];
      if (card.body && card.body.trim()) {
        const cb: MetaCardComponent = { type: "BODY", text: card.body };
        const vars = extractPlaceholders(card.body);
        if (vars.length > 0) cb.example = { body_text: [vars] };
        cardComps.push(cb);
      }
      if (Array.isArray(card.buttons) && card.buttons.length > 0) {
        cardComps.push({ type: "BUTTONS", buttons: card.buttons.slice(0, 2) });
      }
      cards.push({ components: cardComps });
    }
    components.push({ type: "CAROUSEL", cards });
  }

  // Submit to Meta. A bad per-number WABA override (#100 "does not exist / no
  // permission") retries once on the portfolio's default WABA so one stale
  // override can't block template creation for the whole number.
  const createUrl = (wid: string) =>
    `https://graph.facebook.com/${apiVersion}/${wid}/message_templates`;
  const payload = JSON.stringify({
    name: input.name,
    language: input.language || "en_US",
    category: input.category,
    components,
  });
  const doCreate = (wid: string) =>
    fetch(createUrl(wid), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: payload,
      cache: "no-store",
    });

  let res = await doCreate(WABA_ID);
  let json = (await res.json()) as {
    id?: string;
    status?: string;
    category?: string;
    error?: { message?: string; error_user_msg?: string; code?: number };
  };
  if (!res.ok && json.error?.code === 100 && creds.fallbackWaba) {
    console.warn(
      `[templates] create on WABA ${WABA_ID} failed (#100) — retrying with portfolio default ${creds.fallbackWaba}`,
    );
    res = await doCreate(creds.fallbackWaba);
    json = (await res.json()) as typeof json;
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: json.error?.error_user_msg ?? json.error?.message ?? `Meta API ${res.status}` },
      { status: 502 },
    );
  }

  // Cache the header preview URL so it can be rendered in lists/pickers.
  // (Meta's API doesn't expose a public URL for the approved sample, so we
  // keep our own copy in template_assets keyed by Meta's template id.)
  const isMediaHeader =
    headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT";
  if (json.id && isMediaHeader && input.header_preview_url) {
    const admin = createServiceRoleClient();
    await admin.from("template_assets").upsert(
      {
        template_id: json.id,
        template_name: input.name,
        language: input.language || "en_US",
        header_format: headerFormat,
        header_url: input.header_preview_url,
      },
      { onConflict: "template_id" },
    );
  }

  return NextResponse.json({
    id: json.id,
    status: json.status ?? "PENDING",
    category: json.category ?? input.category,
  });
}
