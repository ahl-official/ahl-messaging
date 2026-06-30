import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { listPortfolios } from "@/lib/portfolios";
import { FB_AD_SOURCE_KEYS } from "@/lib/utm";

export const runtime = "nodejs";

interface AutomationConfig {
  id: string;
  business_phone_number_id: string;
  enabled: boolean;
  system_prompt: string;
  model: string;
  temperature: number;
  context_window: number;
  human_takeover_minutes: number;
  reply_word_limit: number;
  created_at: string;
  updated_at: string;
}

// =====================================================================
// GET /api/automation/config
// Returns one row per business number, joining with business_numbers so
// the UI can label rows with verified_name / display_phone_number.
// =====================================================================
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Read access: any team member.
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data: numbers } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, nickname, provider")
    .order("verified_name", { ascending: true });

  const { data: configs } = await admin
    .from("automation_configs")
    .select("*");

  const configByPhone = new Map<string, AutomationConfig>();
  for (const c of (configs ?? []) as AutomationConfig[]) {
    configByPhone.set(c.business_phone_number_id, c);
  }

  // Portfolio assignment is config-only — bolt it on so the UI can
  // group numbers by portfolio (and split Evolution into its own group).
  const portfolioByPhoneId = new Map<
    string,
    { key: string; name: string; provider: string }
  >();
  for (const p of listPortfolios()) {
    for (const id of p.phone_number_ids ?? []) {
      portfolioByPhoneId.set(id, {
        key: p.key,
        name: p.name,
        provider: p.provider ?? "meta",
      });
    }
  }

  // Make sure every business number has a config row in the response
  // (synthesizes a default one for numbers that haven't been configured
  // yet, so the UI always has something to render).
  const rows = ((numbers ?? []) as Array<{
    phone_number_id: string;
    display_phone_number: string | null;
    verified_name: string | null;
    nickname: string | null;
    provider: "meta" | "evolution" | null;
  }>).map((n) => ({
    business_phone_number_id: n.phone_number_id,
    display_phone_number: n.display_phone_number,
    verified_name: n.verified_name,
    nickname: n.nickname,
    provider: n.provider ?? "meta",
    portfolio: portfolioByPhoneId.get(n.phone_number_id) ?? null,
    config: configByPhone.get(n.phone_number_id) ?? null,
  }));

  return NextResponse.json({ rows });
}

// =====================================================================
// PUT /api/automation/config
// Upserts a config row. Restricted to admin+ so teammates can't change
// the AI's instructions.
// =====================================================================
interface PutBody {
  business_phone_number_id?: string;
  enabled?: boolean;
  system_prompt?: string;
  model?: string;
  /** "openai" or "ollama" — picks the LLM backend the automation
   *  pipeline calls. Defaults to "openai" when not set. */
  provider?: "openai" | "ollama";
  temperature?: number;
  context_window?: number;
  human_takeover_minutes?: number;
  /** Seconds the bot pauses after generating a reply before sending it.
   *  Helps the bot feel less robotic — paired with the typing indicator
   *  it mimics "reading + typing" behaviour. 0–60. */
  reply_delay_seconds?: number;
  /** Max words per bot reply (0 = no limit). Over-long replies are
   *  compressed to one short line. Default 15. */
  reply_word_limit?: number;
  /** Pre-LLM debounce window — wait this many seconds after each
   *  inbound message before triggering the LLM. Resets on every new
   *  inbound, so a patient typing 3 quick messages gets ONE combined
   *  reply instead of three racing ones. 0–120. */
  inbound_debounce_seconds?: number;
  /** Per-number map of "what to extract" → "which LSQ lead field
   *  to update". Each entry triggers a post-reply extraction pass. */
  field_mappings?: Array<{ description?: string; lsq_field?: string }>;
  /** Static field=value pairs (Source / Sub Source / etc.) applied to
   *  every Lead.CreateOrUpdate from this number. Stored as constants —
   *  not extracted from chat. */
  lead_defaults?: Array<{ lsq_field?: string; value?: string }>;
  /** Which {lsq_field,value} pairs to PATCH onto an EXISTING LSQ lead when
   *  "update existing leads" is on. Empty = fall back to lead_defaults. */
  update_lead_fields?: Array<{ lsq_field?: string; value?: string }>;
  /** Meta ad-attribution → LSQ field mappings. Each pushes a value from
   *  contacts.utm_params (source_id / ctwa_clid / campaign_name / …) onto
   *  the lead. `source` is one of FB_AD_SOURCE_KEYS. */
  lsq_fb_ads_fields?: Array<{ lsq_field?: string; source?: string }>;
  /** Free-text suffix appended to every LSQ ActivityNote on this
   *  number — used to identify the source channel in LSQ reports
   *  (e.g. "Insta WA 9084723091"). */
  activity_note_suffix?: string;
  /** Optional override prompt used when the inbound is an image —
   *  empty string falls back to system_prompt at runtime. */
  image_system_prompt?: string | null;
  /** Debounce window before replying to an image (0–120s). 0 disables. */
  image_reply_delay_seconds?: number;
  /** ProspectStage to set after the first photo arrives. */
  photo_lead_stage_target?: string;
  /** Stages the lead must currently be in for the auto-transition. */
  photo_lead_stage_allowed_from?: string[];
  /** Outbound text → image swap rules. */
  image_response_triggers?: Array<{
    patterns?: string[];
    image_url?: string;
    caption?: string;
    gate_by_stage?: boolean;
  }>;
  /** Optional Whisper context prompt — fed to OpenAI's transcription
   *  endpoint as `prompt` so domain-specific terms (graft, FUE, etc.)
   *  come back spelled correctly. Per-number, like the AI persona. */
  transcription_prompt?: string | null;
  /** Per-number capability switches (see 0018 migration). Default true
   *  for every flag — only sent in the body when the operator flips one. */
  lsq_lead_create_enabled?: boolean;
  lsq_field_extraction_enabled?: boolean;
  lsq_activity_log_enabled?: boolean;
  lsq_photo_stage_enabled?: boolean;
  image_auto_reply_enabled?: boolean;
  call_recording_enabled?: boolean;
  call_transcribe_enabled?: boolean;
  /** RAG settings (see 0019 migration). */
  use_rag?: boolean;
  rag_top_k?: number;
  rag_core_prompt?: string | null;
  /** Operator-defined "never do this" rules (0063 migration). Appended
   *  to the system prompt as a strict-rules block. */
  guardrails_text?: string | null;
  /** Per-stage persona map { "<lsq stage>": "<persona text>" }. */
  stage_personas?: Record<string, string> | null;
  /** When an inbound arrives from a phone that already has an LSQ lead,
   *  overwrite its Source / mx_Sub_source with this number's lead_defaults.
   *  Default OFF — preserves the original attribution. (0027 migration.) */
  update_existing_lead_source?: boolean;
  /** Only re-attribute existing leads whose CreatedOn is within this many
   *  days. NULL / 0 = no age cap (any age allowed if toggle is on). */
  update_existing_lead_max_age_days?: number | null;
}

const CAPABILITY_KEYS = [
  "lsq_lead_create_enabled",
  "lsq_field_extraction_enabled",
  "lsq_activity_log_enabled",
  "lsq_photo_stage_enabled",
  "image_auto_reply_enabled",
  "call_recording_enabled",
  "call_transcribe_enabled",
] as const;

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const phoneNumberId = body.business_phone_number_id?.trim();
  if (!phoneNumberId) {
    return NextResponse.json(
      { error: "business_phone_number_id is required" },
      { status: 400 },
    );
  }

  if (body.system_prompt !== undefined && body.system_prompt.trim().length === 0) {
    return NextResponse.json(
      { error: "System prompt cannot be empty" },
      { status: 400 },
    );
  }
  if (body.system_prompt && body.system_prompt.length > 100000) {
    return NextResponse.json(
      { error: "System prompt too long (100000 max)" },
      { status: 400 },
    );
  }
  if (
    body.temperature !== undefined &&
    (body.temperature < 0 || body.temperature > 2)
  ) {
    return NextResponse.json({ error: "Temperature must be 0–2" }, { status: 400 });
  }
  if (
    body.context_window !== undefined &&
    (body.context_window < 1 || body.context_window > 200)
  ) {
    return NextResponse.json(
      { error: "Context window must be 1–200" },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    business_phone_number_id: phoneNumberId,
  };
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.system_prompt !== undefined) update.system_prompt = body.system_prompt.trim();
  if (body.model !== undefined) update.model = body.model;
  if (body.provider !== undefined) {
    if (body.provider !== "openai" && body.provider !== "ollama") {
      return NextResponse.json(
        { error: "provider must be 'openai' or 'ollama'" },
        { status: 400 },
      );
    }
    update.provider = body.provider;
  }
  if (body.temperature !== undefined) update.temperature = body.temperature;
  if (body.context_window !== undefined) update.context_window = body.context_window;
  if (body.reply_word_limit !== undefined) {
    if (body.reply_word_limit < 0 || body.reply_word_limit > 200) {
      return NextResponse.json(
        { error: "reply_word_limit must be between 0 and 200" },
        { status: 400 },
      );
    }
    update.reply_word_limit = body.reply_word_limit;
  }
  if (body.human_takeover_minutes !== undefined) {
    update.human_takeover_minutes = body.human_takeover_minutes;
  }
  if (body.inbound_debounce_seconds !== undefined) {
    if (body.inbound_debounce_seconds < 0 || body.inbound_debounce_seconds > 120) {
      return NextResponse.json(
        { error: "inbound_debounce_seconds must be between 0 and 120" },
        { status: 400 },
      );
    }
    update.inbound_debounce_seconds = body.inbound_debounce_seconds;
  }
  if (body.reply_delay_seconds !== undefined) {
    if (body.reply_delay_seconds < 0 || body.reply_delay_seconds > 60) {
      return NextResponse.json(
        { error: "reply_delay_seconds must be between 0 and 60" },
        { status: 400 },
      );
    }
    update.reply_delay_seconds = body.reply_delay_seconds;
  }
  if (body.field_mappings !== undefined) {
    if (!Array.isArray(body.field_mappings)) {
      return NextResponse.json(
        { error: "field_mappings must be an array" },
        { status: 400 },
      );
    }
    // Drop incomplete rows so the DB only stores valid mappings.
    update.field_mappings = body.field_mappings
      .filter((m) => m && typeof m.description === "string" && typeof m.lsq_field === "string")
      .map((m) => ({
        description: (m.description ?? "").trim(),
        lsq_field: (m.lsq_field ?? "").trim(),
      }))
      .filter((m) => m.description && m.lsq_field);
  }
  if (body.activity_note_suffix !== undefined) {
    if (typeof body.activity_note_suffix !== "string") {
      return NextResponse.json(
        { error: "activity_note_suffix must be a string" },
        { status: 400 },
      );
    }
    if (body.activity_note_suffix.length > 200) {
      return NextResponse.json(
        { error: "activity_note_suffix too long (200 max)" },
        { status: 400 },
      );
    }
    update.activity_note_suffix = body.activity_note_suffix.trim();
  }
  if (body.lead_defaults !== undefined) {
    if (!Array.isArray(body.lead_defaults)) {
      return NextResponse.json(
        { error: "lead_defaults must be an array" },
        { status: 400 },
      );
    }
    update.lead_defaults = body.lead_defaults
      .filter((d) => d && typeof d.lsq_field === "string" && typeof d.value === "string")
      .map((d) => ({
        lsq_field: (d.lsq_field ?? "").trim(),
        value: (d.value ?? "").trim(),
      }))
      .filter((d) => d.lsq_field && d.value);
  }
  if (body.update_lead_fields !== undefined) {
    if (!Array.isArray(body.update_lead_fields)) {
      return NextResponse.json(
        { error: "update_lead_fields must be an array" },
        { status: 400 },
      );
    }
    update.update_lead_fields = body.update_lead_fields
      .filter((d) => d && typeof d.lsq_field === "string" && typeof d.value === "string")
      .map((d) => ({
        lsq_field: (d.lsq_field ?? "").trim(),
        value: (d.value ?? "").trim(),
      }))
      .filter((d) => d.lsq_field && d.value);
  }
  if (body.lsq_fb_ads_fields !== undefined) {
    if (!Array.isArray(body.lsq_fb_ads_fields)) {
      return NextResponse.json(
        { error: "lsq_fb_ads_fields must be an array" },
        { status: 400 },
      );
    }
    update.lsq_fb_ads_fields = body.lsq_fb_ads_fields
      .filter((d) => d && typeof d.lsq_field === "string" && typeof d.source === "string")
      .map((d) => ({
        lsq_field: (d.lsq_field ?? "").trim(),
        source: (d.source ?? "").trim(),
      }))
      .filter((d) => d.lsq_field && FB_AD_SOURCE_KEYS.includes(d.source));
  }
  if (body.image_system_prompt !== undefined) {
    if (
      body.image_system_prompt !== null &&
      typeof body.image_system_prompt !== "string"
    ) {
      return NextResponse.json(
        { error: "image_system_prompt must be a string or null" },
        { status: 400 },
      );
    }
    if (
      typeof body.image_system_prompt === "string" &&
      body.image_system_prompt.length > 100000
    ) {
      return NextResponse.json(
        { error: "image_system_prompt too long (100000 max)" },
        { status: 400 },
      );
    }
    update.image_system_prompt =
      typeof body.image_system_prompt === "string"
        ? body.image_system_prompt.trim() || null
        : null;
  }
  if (body.image_reply_delay_seconds !== undefined) {
    if (
      body.image_reply_delay_seconds < 0 ||
      body.image_reply_delay_seconds > 120
    ) {
      return NextResponse.json(
        { error: "image_reply_delay_seconds must be 0–120" },
        { status: 400 },
      );
    }
    update.image_reply_delay_seconds = body.image_reply_delay_seconds;
  }
  if (body.photo_lead_stage_target !== undefined) {
    if (typeof body.photo_lead_stage_target !== "string") {
      return NextResponse.json(
        { error: "photo_lead_stage_target must be a string" },
        { status: 400 },
      );
    }
    update.photo_lead_stage_target = body.photo_lead_stage_target.trim();
  }
  if (body.photo_lead_stage_allowed_from !== undefined) {
    if (!Array.isArray(body.photo_lead_stage_allowed_from)) {
      return NextResponse.json(
        { error: "photo_lead_stage_allowed_from must be an array" },
        { status: 400 },
      );
    }
    update.photo_lead_stage_allowed_from = body.photo_lead_stage_allowed_from
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
  }
  if (body.image_response_triggers !== undefined) {
    if (!Array.isArray(body.image_response_triggers)) {
      return NextResponse.json(
        { error: "image_response_triggers must be an array" },
        { status: 400 },
      );
    }
    update.image_response_triggers = body.image_response_triggers
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const patterns = Array.isArray(t.patterns)
          ? t.patterns
              .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
              .map((p) => p.trim())
          : [];
        const imageUrl = typeof t.image_url === "string" ? t.image_url.trim() : "";
        if (patterns.length === 0 || !imageUrl) return null;
        return {
          patterns,
          image_url: imageUrl,
          caption: typeof t.caption === "string" ? t.caption.trim() : "",
          gate_by_stage: t.gate_by_stage !== false,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }
  if (body.transcription_prompt !== undefined) {
    if (
      body.transcription_prompt !== null &&
      typeof body.transcription_prompt !== "string"
    ) {
      return NextResponse.json(
        { error: "transcription_prompt must be a string or null" },
        { status: 400 },
      );
    }
    if (
      typeof body.transcription_prompt === "string" &&
      body.transcription_prompt.length > 4000
    ) {
      return NextResponse.json(
        { error: "transcription_prompt too long (4000 max)" },
        { status: 400 },
      );
    }
    update.transcription_prompt =
      typeof body.transcription_prompt === "string"
        ? body.transcription_prompt.trim() || null
        : null;
  }
  for (const k of CAPABILITY_KEYS) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === "boolean") update[k] = v;
  }
  if (typeof body.use_rag === "boolean") update.use_rag = body.use_rag;
  if (typeof body.rag_top_k === "number") {
    if (body.rag_top_k < 1 || body.rag_top_k > 20) {
      return NextResponse.json(
        { error: "rag_top_k must be 1-20" },
        { status: 400 },
      );
    }
    update.rag_top_k = Math.round(body.rag_top_k);
  }
  if (typeof body.update_existing_lead_source === "boolean") {
    update.update_existing_lead_source = body.update_existing_lead_source;
  }
  if (body.update_existing_lead_max_age_days !== undefined) {
    const v = body.update_existing_lead_max_age_days;
    if (v === null) {
      update.update_existing_lead_max_age_days = null;
    } else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 3650) {
      update.update_existing_lead_max_age_days = Math.round(v) || null;
    } else {
      return NextResponse.json(
        { error: "update_existing_lead_max_age_days must be 0–3650 or null" },
        { status: 400 },
      );
    }
  }
  if (body.rag_core_prompt !== undefined) {
    if (
      body.rag_core_prompt !== null &&
      typeof body.rag_core_prompt !== "string"
    ) {
      return NextResponse.json(
        { error: "rag_core_prompt must be a string or null" },
        { status: 400 },
      );
    }
    if (
      typeof body.rag_core_prompt === "string" &&
      body.rag_core_prompt.length > 100000
    ) {
      return NextResponse.json(
        { error: "rag_core_prompt too long (100000 max)" },
        { status: 400 },
      );
    }
    update.rag_core_prompt =
      typeof body.rag_core_prompt === "string"
        ? body.rag_core_prompt.trim() || null
        : null;
  }

  if (body.guardrails_text !== undefined) {
    if (
      body.guardrails_text !== null &&
      typeof body.guardrails_text !== "string"
    ) {
      return NextResponse.json(
        { error: "guardrails_text must be a string or null" },
        { status: 400 },
      );
    }
    if (
      typeof body.guardrails_text === "string" &&
      body.guardrails_text.length > 20000
    ) {
      return NextResponse.json(
        { error: "guardrails_text too long (20000 max)" },
        { status: 400 },
      );
    }
    update.guardrails_text =
      typeof body.guardrails_text === "string"
        ? body.guardrails_text.trim() || null
        : null;
  }

  if (body.stage_personas !== undefined) {
    const sp = body.stage_personas;
    if (sp === null) {
      update.stage_personas = {};
    } else if (typeof sp !== "object" || Array.isArray(sp)) {
      return NextResponse.json(
        { error: "stage_personas must be an object of { stage: text }" },
        { status: 400 },
      );
    } else {
      const clean: Record<string, string> = {};
      let total = 0;
      for (const [k, v] of Object.entries(sp)) {
        const stage = String(k).trim();
        const text = typeof v === "string" ? v.trim() : "";
        if (!stage || !text) continue;
        clean[stage] = text;
        total += text.length;
      }
      if (total > 400000) {
        return NextResponse.json({ error: "stage_personas too large" }, { status: 400 });
      }
      update.stage_personas = clean;
    }
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("automation_configs")
    .upsert(update, { onConflict: "business_phone_number_id" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}
