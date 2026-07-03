"use client";

// Settings → Capabilities. Per-number on/off matrix for every automation
// + LSQ + Calls feature with inline explanations of what each does and
// where the runtime lives. Reads/writes automation_configs columns.

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  Check,
  Database,
  FileAudio,
  Headphones,
  Image as ImageIcon,
  Loader2,
  Mic,
  Phone,
  ScrollText,
  Sparkles,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

type FeatureKey =
  | "enabled" // AI auto-reply
  | "lsq_lead_create_enabled"
  | "lsq_field_extraction_enabled"
  | "lsq_activity_log_enabled"
  | "lsq_photo_stage_enabled"
  | "image_auto_reply_enabled"
  | "call_recording_enabled"
  | "call_transcribe_enabled";

interface Feature {
  key: FeatureKey;
  group: "AI" | "LSQ" | "Calls";
  title: string;
  short: string;
  how: string;
  icon: LucideIcon;
}

const FEATURES: Feature[] = [
  {
    key: "enabled",
    group: "AI",
    title: "AI auto-reply",
    short: "Bot replies to inbound messages using the persona prompt",
    how: "Webhook receives an inbound → /api/automation/process schedules a reply via lib/automation.ts → OpenAI/Ollama generates reply → WhatsApp Cloud API sends it. Off = silent (no AI reply, agent handles manually).",
    icon: Sparkles,
  },
  {
    key: "image_auto_reply_enabled",
    group: "AI",
    title: "Image auto-reply (text → image swap)",
    short: "When AI's text matches a configured pattern, send the image instead",
    how: "After lib/automation.ts generates a text reply, it checks image_response_triggers. If a pattern matches AND the lead's stage is in the allow-list, dispatches the image (with optional caption) instead of the raw text. Off = always send text.",
    icon: ImageIcon,
  },
  {
    key: "lsq_lead_create_enabled",
    group: "LSQ",
    title: "Auto-create lead on first inbound",
    short: "New contact → push to LSQ as a fresh lead",
    how: "/api/lsq/ensure-lead is called fire-and-forget by the webhook for every inbound. Looks up by phone, creates if missing, caches lsq_prospect_id back on the contact. Lead defaults (Source / Sub Source) are stamped here. Off = contact stays local-only.",
    icon: BadgeCheck,
  },
  {
    key: "lsq_field_extraction_enabled",
    group: "LSQ",
    title: "Field extraction (name / age / email / etc.)",
    short: "After the AI reply, a 2nd LLM pass pulls structured fields and updates LSQ",
    how: "Triggered by lib/automation.ts post-reply. Reads field_mappings (description → LSQ schema field), runs an extraction LLM call against the recent chat history, then Lead.Update on the matching prospect. Off = CRM lead never gets updated from chat content.",
    icon: ScrollText,
  },
  {
    key: "lsq_activity_log_enabled",
    group: "LSQ",
    title: "Activity log on every reply",
    short: "Every inbound + every outbound message logged as a ProspectActivity",
    how: "lib/lsq-message-logger.ts is called from both directions. Builds the note as `<text> - (<activity_note_suffix>)` and POSTs ProspectActivity.svc/Create. Off = LSQ timeline shows no chat activity for this number.",
    icon: ScrollText,
  },
  {
    key: "lsq_photo_stage_enabled",
    group: "LSQ",
    title: "Auto-stage transition on photo received",
    short: "Client sends a photo → lead stage moves to the configured target",
    how: "Webhook detects an inbound image → /api/lsq/photo-received uploads to LSQ + creates an activity + (if current stage ∈ allow-list) updates ProspectStage to the configured target. Off = no automatic stage move.",
    icon: ImageIcon,
  },
  {
    key: "call_recording_enabled",
    group: "Calls",
    title: "Call recording",
    short: "Mixed-audio recording of every WhatsApp call gets stored",
    how: "Browser merges local + remote streams via Web Audio, posts to /api/whatsapp-call/[id]/recording when the call ends. Bytes go to Supabase Storage; URL saved on whatsapp_calls.recording_url. Off = no audio is persisted (the call still happens).",
    icon: FileAudio,
  },
  {
    key: "call_transcribe_enabled",
    group: "Calls",
    title: "Call transcription (Whisper)",
    short: "Manual button on each call card runs Whisper + writes transcript",
    how: "Operator clicks Transcribe on /calls → /api/whatsapp-call/[id]/transcribe pulls the recording, calls OpenAI Whisper with the per-number transcription_prompt as context, saves the result. Off = button hidden / 403 from server.",
    icon: Mic,
  },
];

interface NumberRow {
  business_phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  config: Record<string, unknown> | null;
}

interface ApiResp {
  rows?: NumberRow[];
  error?: string;
}

const GROUP_META: Record<
  Feature["group"],
  { label: string; icon: LucideIcon; tone: string }
> = {
  AI: { label: "AI auto-reply", icon: Sparkles, tone: "from-violet-500 to-violet-700" },
  LSQ: { label: "CRM", icon: Database, tone: "from-emerald-500 to-emerald-700" },
  Calls: { label: "WhatsApp calls", icon: Headphones, tone: "from-sky-500 to-sky-700" },
};

export function CapabilitiesView() {
  const [rows, setRows] = useState<NumberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/automation/config", { cache: "no-store" });
      const json = (await res.json()) as ApiResp;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      if (!activeId && json.rows?.length) {
        setActiveId(json.rows[0].business_phone_number_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(
    () => rows?.find((r) => r.business_phone_number_id === activeId) ?? null,
    [rows, activeId],
  );

  return (
    <div className="flex h-full flex-col">
      <SettingsPageHeader
        icon={SlidersHorizontal}
        tone="sky"
        title="Number capabilities"
        subtitle="Toggle automation, LSQ, and call features per WhatsApp number. Flip off → that workflow stops on the next event."
      />
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <div className="grid h-32 place-items-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/50 px-6 py-8 text-center text-sm text-muted-foreground">
          No business numbers connected yet.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          {/* Number rail */}
          <nav className="flex flex-col gap-1.5">
            {rows.map((r) => {
              const isActive = r.business_phone_number_id === activeId;
              const offCount = countOff(r);
              return (
                <button
                  key={r.business_phone_number_id}
                  type="button"
                  onClick={() => setActiveId(r.business_phone_number_id)}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition",
                    isActive
                      ? "border-primary/40 bg-primary/5 shadow-sm"
                      : "border-transparent hover:bg-secondary",
                  )}
                >
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-sm font-semibold">
                      {r.verified_name || r.display_phone_number || r.business_phone_number_id}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {r.display_phone_number || r.business_phone_number_id}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "inline-flex h-6 shrink-0 items-center justify-center rounded-full px-2 text-[10px] font-semibold ring-1 ring-inset",
                      offCount === 0
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                        : "bg-amber-50 text-amber-800 ring-amber-200",
                    )}
                  >
                    {offCount === 0
                      ? `${FEATURES.length} on`
                      : `${FEATURES.length - offCount}/${FEATURES.length} on`}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Feature matrix for the active number */}
          {active ? (
            <NumberCapabilities key={active.business_phone_number_id} row={active} onSaved={load} />
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}

function countOff(r: NumberRow): number {
  if (!r.config) return 0;
  let n = 0;
  for (const f of FEATURES) {
    const v = r.config[f.key];
    if (v === false) n++;
  }
  return n;
}

function NumberCapabilities({
  row,
  onSaved,
}: {
  row: NumberRow;
  onSaved: () => void;
}) {
  const initial = useMemo<Record<FeatureKey, boolean>>(() => {
    const out = {} as Record<FeatureKey, boolean>;
    for (const f of FEATURES) {
      const raw = row.config?.[f.key];
      out[f.key] = raw === undefined || raw === null ? true : Boolean(raw);
    }
    return out;
  }, [row]);

  const [draft, setDraft] = useState<Record<FeatureKey, boolean>>(initial);
  const [savingKey, setSavingKey] = useState<FeatureKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<FeatureKey | null>(null);

  async function toggle(key: FeatureKey, next: boolean) {
    setDraft((d) => ({ ...d, [key]: next }));
    setSavingKey(key);
    setErr(null);
    try {
      const res = await fetch("/api/automation/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: row.business_phone_number_id,
          [key]: next,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedKey(key);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500);
      onSaved();
    } catch (e) {
      // Revert on failure.
      setDraft((d) => ({ ...d, [key]: !next }));
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingKey((k) => (k === key ? null : k));
    }
  }

  const groups = useMemo(() => {
    const out: Record<Feature["group"], Feature[]> = { AI: [], LSQ: [], Calls: [] };
    for (const f of FEATURES) out[f.group].push(f);
    return out;
  }, []);

  const numberLabel =
    row.verified_name || row.display_phone_number || row.business_phone_number_id;
  const phoneLine = row.display_phone_number || row.business_phone_number_id;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Phone className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{numberLabel}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {phoneLine}
            </div>
          </div>
        </div>
      </div>

      {err ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="mr-1.5 inline h-3.5 w-3.5" /> {err}
        </div>
      ) : null}

      {(Object.keys(groups) as Feature["group"][]).map((group) => {
        const meta = GROUP_META[group];
        const GroupIcon = meta.icon;
        return (
          <section
            key={group}
            className="overflow-hidden rounded-xl border bg-card shadow-sm"
          >
            <header className="flex items-center gap-3 border-b bg-secondary/30 px-5 py-3">
              <span
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm",
                  meta.tone,
                )}
              >
                <GroupIcon className="h-3.5 w-3.5" />
              </span>
              <h3 className="text-sm font-semibold">{meta.label}</h3>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {groups[group].filter((f) => draft[f.key]).length} / {groups[group].length} on
              </span>
            </header>
            <ul className="divide-y">
              {groups[group].map((f) => {
                const Icon = f.icon;
                const value = draft[f.key];
                const isSaving = savingKey === f.key;
                const justSaved = savedKey === f.key;
                return (
                  <li key={f.key} className="flex items-start gap-3 px-5 py-4">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md ring-1 ring-inset",
                        value
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : "bg-secondary text-muted-foreground ring-border",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{f.title}</span>
                        {value ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            Live
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground ring-1 ring-inset ring-border">
                            Off
                          </span>
                        )}
                        {justSaved ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
                            <Check className="h-3 w-3" />
                            Saved
                          </span>
                        ) : null}
                      </div>
                      <p className="text-[12px] text-foreground/80">{f.short}</p>
                      <details className="group/d">
                        <summary className="cursor-pointer list-none text-[11px] font-medium text-primary/80 hover:text-primary">
                          <span className="inline-flex items-center gap-1">
                            How it works
                            <span className="transition-transform group-open/d:rotate-90">›</span>
                          </span>
                        </summary>
                        <p className="mt-1 rounded-md border bg-secondary/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          {f.how}
                        </p>
                      </details>
                    </div>
                    <Switch
                      checked={value}
                      saving={isSaving}
                      onChange={(next) => toggle(f.key, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Switch({
  checked,
  saving,
  onChange,
}: {
  checked: boolean;
  saving?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={saving}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-flex h-5 w-5 transform items-center justify-center rounded-full bg-background shadow ring-1 ring-border transition",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
      </span>
    </button>
  );
}
