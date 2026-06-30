// Workspace key/value settings (the `app_settings` table). Server-only —
// every accessor uses the service-role client, so API routes must do
// their own auth/role checks before calling these.

import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  EMBED_ORIGINS_KEY,
  DEFAULT_EMBED_ORIGINS,
  normalizeOrigin,
} from "@/lib/embed-csp";

/** app_settings.key for the editable AI chat-summary system prompt. */
export const AI_SUMMARY_PROMPT_KEY = "ai_summary_prompt";

/** app_settings.key — JSON array of phone_number_ids the bot is allowed
 *  to fire on. Empty / unset = no whitelist (every per-number `enabled`
 *  config fires as usual). Used for staged rollouts: turn the bot on
 *  for 1-2 test numbers without changing the per-number configs of
 *  everything else, then clear the list to go live everywhere. */
export const AUTOMATION_TEST_WHITELIST_KEY = "automation_test_whitelist";

export async function getAutomationTestWhitelist(): Promise<string[]> {
  const raw = (await getAppSetting(AUTOMATION_TEST_WHITELIST_KEY))?.trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function setAutomationTestWhitelist(
  ids: string[],
): Promise<void> {
  await setAppSetting(
    AUTOMATION_TEST_WHITELIST_KEY,
    JSON.stringify(ids.map((s) => s.trim()).filter(Boolean)),
  );
}

/** app_settings.key — JSON array of patient wa_ids (digits-only) the
 *  bot is allowed to reply to. Empty / unset = bot replies to everyone
 *  on every enabled number. When set, the bot replies ONLY to messages
 *  from these specific patient numbers — used to safely test a freshly
 *  trained bot on the operator's own phone + 1-2 testers without
 *  exposing real customers to wrong answers. */
export const AUTOMATION_TEST_CONTACT_NUMBERS_KEY =
  "automation_test_contact_numbers";

export async function getAutomationTestContactNumbers(): Promise<string[]> {
  const raw = (
    await getAppSetting(AUTOMATION_TEST_CONTACT_NUMBERS_KEY)
  )?.trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => String(x ?? "").replace(/\D/g, ""))
      .filter((s) => s.length >= 6);
  } catch {
    return [];
  }
}

export async function setAutomationTestContactNumbers(
  waIds: string[],
): Promise<void> {
  const cleaned = waIds
    .map((s) => String(s ?? "").replace(/\D/g, ""))
    .filter((s) => s.length >= 6);
  await setAppSetting(
    AUTOMATION_TEST_CONTACT_NUMBERS_KEY,
    JSON.stringify(cleaned),
  );
}


/** app_settings.key for the editable AI reply-suggestion system prompt. */
export const AI_REPLY_PROMPT_KEY = "ai_reply_prompt";

/** Shipped default — used until an owner customises it in Settings → AI.
 *  Keep it provider-agnostic; it's fed straight to the LLM as the
 *  system prompt for the chat-summary feature. */
export const DEFAULT_AI_SUMMARY_PROMPT = `You are a CRM assistant for QHT Clinic, a hair-transplant clinic. You are given a WhatsApp conversation between a clinic agent and a patient/lead.

Write a summary an agent can absorb in about 10 seconds. Cover:
- What the patient wants and their main concern.
- Key facts shared (age, city, hair-loss stage, budget, appointment interest) — only if actually mentioned.
- What the agent promised or the current status of the conversation.
- The clear next step.

Rules:
- 4 to 6 short bullet points. No preamble, no closing line.
- Never invent details that are not in the conversation.
- Plain, simple English.`;

/** Shipped default reply-suggestion prompt — geared at moving the
 *  patient toward booking a hair-transplant consultation. Fed to the
 *  LLM as the system prompt for the "Suggested reply" widget. */
export const DEFAULT_AI_REPLY_PROMPT = `You are a senior patient advisor at QHT Clinic, a hair-transplant clinic. You are given a WhatsApp conversation between a clinic agent and a patient/lead.

Suggest the single best next message the agent should send — written to move the patient closer to booking a hair-transplant consultation or procedure.

The reply should:
- Directly address the patient's last message and any concern they raised.
- Be warm, confident and reassuring — helpful, never pushy.
- Answer their question honestly; if they asked about price or procedure, give a useful answer and gently steer toward a consultation.
- End with one clear, easy next step (e.g. proposing a consultation slot or asking for a convenient time).

Rules:
- Output ONLY the message text the agent can send as-is. No preamble, no quotes, no explanation, no labels.
- Keep it concise — 2 to 5 short sentences, natural for WhatsApp.
- Never invent prices, medical claims, or guarantees that are not in the conversation.`;

/** app_settings.key — global gate for LSQ lead creation from Evolution
 *  (Baileys / unofficial) WhatsApp numbers. Default 'true' (preserves
 *  current behaviour). When 'false', /api/lsq/ensure-lead skips every
 *  inbound whose business number's provider is 'evolution'. Use when
 *  Evolution numbers are flooding LSQ with junk leads. */
export const LSQ_EVOLUTION_LEAD_CREATE_KEY = "lsq_evolution_lead_create_enabled";

export async function getLsqEvolutionLeadCreateEnabled(): Promise<boolean> {
  const raw = (await getAppSetting(LSQ_EVOLUTION_LEAD_CREATE_KEY))?.trim();
  // Default ON when unset.
  return raw !== "false";
}

export async function setLsqEvolutionLeadCreateEnabled(
  enabled: boolean,
): Promise<void> {
  await setAppSetting(
    LSQ_EVOLUTION_LEAD_CREATE_KEY,
    enabled ? "true" : "false",
  );
}

export async function getAppSetting(key: string): Promise<string | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const value = (data?.value as string | undefined) ?? null;
  return value;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const admin = createServiceRoleClient();
  await admin
    .from("app_settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
}

/** Resolved AI summary prompt — the stored override, or the default. */
export async function getAiSummaryPrompt(): Promise<string> {
  const stored = await getAppSetting(AI_SUMMARY_PROMPT_KEY);
  const trimmed = stored?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_AI_SUMMARY_PROMPT;
}

// ---------------------------------------------------------------------------
// Date Align — booking confirmation WhatsApp template. When a name is set, the
// confirmation goes out as an approved UTILITY template (punches through the
// 24h window) with {{1}} = patient name, {{2}} = date. Unset → plain text
// (only delivers inside the 24h window). Configurable in Settings → AI so the
// template can be swapped/removed without a code change.
// ---------------------------------------------------------------------------
export const BOOKING_CONFIRM_TEMPLATE_KEY = "booking_confirm_template_name";
export const BOOKING_CONFIRM_TEMPLATE_LANG_KEY = "booking_confirm_template_lang";

export async function getBookingConfirmTemplate(): Promise<{
  name: string;
  lang: string;
} | null> {
  const [name, lang] = await Promise.all([
    getAppSetting(BOOKING_CONFIRM_TEMPLATE_KEY),
    getAppSetting(BOOKING_CONFIRM_TEMPLATE_LANG_KEY),
  ]);
  const n = name?.trim();
  if (!n) return null;
  return { name: n, lang: lang?.trim() || "en_US" };
}

// ---------------------------------------------------------------------------
// CRM embed — origins allowed to frame /embed (managed in Settings → Embed so
// adding a CRM domain needs no rebuild). The runtime CSP header is built from
// this list in middleware; these helpers power the settings API.
// ---------------------------------------------------------------------------
export async function getEmbedAllowedOrigins(): Promise<string[]> {
  const raw = await getAppSetting(EMBED_ORIGINS_KEY);
  if (!raw) return DEFAULT_EMBED_ORIGINS; // never saved → env seed
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_EMBED_ORIGINS;
    // An explicitly-saved empty list is honoured (owner removed every origin).
    return arr
      .map((o) => normalizeOrigin(String(o)))
      .filter((o): o is string => o !== null);
  } catch {
    return DEFAULT_EMBED_ORIGINS;
  }
}

export async function setEmbedAllowedOrigins(origins: string[]): Promise<string[]> {
  const cleaned = [
    ...new Set(
      (origins ?? [])
        .map((o) => normalizeOrigin(String(o)))
        .filter((o): o is string => o !== null),
    ),
  ].slice(0, 50);
  await setAppSetting(EMBED_ORIGINS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

/** Resolved AI reply-suggestion prompt — the stored override, or the default. */
export async function getAiReplyPrompt(): Promise<string> {
  const stored = await getAppSetting(AI_REPLY_PROMPT_KEY);
  const trimmed = stored?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_AI_REPLY_PROMPT;
}

/** app_settings.key for the editable "Package Shared" extraction prompt. */
export const AI_PACKAGE_PROMPT_KEY = "ai_package_prompt";

/** Shipped default — drives the "Package Shared" section in the contact
 *  panel. Pulls only the quoted hair-transplant package out of the LSQ
 *  lead notes. */
export const DEFAULT_AI_PACKAGE_PROMPT = `You are a CRM assistant for QHT Clinic, a hair-transplant clinic. You are given the package-related fields of one lead from the LeadSquared CRM — the hair-transplant package quoted to this patient.

Lay out the COMPLETE package exactly as quoted. Present EVERY field given — do not omit, merge, shorten or skip anything. Cover graft count, price per graft, total package price, inclusions (GST, PRP, medicines, post-op kit, follow-ups), technique, surgery / booking details, offers and payment terms — whatever fields are present.

Rules:
- One clear line per field. Include every field — the answer can be as long as needed.
- Format prices with the rupee sign (e.g. ₹1,22,500).
- Use only the given fields — never invent numbers or details.
- No preamble, no closing line.`;

/** Resolved "Package Shared" prompt — the stored override, or the default. */
export async function getAiPackagePrompt(): Promise<string> {
  const stored = await getAppSetting(AI_PACKAGE_PROMPT_KEY);
  const trimmed = stored?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_AI_PACKAGE_PROMPT;
}

/** app_settings.key — IST clock time (HH:MM) the nightly Evolution +
 *  LSQ sync should fire at. Empty / unset = disabled. The cron endpoint
 *  /api/cron/nightly-sync checks this and only runs when current IST is
 *  within ±5 min of this value, so a 5-minute crontab heartbeat hits the
 *  configured slot once per night. */
export const NIGHTLY_SYNC_TIME_KEY = "nightly_sync_time_ist";

/** app_settings.key — JSON `{ last_run_at, status, summary }` written by
 *  /api/cron/nightly-sync after each fire. Drives the "last run" line in
 *  the UI so the operator can see the cron actually fired. */
export const NIGHTLY_SYNC_LAST_RUN_KEY = "nightly_sync_last_run";

export async function getNightlySyncTime(): Promise<string | null> {
  const raw = (await getAppSetting(NIGHTLY_SYNC_TIME_KEY))?.trim();
  if (!raw) return null;
  // Accept HH:MM (24h). Reject anything else so a bad value can't
  // accidentally fire the cron at an unexpected time.
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw : null;
}

export async function setNightlySyncTime(hhmm: string | null): Promise<void> {
  const cleaned = (hhmm ?? "").trim();
  if (!cleaned) {
    await setAppSetting(NIGHTLY_SYNC_TIME_KEY, "");
    return;
  }
  if (!/^\d{1,2}:\d{2}$/.test(cleaned)) {
    throw new Error("Time must be HH:MM (24-hour)");
  }
  await setAppSetting(NIGHTLY_SYNC_TIME_KEY, cleaned);
}

/** Live progress record updated by /api/cron/nightly-sync as the run
 *  proceeds. Persisted in app_settings so it survives page refresh —
 *  the UI polls this every couple of seconds and shows a live bar. */
export const NIGHTLY_SYNC_PROGRESS_KEY = "nightly_sync_progress";

export interface NightlySyncProgress {
  /** idle = no run in flight (the only state where the UI hides the live
   *  bar). done = finished but kept around briefly so the UI can show
   *  the final numbers before fading. */
  phase: "idle" | "evolution" | "lsq" | "done";
  started_at: string | null;
  evo_total: number;
  evo_done: number;
  evo_current: string | null;
  evo_ingested: number;
  lsq_total: number;
  lsq_done: number;
  lsq_matched: number;
  message: string | null;
  /** Instance names that finished successfully during the current slot.
   *  Skipped on subsequent retries within the same slot so a 5-min
   *  auto-retry only re-attempts the ones that errored. Cleared when a
   *  fresh slot begins (last_run_at older than the retry window). */
  completed_instances?: string[];
  /** Operator-requested cancel. Cron loop polls this between each
   *  instance / LSQ batch and bails as soon as it goes true. The next
   *  fresh run clears it. */
  requested_cancel?: boolean;
}

const EMPTY_PROGRESS: NightlySyncProgress = {
  phase: "idle",
  started_at: null,
  evo_total: 0,
  evo_done: 0,
  evo_current: null,
  evo_ingested: 0,
  lsq_total: 0,
  lsq_done: 0,
  lsq_matched: 0,
  message: null,
  completed_instances: [],
  requested_cancel: false,
};

export async function getNightlySyncProgress(): Promise<NightlySyncProgress> {
  const raw = await getAppSetting(NIGHTLY_SYNC_PROGRESS_KEY);
  if (!raw) return EMPTY_PROGRESS;
  try {
    const p = JSON.parse(raw) as Partial<NightlySyncProgress>;
    return { ...EMPTY_PROGRESS, ...p };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export async function setNightlySyncProgress(
  patch: Partial<NightlySyncProgress>,
): Promise<NightlySyncProgress> {
  const current = await getNightlySyncProgress();
  const next: NightlySyncProgress = { ...current, ...patch };
  await setAppSetting(NIGHTLY_SYNC_PROGRESS_KEY, JSON.stringify(next));
  return next;
}

export interface NightlySyncLastRun {
  last_run_at: string;
  status: "success" | "error" | "skipped" | "cancelled";
  summary?: string;
  evolution_pages?: number;
  evolution_ingested?: number;
  lsq_processed?: number;
  lsq_matched?: number;
  error?: string;
}

export async function getNightlySyncLastRun(): Promise<NightlySyncLastRun | null> {
  const raw = await getAppSetting(NIGHTLY_SYNC_LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NightlySyncLastRun;
  } catch {
    return null;
  }
}

export async function setNightlySyncLastRun(
  payload: NightlySyncLastRun,
): Promise<void> {
  await setAppSetting(NIGHTLY_SYNC_LAST_RUN_KEY, JSON.stringify(payload));
}

/** app_settings.key for the workspace AI output language. */
export const AI_OUTPUT_LANGUAGE_KEY = "ai_output_language";

export type AiLanguage = "english" | "hindi" | "hinglish";

/** Resolved AI output language — defaults to English. Set in
 *  Settings → AI; the AI is told to write its output in this language. */
export async function getAiOutputLanguage(): Promise<AiLanguage> {
  const v = (await getAppSetting(AI_OUTPUT_LANGUAGE_KEY))?.trim();
  return v === "hindi" || v === "hinglish" ? v : "english";
}

/** A sentence appended to a system prompt telling the model which
 *  language to answer in. */
export function aiLanguageInstruction(lang: AiLanguage): string {
  if (lang === "hindi") {
    return "\n\nWrite the entire output in Hindi, using Devanagari script.";
  }
  if (lang === "hinglish") {
    return "\n\nWrite the entire output in Hinglish — conversational Hindi written in Roman (English) script, natural and casual.";
  }
  return "\n\nWrite the entire output in clear, simple English.";
}
