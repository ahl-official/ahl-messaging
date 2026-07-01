"use client";

// Automation page — AI auto-reply config + live activity. Per-number,
// owner/admin-facing. Stats tiles up top, segmented number picker,
// two-column config card, live activity feed.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertCircle,
  Bot,
  Brain,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coins,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FlaskConical,
  Gauge,
  Loader2,
  Mic,
  MicOff,
  PauseCircle,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Thermometer,
  Trash2,
  TrendingUp,
  UserMinus,
  Wallet,
  Wand2,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { USD_TO_INR, formatInr } from "@/lib/exchange-rate";
import { emitFabClose, emitFabOpen, useFabsFlat } from "@/lib/fab-layout";
import {
  dockHideClasses,
  useFloatingDock,
} from "@/components/FloatingDockToggle";
import { FullscreenTextarea } from "@/components/FullscreenTextarea";
import { AiAssistButton } from "@/components/AiAssistButton";
import { PremiumHeader } from "@/components/PremiumHeader";
import { TriggerFlowsTab } from "@/components/automation/TriggerFlowsTab";
import { BlockedChatsCard } from "@/components/automation/BlockedChatsCard";

interface NumberRow {
  business_phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  provider: "meta" | "evolution";
  portfolio: { key: string; name: string; provider?: string } | null;
  config: Config | null;
}

type AutomationProvider = "openai" | "ollama";

interface FieldMapping {
  description: string;
  lsq_field: string;
}

export interface LeadDefault {
  lsq_field: string;
  value: string;
}

interface Config {
  id: string;
  business_phone_number_id: string;
  enabled: boolean;
  system_prompt: string;
  model: string;
  /** "openai" (default, paid API) or "ollama" (local server). The
   *  Provider toggle in the config card writes this. */
  provider: AutomationProvider;
  temperature: number;
  context_window: number;
  human_takeover_minutes: number;
  reply_delay_seconds: number;
  reply_word_limit: number;
  inbound_debounce_seconds: number;
  field_mappings: FieldMapping[];
  lead_defaults: LeadDefault[];
  activity_note_suffix: string;
  image_system_prompt: string | null;
  image_reply_delay_seconds: number;
  photo_lead_stage_target: string;
  photo_lead_stage_allowed_from: string[];
  image_response_triggers: ImageResponseTrigger[];
  transcription_prompt: string | null;
  use_rag: boolean;
  rag_top_k: number;
  rag_core_prompt: string | null;
  /** Operator-defined "never do this" rules. Injected as a strict-rules
   *  block at the end of the system prompt. */
  guardrails_text: string | null;
  /** Per-stage persona map { "<lsq stage>": "<persona text>" }. */
  stage_personas?: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

interface ImageResponseTrigger {
  patterns: string[];
  image_url: string;
  caption?: string;
  gate_by_stage?: boolean;
}

interface RagChunkRef {
  id: string;
  source: string;
  similarity: number;
  snippet: string;
}

interface LogRow {
  id: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  status: "success" | "skipped" | "failed" | "processing";
  skip_reason: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  cleaned_output: string | null;
  error_message: string | null;
  created_at: string;
  contact: { id: string; display: string; wa_id: string } | null;
  /** Knowledge chunks the model leaned on for this reply (when RAG was
   *  on). Lets the operator open a row and see WHICH facts steered the
   *  answer so they can tune the chunks that matter. */
  rag_chunks: RagChunkRef[] | null;
}

const DEFAULT_PROMPT = `You are a friendly support assistant at QHT Clinic, a hair restoration center based in Mumbai. Reply to customer queries in clear Hinglish.

- Always be polite and helpful.
- For cost questions, mention that exact pricing requires hair photos for graft estimation.
- Keep replies concise (under 200 words).
- Never mention you are an AI; speak naturally as a clinic representative.`;

interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

const OPENAI_MODELS: ModelOption[] = [
  { value: "gpt-4o-mini",  label: "GPT-4o mini",  hint: "Fast · cheap" },
  { value: "gpt-4o",       label: "GPT-4o",       hint: "Smartest" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini", hint: "Newer · balanced" },
  { value: "gpt-4.1",      label: "GPT-4.1",      hint: "Newer · powerful" },
];

// Default Ollama suggestions when the health endpoint can't reach the
// server (e.g. Ollama not running yet). Once we can reach it, we
// replace these with whatever models are actually pulled.
const DEFAULT_OLLAMA_MODELS: ModelOption[] = [
  { value: "qwen2.5:7b",   label: "Qwen 2.5 · 7B",  hint: "Best Hinglish · 5–8s" },
  { value: "llama3.1:8b",  label: "Llama 3.1 · 8B", hint: "Balanced · 5–8s" },
  { value: "gemma2:9b",    label: "Gemma 2 · 9B",   hint: "Quality · 8–12s" },
  { value: "llama3.2:3b",  label: "Llama 3.2 · 3B", hint: "Very fast · 2–4s" },
  { value: "mistral:7b",   label: "Mistral · 7B",   hint: "Light alternative" },
];

function labelOf(row: NumberRow): string {
  return (
    row.nickname?.trim() ||
    row.verified_name?.trim() ||
    row.display_phone_number ||
    row.business_phone_number_id
  );
}

function initialsOf(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("") || "?";
}

type AutomationTab = "intent" | "trigger" | "quality" | "interakt";

export function AutomationView() {
  const [rows, setRows] = useState<NumberRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const configCardRef = useRef<HTMLDivElement | null>(null);
  // Select a number AND scroll its persona/config into view, so clicking a
  // number from a long list visibly opens that number's page.
  function selectNumber(id: string) {
    setSelectedId(id);
    requestAnimationFrame(() =>
      configCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AutomationTab>("intent");
  // Agent trainer lives in a floating bottom-right panel now.
  const [trainerOpen, setTrainerOpen] = useState(false);
  // Full OpenAI usage payload (today / 7d / 30d + by-model). Drives the
  // "30d Cost" chip in the hero StatsStrip + the popover that opens
  // when the chip is clicked. One fetch, two consumers.
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  async function refreshConfigs() {
    try {
      const res = await fetch("/api/automation/config", { cache: "no-store" });
      const json = (await res.json()) as { rows?: NumberRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      setSelectedId((cur) => cur ?? json.rows?.[0]?.business_phone_number_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function refreshLogs(phoneNumberId: string | null) {
    try {
      const url = phoneNumberId
        ? `/api/automation/logs?limit=50&business_phone_number_id=${encodeURIComponent(phoneNumberId)}`
        : `/api/automation/logs?limit=50`;
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as { logs?: LogRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setLogs(json.logs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refreshConfigs();
  }, []);
  useEffect(() => {
    refreshLogs(selectedId);
    const id = setInterval(() => refreshLogs(selectedId), 15_000);
    return () => clearInterval(id);
  }, [selectedId]);

  // Fire the usage fetch alongside logs so the hero cost pill + the
  // detail popover (per-period + per-model) stay fresh.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const url = selectedId
          ? `/api/automation/usage?business_phone_number_id=${encodeURIComponent(selectedId)}`
          : `/api/automation/usage`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as UsageResponse;
        if (!cancelled) setUsage(j);
      } catch {
        /* leave previous value */
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  const selectedRow = useMemo(
    () => rows?.find((r) => r.business_phone_number_id === selectedId) ?? null,
    [rows, selectedId],
  );

  const stats = useMemo(() => computeStats(rows, logs), [rows, logs]);

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-secondary/40 via-secondary/20 to-background">
      {/* Header — sticky, full-bleed background, content centered to a
          generous max-w-[1600px] so the page uses the screen properly on
          large monitors instead of marooning content in a narrow column. */}
      <PremiumHeader
        icon={Sparkles}
        title="Automation"
        subtitle="AI auto-reply and trigger-based flows for inbound messages — configured per number."
        tone="emerald"
        right={<StatsStrip stats={stats} usage={usage} />}
        below={<AutomationTabs tab={tab} onChange={setTab} />}
      />

      {/* Body. Activity feed used to sit as a right rail here; it now
          lives in the global RecentActivityFab so the grid gets the
          full width back. Both tabs render a single scrolling column. */}
      {tab === "intent" ? (
        <div className="flex min-h-0 flex-1 mx-auto w-full max-w-[1600px]">
          {error ? (
            <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive shadow">
              {error}
            </div>
          ) : null}
          {rows === null ? (
            <div className="flex-1 overflow-y-auto px-6 py-6 lg:px-8">
              <SkeletonState />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex-1 overflow-y-auto px-6 py-6 lg:px-8">
              <EmptyNumbersState />
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-y-auto px-6 py-6 lg:px-8">
              <div className="space-y-6">
                <NumberPicker
                  rows={rows}
                  selectedId={selectedId}
                  onSelect={selectNumber}
                />
                {/* Persona / config for the picked number — directly under the
                    picker so clicking a number immediately opens its page. */}
                {selectedRow ? (
                  <div ref={configCardRef} className="scroll-mt-4">
                    <NumberConfigCard
                      key={selectedRow.business_phone_number_id}
                      row={selectedRow}
                      onSaved={refreshConfigs}
                    />
                  </div>
                ) : null}
                <BlockedChatsCard />
                <TestPatientsCard />
              </div>
            </div>
          )}
        </div>
      ) : tab === "quality" ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8">
          <div className="mx-auto max-w-[1600px]">
            {error ? (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <QualityReviewView
              rows={rows ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </div>
      ) : tab === "interakt" ? (
        <InteraktFlowsTab
          rows={rows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          error={error}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8">
          <div className="mx-auto max-w-[1600px] space-y-6">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            {rows && rows.length > 0 ? (
              <>
                <NumberPicker rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
                {selectedRow ? (
                  <TriggerFlowsTab
                    key={selectedRow.business_phone_number_id}
                    bpid={selectedRow.business_phone_number_id}
                  />
                ) : null}
              </>
            ) : (
              <EmptyNumbersState />
            )}
          </div>
        </div>
      )}

      <TrainerFloat
        selectedRow={selectedRow}
        open={trainerOpen}
        onOpenChange={setTrainerOpen}
      />
    </div>
  );
}

// ===========================================================================
// Tabs — AI Intent (smart auto-reply) + Trigger (rule-based flows, soon)
// ===========================================================================
function AutomationTabs({
  tab,
  onChange,
}: {
  tab: AutomationTab;
  onChange: (t: AutomationTab) => void;
}) {
  const items: {
    id: AutomationTab;
    label: string;
    sub: string;
    icon: typeof Brain;
  }[] = [
    { id: "intent",   label: "AI Intent", sub: "Smart auto-reply",     icon: Brain },
    { id: "trigger",  label: "Trigger",   sub: "Rule-based flows",      icon: Workflow },
    { id: "quality",  label: "Quality",   sub: "Daily review",          icon: Gauge },
    { id: "interakt", label: "Interakt",  sub: "Interakt number flows", icon: Send },
  ];
  return (
    <nav className="flex items-center gap-2">
      {items.map((it) => {
        const active = tab === it.id;
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={cn(
              "group inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition",
              active
                ? "bg-white text-emerald-800 shadow-lg shadow-emerald-900/25 ring-1 ring-white/40"
                : "bg-white/10 text-white/85 ring-1 ring-inset ring-white/20 backdrop-blur hover:bg-white/15 hover:text-white",
            )}
          >
            <Icon className={cn("h-4 w-4", active ? "text-emerald-700" : "text-white/80")} />
            <span className="flex flex-col items-start leading-tight">
              <span>{it.label}</span>
              <span
                className={cn(
                  "text-[10px] font-normal",
                  active ? "text-emerald-700/70" : "text-white/60",
                )}
              >
                {it.sub}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function TriggerComingSoon() {
  return (
    <div className="grid place-items-center rounded-xl border-2 border-dashed bg-card/50 px-6 py-20 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 text-amber-700">
          <Workflow className="h-6 w-6" />
        </div>
        <div className="text-sm font-semibold">Trigger flows — coming soon</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Build rule-based flows: when a customer sends a keyword like <span className="font-mono">&quot;price&quot;</span> or
          <span className="font-mono"> &quot;appointment&quot;</span>, fire a templated reply, hand off to a human, or run a
          custom action — without touching the AI.
        </div>
        <div className="mx-auto mt-5 grid max-w-sm grid-cols-3 gap-2 text-[10px]">
          <div className="rounded-lg border bg-background p-2">
            <div className="font-semibold text-foreground">Keyword</div>
            <div className="text-muted-foreground">match phrases</div>
          </div>
          <div className="rounded-lg border bg-background p-2">
            <div className="font-semibold text-foreground">Schedule</div>
            <div className="text-muted-foreground">time-of-day</div>
          </div>
          <div className="rounded-lg border bg-background p-2">
            <div className="font-semibold text-foreground">Webhook</div>
            <div className="text-muted-foreground">external events</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Interakt tab — same rule-based trigger flows as the Trigger tab, but the
// number picker is scoped to numbers on an Interakt-provider portfolio so
// Interakt automation is routed/managed on its own.
// ===========================================================================
function InteraktFlowsTab({
  rows,
  selectedId,
  onSelect,
  error,
}: {
  rows: NumberRow[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  error: string | null;
}) {
  const interaktRows = useMemo(
    () =>
      (rows ?? []).filter((r) => {
        const p = r.portfolio;
        if (!p) return false;
        // Primary signal is the portfolio provider; fall back to the
        // key/name in case PROVIDER isn't set in env for an Interakt
        // portfolio that's clearly named "interakt".
        return (
          p.provider === "interakt" ||
          p.key.toLowerCase() === "interakt" ||
          p.name.toLowerCase() === "interakt"
        );
      }),
    [rows],
  );
  // Keep the selection inside the Interakt set — if the globally-selected
  // number isn't an Interakt one, fall back to the first Interakt number.
  const effective =
    interaktRows.find((r) => r.business_phone_number_id === selectedId) ??
    interaktRows[0] ??
    null;
  useEffect(() => {
    if (effective && effective.business_phone_number_id !== selectedId) {
      onSelect(effective.business_phone_number_id);
    }
  }, [effective, selectedId, onSelect]);

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {rows === null ? (
          <SkeletonState />
        ) : interaktRows.length === 0 ? (
          <div className="grid place-items-center rounded-xl border-2 border-dashed bg-card/50 px-6 py-20 text-center">
            <div className="max-w-md">
              <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700">
                <Send className="h-6 w-6" />
              </div>
              <div className="text-sm font-semibold">No Interakt numbers</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Numbers on an Interakt-provider portfolio show up here. Assign a
                number to an Interakt portfolio to manage its trigger flows.
              </div>
            </div>
          </div>
        ) : (
          <>
            <NumberPicker
              rows={interaktRows}
              selectedId={effective?.business_phone_number_id ?? null}
              onSelect={onSelect}
            />
            {effective ? (
              <TriggerFlowsTab
                key={effective.business_phone_number_id}
                bpid={effective.business_phone_number_id}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Stats — derived from current logs (for selected number) + rows.
// ===========================================================================
interface Stats {
  active: number;
  total: number;
  runs: number;
  successRate: number | null;
  avgDurationMs: number | null;
}

function computeStats(rows: NumberRow[] | null, logs: LogRow[] | null): Stats {
  const total = rows?.length ?? 0;
  const active = rows?.filter((r) => r.config?.enabled).length ?? 0;

  if (!logs || logs.length === 0) {
    return { active, total, runs: 0, successRate: null, avgDurationMs: null };
  }
  const success = logs.filter((l) => l.status === "success");
  const failed = logs.filter((l) => l.status === "failed");
  const evaluated = success.length + failed.length;
  const successRate = evaluated === 0 ? null : Math.round((success.length / evaluated) * 100);
  const durations = success.map((l) => l.duration_ms).filter((d): d is number => typeof d === "number");
  const avgDurationMs = durations.length === 0
    ? null
    : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  return { active, total, runs: logs.length, successRate, avgDurationMs };
}

// Test-mode patient whitelist — operator pastes 1-2 of THEIR OWN
// phone numbers here. While the list is non-empty, the bot replies
// ONLY to messages from these patient numbers — real customers stay
// quiet across every connected WhatsApp number. Safe live testing.
function TestPatientsCard() {
  const [waIds, setWaIds] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/automation/test-contacts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { wa_ids?: string[] }) => {
        if (!cancelled) setWaIds(Array.isArray(j.wa_ids) ? j.wa_ids : []);
      })
      .catch(() => {
        if (!cancelled) setWaIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: string[]) {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/automation/test-contacts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wa_ids: next }),
      });
      const j = (await res.json()) as { wa_ids?: string[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setWaIds(j.wa_ids ?? next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function addFromDraft() {
    const raw = draft.replace(/\D/g, "");
    if (raw.length < 6) {
      setErr("Enter a phone number with country code (e.g. 919XXXXXXXXX).");
      return;
    }
    if ((waIds ?? []).includes(raw)) {
      setDraft("");
      return;
    }
    setErr(null);
    void save([...(waIds ?? []), raw]);
    setDraft("");
  }
  function removeOne(wa: string) {
    void save((waIds ?? []).filter((x) => x !== wa));
  }

  if (waIds === null) return null;
  const active = waIds.length > 0;

  return (
    <div
      className={cn(
        "rounded-2xl border shadow-sm transition",
        active
          ? "border-amber-300 bg-gradient-to-br from-amber-50 to-amber-50/30"
          : "border-emerald-200 bg-gradient-to-br from-emerald-50/60 to-emerald-50/20",
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className={cn(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
            active
              ? "bg-amber-100 text-amber-700 ring-amber-200"
              : "bg-emerald-100 text-emerald-700 ring-emerald-200",
          )}
        >
          <FlaskConical className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold leading-tight">
              {active ? "Test mode — bot replies only to these patients" : "Live testing — patient numbers"}
            </h3>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
                active
                  ? "bg-amber-100 text-amber-800 ring-amber-200"
                  : "bg-emerald-100 text-emerald-800 ring-emerald-200",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  active ? "bg-amber-500" : "bg-emerald-500",
                )}
              />
              {active ? `${waIds.length} patient${waIds.length === 1 ? "" : "s"}` : "Production · everyone"}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Apna phone aur 1-2 testers ke numbers add karo — bot SIRF inhi
            patients ke messages ka reply karega, real customers ko nahi.
            Empty rakhne par bot sabhi par chalu ho jayega (production).
          </p>

          {waIds.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {waIds.map((wa) => (
                <span
                  key={wa}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-amber-900 shadow-sm ring-1 ring-inset ring-amber-200"
                >
                  <span className="font-mono">+{wa}</span>
                  <button
                    type="button"
                    onClick={() => removeOne(wa)}
                    disabled={saving}
                    aria-label="Remove"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                  >
                    <XCircle className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addFromDraft();
                }
              }}
              disabled={saving}
              placeholder="91XXXXXXXXXX (with country code)"
              className="h-9 flex-1 min-w-[200px] rounded-md border bg-background px-3 font-mono text-[12.5px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200"
            />
            <button
              type="button"
              onClick={addFromDraft}
              disabled={saving || !draft.trim()}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold text-white shadow-sm transition disabled:opacity-50",
                active ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700",
              )}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add patient
            </button>
            {active ? (
              <button
                type="button"
                onClick={() => void save([])}
                disabled={saving}
                className="inline-flex h-9 items-center gap-1 rounded-md border bg-white px-3 text-[12px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
              >
                Clear · go live
              </button>
            ) : null}
          </div>
          {err ? (
            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {err}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Compact horizontal stats — rendered in the emerald hero so the
// 4 KPIs sit alongside the title instead of eating a full row below.
interface UsagePeriod {
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}
interface UsageByModel {
  model: string;
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  priced: boolean;
}
interface UsageResponse {
  today?: UsagePeriod;
  last_7_days?: UsagePeriod;
  last_30_days?: UsagePeriod;
  by_model?: UsageByModel[];
  note?: string;
  error?: string;
}

function StatsStrip({
  stats,
  usage,
}: {
  stats: Stats;
  usage: UsageResponse | null;
}) {
  const cost30d = usage?.last_30_days?.cost_usd ?? null;
  const [usageOpen, setUsageOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <HeroStatTile icon={Zap} label="Active" value={`${stats.active}/${stats.total}`} />
      <HeroStatTile icon={Activity} label="Recent" value={String(stats.runs)} />
      <HeroStatTile
        icon={Gauge}
        label="Success"
        value={stats.successRate === null ? "—" : `${stats.successRate}%`}
      />
      <HeroStatTile
        icon={Clock}
        label="Avg"
        value={
          stats.avgDurationMs === null
            ? "—"
            : `${(stats.avgDurationMs / 1000).toFixed(1)}s`
        }
      />

      {/* Cost tile is clickable — opens the full usage breakdown. We
          portal the popover to document.body and position it from the
          trigger's bounding rect because PremiumHeader uses
          overflow-hidden for its glow orbs, which otherwise clips any
          dropdown extending past the band. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setUsageOpen((v) => !v)}
        className={cn(
          "flex min-w-[100px] items-center gap-2.5 rounded-xl px-3 py-2 text-left ring-1 ring-inset backdrop-blur-sm transition",
          usageOpen
            ? "bg-white text-emerald-800 ring-white shadow-lg shadow-emerald-900/25"
            : "bg-white/10 text-white ring-white/15 hover:bg-white/15",
        )}
        aria-expanded={usageOpen}
        title="OpenAI usage — click for breakdown"
      >
        <span
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
            usageOpen
              ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
              : "bg-white/15 text-white/85 ring-white/10",
          )}
        >
          <Wallet className="h-3.5 w-3.5" />
        </span>
        <div className="leading-tight">
          <div
            className={cn(
              "text-[16px] font-extrabold tabular-nums",
              usageOpen ? "text-emerald-800" : "text-white",
            )}
          >
            {cost30d === null
              ? "—"
              : cost30d === 0
                ? "₹0"
                : formatInr(cost30d)}
          </div>
          <div
            className={cn(
              "text-[9.5px] font-semibold uppercase tracking-[0.08em]",
              usageOpen ? "text-emerald-700/70" : "text-white/65",
            )}
          >
            30d Cost
          </div>
        </div>
      </button>

      {usageOpen ? (
        <UsagePopover
          anchorRef={triggerRef}
          usage={usage}
          onClose={() => setUsageOpen(false)}
        />
      ) : null}
    </div>
  );
}

function HeroStatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-[88px] items-center gap-2.5 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white/85 ring-1 ring-inset ring-white/10">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="leading-tight">
        <div className="text-[16px] font-extrabold tabular-nums text-white">
          {value}
        </div>
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-white/65">
          {label}
        </div>
      </div>
    </div>
  );
}

// Compact, popover version of the old standalone OpenAI usage panel.
// Portal-rendered (PremiumHeader uses overflow-hidden for its glow orbs
// and would otherwise clip this) and positioned right-aligned to the
// trigger chip via its bounding rect. Period toggle (Today / 7d / 30d)
// + 4 tiles + per-model breakdown.
function UsagePopover({
  anchorRef,
  usage,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  usage: UsageResponse | null;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<"today" | "last_7_days" | "last_30_days">(
    "last_30_days",
  );
  const current =
    usage?.[period] ?? { runs: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

  // Compute right-aligned position from the trigger. Recomputed on
  // window resize / scroll so the popover follows the chip if the user
  // resizes while it's open.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    function update() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  if (typeof document === "undefined" || !pos) return null;

  return createPortal(
    <>
      {/* Click-outside scrim — sits below the popover but above
          everything else so any other click closes it. */}
      <button
        type="button"
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-[70] cursor-default"
      />
      <div
        className="fixed z-[71] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-2xl border bg-card text-foreground shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95"
        style={{ top: pos.top, right: pos.right }}
      >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-br from-emerald-50 via-card to-card px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200">
            <Wallet className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">OpenAI usage</h3>
            <p className="text-[11px] text-muted-foreground">
              Estimated spend on AI replies
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <UsagePeriodToggle period={period} onChange={setPeriod} />
          <a
            href="https://platform.openai.com/usage"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Dashboard
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
        <UsageTile
          icon={Coins}
          label="Estimated cost"
          primary={`$${current.cost_usd.toFixed(current.cost_usd < 1 ? 4 : 2)}`}
          secondary={
            current.cost_usd > 0 ? `≈ ${formatInr(current.cost_usd)}` : "—"
          }
          tone="amber"
        />
        <UsageTile
          icon={CheckCircle2}
          label="Replies"
          primary={String(current.runs)}
          secondary={
            current.runs > 0
              ? `$${(current.cost_usd / current.runs).toFixed(4)} per reply`
              : "No replies yet"
          }
          tone="emerald"
        />
        <UsageTile
          icon={TrendingUp}
          label="Input tokens"
          primary={formatTokens(current.prompt_tokens)}
          secondary="Customer + prompt"
          tone="slate"
        />
        <UsageTile
          icon={Sparkles}
          label="Output tokens"
          primary={formatTokens(current.completion_tokens)}
          secondary="AI replies"
          tone="slate"
        />
      </div>

      {usage?.by_model && usage.by_model.length > 0 ? (
        <div className="border-t px-4 py-3">
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            By model (last 30 days)
          </h4>
          <ul className="space-y-1.5">
            {usage.by_model.map((m) => (
              <li
                key={m.model}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="truncate font-mono text-foreground/90">
                  {m.model}
                  {!m.priced ? (
                    <span className="ml-1.5 rounded bg-amber-50 px-1 py-0.5 text-[9px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                      unpriced
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                  <span>
                    {m.runs} {m.runs === 1 ? "run" : "runs"}
                  </span>
                  <span>
                    {formatTokens(m.prompt_tokens + m.completion_tokens)} tok
                  </span>
                  <span className="font-semibold text-foreground">
                    ${m.cost_usd.toFixed(m.cost_usd < 1 ? 4 : 2)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="border-t bg-secondary/30 px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">
        ⓘ Estimated from logs (OpenAI doesn&apos;t expose remaining-balance).
        INR shown at ~₹{USD_TO_INR}/$1.
      </footer>
      </div>
    </>,
    document.body,
  );
}

function UsagePeriodToggle({
  period,
  onChange,
}: {
  period: "today" | "last_7_days" | "last_30_days";
  onChange: (p: "today" | "last_7_days" | "last_30_days") => void;
}) {
  const opts: Array<{ id: typeof period; label: string }> = [
    { id: "today", label: "Today" },
    { id: "last_7_days", label: "7d" },
    { id: "last_30_days", label: "30d" },
  ];
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-semibold transition",
            period === o.id
              ? "bg-emerald-600 text-white"
              : "text-muted-foreground hover:bg-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UsageTile({
  icon: Icon,
  label,
  primary,
  secondary,
  tone,
}: {
  icon: typeof Coins;
  label: string;
  primary: string;
  secondary: string;
  tone: "amber" | "emerald" | "slate";
}) {
  const tones: Record<typeof tone, string> = {
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    slate: "bg-slate-50 text-slate-700 ring-slate-200",
  };
  return (
    <div className="bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset",
            tones[tone],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="mt-2 text-lg font-bold tabular-nums">{primary}</div>
      <div className="mt-0.5 text-[11px] font-medium text-foreground/80">
        {label}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{secondary}</div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Floating agent-trainer launcher — sits alongside the other FABs in
// the bottom-right dock cluster (notifications bell, AI assistant, new
// chat, recent activity). Click to expand into a right-side drawer
// hosting <ChatTrainer>. Click outside / X / Esc to close.
function TrainerFloat({
  selectedRow,
  open,
  onOpenChange,
}: {
  selectedRow: NumberRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Hydration-safe mount gate. createPortal renders into document.body
  // which doesn't exist on the server. Returning a portal directly on
  // the very first client render after SSR (where we rendered null)
  // tripped Next.js's hydration check. Mount-once flag keeps both
  // sides null until React is fully hydrated.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const flat = useFabsFlat();
  const { collapsed: dockCollapsed, mounted: dockMounted } = useFloatingDock();

  // Signal the shared layout that we're open so sibling FABs flatten
  // out of the way of the drawer. Cleanup on unmount keeps the state
  // from getting wedged "open".
  useEffect(() => {
    if (open) emitFabOpen("agent-trainer");
    else emitFabClose("agent-trainer");
    return () => emitFabClose("agent-trainer");
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <>
      {/* Drawer — slides in from the right when open. */}
      {open ? (
        <>
          <div
            aria-hidden
            onClick={() => onOpenChange(false)}
            className="fixed inset-0 z-[68] bg-slate-900/30 backdrop-blur-[1px]"
          />
          <div className="fixed bottom-5 right-5 top-20 z-[70] flex w-[min(460px,calc(100vw-40px))] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl ring-1 ring-emerald-100/60">
            <header className="flex items-center justify-between gap-2 border-b bg-gradient-to-br from-emerald-50 via-card to-card px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
                  <Brain className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold leading-tight">
                    Agent trainer
                  </h2>
                  <p className="text-[10.5px] text-muted-foreground">
                    {selectedRow
                      ? `Testing on ${labelOf(selectedRow)}`
                      : "Pick a number in AI Intent to test"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close trainer"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {selectedRow ? (
                <ChatTrainer
                  key={selectedRow.business_phone_number_id}
                  phoneNumberId={selectedRow.business_phone_number_id}
                  numberLabel={
                    selectedRow.verified_name?.trim() ||
                    selectedRow.display_phone_number ||
                    selectedRow.business_phone_number_id
                  }
                  numberSubLabel={selectedRow.display_phone_number}
                  dirty={false}
                />
              ) : (
                <div className="grid h-full place-items-center text-center text-[12.5px] text-muted-foreground">
                  Pick a number from the AI Intent tab to start training.
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {/* Floating launcher — sits between NewChatFab (bottom-[11rem])
          and RecentActivityFab (bottom-[22rem]) in the idle stack;
          flattens into the bottom row alongside its siblings when any
          FAB's popover is open. Hidden when the dock toggle collapses
          the cluster. */}
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={open ? "Close agent trainer" : "Open agent trainer"}
        className={cn(
          "group fixed z-[55] hidden md:inline-flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-xl shadow-emerald-900/30 ring-2 ring-white/70 transition-all duration-300 ease-out hover:scale-110 hover:shadow-2xl hover:shadow-emerald-900/40",
          flat
            ? "bottom-5 right-[17.5rem]"
            : "bottom-[16.5rem] right-5",
          dockHideClasses(dockCollapsed, dockMounted),
        )}
        title="Agent trainer"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-emerald-400/30 blur-md transition group-hover:bg-emerald-300/40"
        />
        <Brain className="relative h-6 w-6" />
      </button>
    </>,
    document.body,
  );
}

function StatsGrid({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile
        icon={Zap}
        label="Active"
        value={`${stats.active}/${stats.total}`}
        hint={stats.active === stats.total ? "All numbers live" : "Some numbers off"}
        tone={stats.active > 0 ? "emerald" : "muted"}
      />
      <StatTile
        icon={Activity}
        label="Recent runs"
        value={String(stats.runs)}
        hint="Last 50"
        tone="slate"
      />
      <StatTile
        icon={Gauge}
        label="Success rate"
        value={stats.successRate === null ? "—" : `${stats.successRate}%`}
        hint={stats.successRate === null ? "No runs yet" : "Excludes skipped"}
        tone={stats.successRate === null ? "muted" : stats.successRate >= 90 ? "emerald" : "amber"}
      />
      <StatTile
        icon={Clock}
        label="Avg latency"
        value={stats.avgDurationMs === null ? "—" : `${(stats.avgDurationMs / 1000).toFixed(1)}s`}
        hint="OpenAI response time"
        tone="slate"
      />
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  hint: string;
  tone: "emerald" | "amber" | "slate" | "muted";
}) {
  const toneClasses = {
    emerald: "from-emerald-50 to-emerald-50/30 ring-emerald-100",
    amber: "from-amber-50 to-amber-50/30 ring-amber-100",
    slate: "from-slate-50 to-white ring-border",
    muted: "from-secondary to-secondary/30 ring-border",
  }[tone];
  const iconTone = {
    emerald: "bg-emerald-500/10 text-emerald-600",
    amber: "bg-amber-500/10 text-amber-600",
    slate: "bg-slate-500/10 text-slate-600",
    muted: "bg-muted-foreground/10 text-muted-foreground",
  }[tone];
  return (
    <div className={cn("rounded-xl bg-gradient-to-br p-4 shadow-sm ring-1", toneClasses)}>
      <div className="flex items-center justify-between">
        <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg", iconTone)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-medium text-foreground/70">{label}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}
// ===========================================================================
// Number picker — grouped by portfolio; Evolution (Baileys) numbers
// collapse into their own group regardless of portfolio. Operator picks
// the number whose automation config they want to edit.
// ===========================================================================
function NumberPicker({
  rows,
  selectedId,
  onSelect,
}: {
  rows: NumberRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; name: string; isEvolution: boolean; rows: NumberRow[] }
    >();
    for (const r of rows) {
      const isEvolution = r.provider === "evolution";
      const key = isEvolution
        ? "__evolution__"
        : r.portfolio?.key ?? "__unassigned__";
      const name = isEvolution
        ? "Evolution (Baileys)"
        : r.portfolio?.name ?? "Unassigned";
      if (!map.has(key)) map.set(key, { key, name, isEvolution, rows: [] });
      map.get(key)!.rows.push(r);
    }
    return Array.from(map.values()).sort((a, b) => {
      // Evolution last; otherwise alphabetical by portfolio name.
      if (a.key === "__evolution__") return 1;
      if (b.key === "__evolution__") return -1;
      return a.name.localeCompare(b.name);
    });
  }, [rows]);

  // The group containing the selected number is the natural "open" one.
  // Single-open accordion: click a different header → that opens, prior
  // closes. Click the open one → it collapses.
  const selectedGroupKey = useMemo(() => {
    for (const g of groups) {
      if (g.rows.some((r) => r.business_phone_number_id === selectedId))
        return g.key;
    }
    return groups[0]?.key ?? null;
  }, [groups, selectedId]);
  const [openKey, setOpenKey] = useState<string | null>(selectedGroupKey);
  useEffect(() => {
    setOpenKey(selectedGroupKey);
  }, [selectedGroupKey]);

  const openGroup = groups.find((g) => g.key === openKey) ?? null;

  return (
    <div className="space-y-3">
      {/* Group selector — tile strip. Each group is a card with icon +
          name + on/total. Click one to expand its numbers below. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {groups.map((g) => {
          const total = g.rows.length;
          const on = g.rows.filter((r) => r.config?.enabled).length;
          const active = openKey === g.key;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => {
                const nextOpen = active ? null : g.key;
                setOpenKey(nextOpen);
                // Expanding a portfolio also selects its first number, so the
                // persona/config below switches to that portfolio immediately
                // (otherwise it keeps showing the previously-selected number).
                if (nextOpen && !g.rows.some((r) => r.business_phone_number_id === selectedId)) {
                  onSelect(g.rows[0].business_phone_number_id);
                }
              }}
              aria-expanded={active}
              className={cn(
                "group relative flex items-center gap-2.5 rounded-xl border p-3 text-left transition",
                active
                  ? "border-emerald-400 bg-gradient-to-br from-emerald-50 via-white to-white shadow-md shadow-emerald-100"
                  : "border-input bg-card hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-emerald-50/30 hover:shadow-md",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition",
                  g.isEvolution
                    ? active
                      ? "bg-violet-100 text-violet-700 ring-violet-200"
                      : "bg-violet-50 text-violet-600 ring-violet-100"
                    : active
                      ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
                      : "bg-secondary text-muted-foreground ring-border group-hover:ring-emerald-200",
                )}
              >
                {g.isEvolution ? (
                  <Radio className="h-4 w-4" />
                ) : (
                  <Building2 className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-semibold uppercase tracking-wide">
                  {g.name}
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground tabular-nums">
                  <span
                    className={cn(
                      "font-bold",
                      on > 0 ? "text-emerald-700" : "text-muted-foreground",
                    )}
                  >
                    {on}
                  </span>
                  <span className="text-muted-foreground/60">/{total} on</span>
                </div>
              </div>
              {active ? (
                <span className="absolute right-2 top-2 inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Expanded group — the picked group's number tiles below. */}
      {openGroup ? (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <header className="flex items-center gap-2 border-b bg-gradient-to-b from-secondary/40 to-card px-4 py-2.5">
            {openGroup.isEvolution ? (
              <Radio className="h-3.5 w-3.5 text-violet-500" />
            ) : (
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {openGroup.name}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              · {openGroup.rows.filter((r) => r.config?.enabled).length}/
              {openGroup.rows.length} on
            </span>
          </header>
          <div className="grid grid-cols-2 gap-2 bg-secondary/30 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {openGroup.rows.map((r) => (
              <NumberChip
                key={r.business_phone_number_id}
                row={r}
                selected={r.business_phone_number_id === selectedId}
                onClick={() => onSelect(r.business_phone_number_id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumberChip({
  row,
  selected,
  onClick,
}: {
  row: NumberRow;
  selected: boolean;
  onClick: () => void;
}) {
  const isOn = !!row.config?.enabled;
  const label = labelOf(row);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex min-w-0 items-center gap-2.5 rounded-xl border p-2.5 text-left transition",
        selected
          ? "border-emerald-400 bg-gradient-to-br from-emerald-50 via-white to-white shadow-sm shadow-emerald-100"
          : "border-input bg-card hover:-translate-y-px hover:border-emerald-200 hover:bg-emerald-50/30 hover:shadow-sm",
      )}
    >
      {/* Active indicator — small dot at top-right of the tile. */}
      <span
        aria-label={isOn ? "Active" : "Off"}
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-1.5 w-1.5 rounded-full",
          isOn
            ? "bg-emerald-500 shadow-[0_0_0_2.5px_rgba(16,185,129,0.18)]"
            : "bg-muted-foreground/30",
        )}
      />
      <span
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ring-1 ring-inset transition",
          selected
            ? "bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800 ring-emerald-300"
            : "bg-secondary text-muted-foreground ring-border group-hover:ring-emerald-200",
        )}
      >
        {initialsOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold leading-tight">
          {label}
        </span>
        {row.display_phone_number && row.display_phone_number !== label ? (
          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted-foreground">
            {row.display_phone_number}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        on
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : "bg-secondary text-muted-foreground ring-border",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/40")} />
      {on ? "Active" : "Off"}
    </span>
  );
}

// Copy-to-another-number menu — clones this number's whole AI Intent
// setup (persona, model, image flow, field mappings, lead defaults, RAG
// chunks) onto another number. Target lands with auto-reply OFF.
interface CopyTargetOpt {
  phone_number_id: string;
  label: string;
  number: string;
  portfolio: string;
}

function CopyConfigMenu({ sourceBpid }: { sourceBpid: string }) {
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<CopyTargetOpt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (j: {
          numbers?: Array<{
            phone_number_id: string;
            provider?: string;
            verified_name?: string;
            nickname?: string;
            display_phone_number?: string;
            portfolio?: { name?: string } | null;
          }>;
        }) => {
          setNumbers(
            (j.numbers ?? [])
              .map((n) => ({
                phone_number_id: n.phone_number_id,
                label: n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id,
                number: n.display_phone_number || n.phone_number_id,
                portfolio: n.portfolio?.name || "Other",
              })),
          );
        },
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function copyTo(targetBpid: string) {
    setBusy(targetBpid);
    setErr(null);
    try {
      const res = await fetch("/api/automation/config/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_business_phone_number_id: sourceBpid,
          target_business_phone_number_id: targetBpid,
        }),
      });
      const j = (await res.json()) as { error?: string; chunks_copied?: number };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDone(targetBpid);
      setTimeout(() => setDone(null), 3500);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setBusy(null);
    }
  }

  const q = query.trim().toLowerCase();
  const others = numbers
    .filter((n) => n.phone_number_id !== sourceBpid)
    .filter(
      (n) =>
        !q ||
        n.label.toLowerCase().includes(q) ||
        n.number.toLowerCase().includes(q) ||
        n.phone_number_id.includes(q) ||
        n.portfolio.toLowerCase().includes(q),
    );
  const groups = new Map<string, CopyTargetOpt[]>();
  for (const n of others) {
    (groups.get(n.portfolio) ?? groups.set(n.portfolio, []).get(n.portfolio)!).push(n);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Copy this number's full AI setup to another number"
        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground shadow-sm transition hover:bg-secondary"
      >
        <Copy className="h-3.5 w-3.5 text-emerald-700" />
        Copy to number
      </button>
      {done ? (
        <span className="ml-2 text-[11px] font-medium text-emerald-600">
          Copied to {numbers.find((n) => n.phone_number_id === done)?.label ?? "number"} (auto-reply off there)
        </span>
      ) : null}
      {err ? <span className="ml-2 text-[11px] text-destructive">{err}</span> : null}
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-64 overflow-hidden rounded-lg border bg-white py-1 shadow-xl">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Copy AI setup to another number
          </div>
          <div className="px-2 pb-1.5">
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or number…"
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {others.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {q ? "No match." : "No other numbers."}
              </div>
            ) : (
              [...groups.entries()].map(([portfolio, opts]) => (
                <div key={portfolio}>
                  <div className="bg-secondary/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {portfolio}
                  </div>
                  {opts.map((n) => (
                    <button
                      key={n.phone_number_id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => copyTo(n.phone_number_id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                    >
                      {busy === n.phone_number_id ? (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                      ) : (
                        <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{n.label}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {n.number}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
            Target par auto-reply OFF rahega — review karke ON karna.
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// Per-number config — two-column layout with Switch + Reset.
// ===========================================================================
function NumberConfigCard({
  row,
  onSaved,
}: {
  row: NumberRow;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(row.config?.enabled ?? false);
  const [systemPrompt, setSystemPrompt] = useState(row.config?.system_prompt ?? DEFAULT_PROMPT);
  const [provider, setProvider] = useState<AutomationProvider>(row.config?.provider ?? "openai");
  const [model, setModel] = useState(row.config?.model ?? "gpt-4o-mini");
  const [temperature, setTemperature] = useState(Number(row.config?.temperature ?? 0.4));
  const [contextWindow, setContextWindow] = useState(row.config?.context_window ?? 50);
  const [takeover, setTakeover] = useState(row.config?.human_takeover_minutes ?? 2);
  const [replyDelay, setReplyDelay] = useState(row.config?.reply_delay_seconds ?? 0);
  const [replyWordLimit, setReplyWordLimit] = useState(row.config?.reply_word_limit ?? 15);
  const [inboundDebounce, setInboundDebounce] = useState(
    row.config?.inbound_debounce_seconds ?? 10,
  );
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>(
    row.config?.field_mappings ?? [],
  );
  const [leadDefaults, setLeadDefaults] = useState<LeadDefault[]>(
    row.config?.lead_defaults ?? [],
  );
  const [imageSystemPrompt, setImageSystemPrompt] = useState(
    row.config?.image_system_prompt ?? "",
  );
  const [imageReplyDelay, setImageReplyDelay] = useState(
    row.config?.image_reply_delay_seconds ?? 30,
  );
  const [photoStageTarget, setPhotoStageTarget] = useState(
    row.config?.photo_lead_stage_target ?? "Photos Received",
  );
  const [photoStageAllowedFrom, setPhotoStageAllowedFrom] = useState<string[]>(
    row.config?.photo_lead_stage_allowed_from ?? [
      "Prospect",
      "Engaged",
      "Pending First Contact",
      "Photo Awaited",
    ],
  );
  const [imageTriggers, setImageTriggers] = useState<ImageResponseTrigger[]>(
    row.config?.image_response_triggers ?? [],
  );
  const [transcriptionPrompt, setTranscriptionPrompt] = useState(
    row.config?.transcription_prompt ?? "",
  );
  const [useRag, setUseRag] = useState(row.config?.use_rag ?? false);
  const [ragTopK, setRagTopK] = useState(row.config?.rag_top_k ?? 5);
  const [ragCorePrompt, setRagCorePrompt] = useState(
    row.config?.rag_core_prompt ?? "",
  );
  const [guardrails, setGuardrails] = useState(
    row.config?.guardrails_text ?? "",
  );
  // Stage-based personas — { "<lsq stage>": "<persona text>" }.
  const [stagePersonas, setStagePersonas] = useState<Record<string, string>>(
    row.config?.stage_personas ?? {},
  );
  const [lsqStages, setLsqStages] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/lsq/stages", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { stages?: string[] }) => {
        if (Array.isArray(j.stages)) setLsqStages(j.stages);
      })
      .catch(() => {});
  }, []);
  // Fullscreen modal flags for the two long prompts. Local state only —
  // closing the modal flushes nothing extra; the textarea's onChange
  // already keeps the parent state in sync.
  const [personaFs, setPersonaFs] = useState(false);
  const [imagePromptFs, setImagePromptFs] = useState(false);
  // "Install full system message" modal — paste one big prompt, AI
  // splits it into Persona / Image / RAG fields.
  const [installOpen, setInstallOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Live Ollama health — polled when provider=ollama so the model
  // dropdown reflects what's actually pulled on the operator's machine.
  const ollama = useOllamaHealth(provider === "ollama");

  const dirty = useMemo(() => {
    const c = row.config;
    if (!c) return true;
    return (
      c.enabled !== enabled ||
      c.system_prompt !== systemPrompt ||
      (c.provider ?? "openai") !== provider ||
      c.model !== model ||
      Number(c.temperature) !== temperature ||
      c.context_window !== contextWindow ||
      c.human_takeover_minutes !== takeover ||
      (c.reply_delay_seconds ?? 0) !== replyDelay ||
      (c.reply_word_limit ?? 15) !== replyWordLimit ||
      (c.inbound_debounce_seconds ?? 10) !== inboundDebounce ||
      JSON.stringify(c.field_mappings ?? []) !== JSON.stringify(fieldMappings) ||
      JSON.stringify(c.lead_defaults ?? []) !== JSON.stringify(leadDefaults) ||
      (c.image_system_prompt ?? "") !== imageSystemPrompt ||
      (c.image_reply_delay_seconds ?? 30) !== imageReplyDelay ||
      (c.photo_lead_stage_target ?? "Photos Received") !== photoStageTarget ||
      JSON.stringify(c.photo_lead_stage_allowed_from ?? []) !==
        JSON.stringify(photoStageAllowedFrom) ||
      JSON.stringify(c.image_response_triggers ?? []) !==
        JSON.stringify(imageTriggers) ||
      (c.transcription_prompt ?? "") !== transcriptionPrompt ||
      (c.use_rag ?? false) !== useRag ||
      (c.rag_top_k ?? 5) !== ragTopK ||
      (c.rag_core_prompt ?? "") !== ragCorePrompt ||
      (c.guardrails_text ?? "") !== guardrails ||
      JSON.stringify(c.stage_personas ?? {}) !== JSON.stringify(stagePersonas)
    );
  }, [
    row.config,
    enabled,
    systemPrompt,
    provider,
    model,
    temperature,
    contextWindow,
    takeover,
    replyDelay,
    inboundDebounce,
    fieldMappings,
    leadDefaults,
    imageSystemPrompt,
    imageReplyDelay,
    photoStageTarget,
    photoStageAllowedFrom,
    imageTriggers,
    transcriptionPrompt,
    useRag,
    ragTopK,
    ragCorePrompt,
    guardrails,
    stagePersonas,
  ]);

  // When the user flips provider, snap to a sensible default model for
  // that provider unless they've already typed a custom one. Avoids
  // saving an invalid combination like provider=ollama + model=gpt-4o.
  function handleProviderChange(next: AutomationProvider) {
    setProvider(next);
    if (next === "openai" && !OPENAI_MODELS.some((m) => m.value === model)) {
      setModel("gpt-4o-mini");
    } else if (next === "ollama" && OPENAI_MODELS.some((m) => m.value === model)) {
      setModel(ollama.models[0] ?? DEFAULT_OLLAMA_MODELS[0].value);
    }
  }

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/automation/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: row.business_phone_number_id,
          enabled,
          system_prompt: systemPrompt,
          provider,
          model,
          temperature,
          context_window: contextWindow,
          human_takeover_minutes: takeover,
          reply_delay_seconds: replyDelay,
          reply_word_limit: replyWordLimit,
          inbound_debounce_seconds: inboundDebounce,
          field_mappings: fieldMappings,
          image_system_prompt: imageSystemPrompt,
          image_reply_delay_seconds: imageReplyDelay,
          photo_lead_stage_target: photoStageTarget,
          photo_lead_stage_allowed_from: photoStageAllowedFrom,
          image_response_triggers: imageTriggers,
          transcription_prompt: transcriptionPrompt,
          use_rag: useRag,
          rag_top_k: ragTopK,
          rag_core_prompt: ragCorePrompt,
          guardrails_text: guardrails,
          stage_personas: stagePersonas,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedAt(Date.now());
      onSaved();
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const label = labelOf(row);

  return (
    <section className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-b from-card to-secondary/20 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-sm font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            {initialsOf(label)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold leading-tight">{label}</div>
            {row.display_phone_number && row.display_phone_number !== label ? (
              <div className="truncate text-xs text-muted-foreground">{row.display_phone_number}</div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <CopyConfigMenu sourceBpid={row.business_phone_number_id} />
          <span className="text-xs text-muted-foreground">{enabled ? "Auto-reply on" : "Auto-reply off"}</span>
          <Switch checked={enabled} onChange={setEnabled} />
          {/* Inline save shortcut — same handler as the sticky save
              bar at the bottom, just easier to reach when the operator
              edits the persona at the top of a long page. */}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            title={dirty ? "Save changes" : "Nothing to save"}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      </header>

      {/* Persona left, behavior controls right. minmax(0, 1fr) lets the
          textarea shrink instead of pushing the right rail off-screen
          when the outer layout's main lane is narrower (e.g. on xl
          screens where the outer 2-col split takes effect). The right
          rail is wider than the gut tells you (300px) so the Context /
          Takeover number inputs don't squeeze each other on the
          shared row. */}
      <div className="grid gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* ── Left: Persona / system prompt ────────────────────────────── */}
        <div className="flex min-w-0 flex-col">
          <div className="mb-2 flex items-center justify-between gap-2">
            <FieldLabel icon={Bot}>Persona</FieldLabel>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setInstallOpen(true)}
                title="Paste a full bot system message — AI splits it into Persona, Image and RAG fields."
                className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100"
              >
                <Wand2 className="h-3 w-3" />
                Install full prompt
              </button>
              <AiAssistButton
                kind="persona"
                value={systemPrompt}
                onApply={setSystemPrompt}
              />
              <button
                type="button"
                onClick={() => setSystemPrompt(DEFAULT_PROMPT)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>
          </div>
          <FullscreenTextarea
            value={systemPrompt}
            onChange={setSystemPrompt}
            rows={26}
            placeholder="You are a helpful assistant for…"
            title="Persona — Main system prompt"
            open={personaFs}
            onOpenChange={setPersonaFs}
            className="min-h-[560px] w-full resize-y rounded-lg border bg-background px-3.5 py-3 pr-12 font-mono text-[13px] leading-relaxed outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
            footer={
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>How the AI should behave on every reply for this number.</span>
                <span className="tabular-nums">{systemPrompt.length} chars</span>
              </div>
            }
          />
        </div>

        {/* ── Right: Behavior controls ─────────────────────────────────── */}
        <div className="space-y-4 lg:border-l lg:pl-5">
          <div>
            <FieldLabel icon={Cpu}>Provider</FieldLabel>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <ProviderToggle
                active={provider === "openai"}
                label="OpenAI"
                hint="Cloud · paid"
                onClick={() => handleProviderChange("openai")}
              />
              <ProviderToggle
                active={provider === "ollama"}
                label="Ollama"
                hint="Local · free"
                onClick={() => handleProviderChange("ollama")}
              />
            </div>
            {provider === "ollama" ? (
              <OllamaStatusLine health={ollama} />
            ) : null}
          </div>

          <div>
            <FieldLabel icon={Cpu}>Model</FieldLabel>
            <div className="mt-1.5 grid gap-1.5">
              {modelOptionsFor(provider, ollama.models).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setModel(opt.value)}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition",
                    model === opt.value
                      ? "border-emerald-300 bg-emerald-50/50 shadow-sm"
                      : "hover:bg-secondary",
                  )}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-[10px] text-muted-foreground">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <FieldLabel icon={Thermometer}>Temperature</FieldLabel>
              <span className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
                {temperature.toFixed(1)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="mt-2 w-full accent-emerald-600"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Strict</span>
              <span>Creative</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <NumberInput
              icon={Activity}
              label="Context"
              suffix="msgs"
              hint="History"
              value={contextWindow}
              min={1}
              max={200}
              onChange={(v) => setContextWindow(v || 50)}
            />
            <NumberInput
              icon={UserMinus}
              label="Takeover"
              suffix="min"
              hint="Human guard"
              value={takeover}
              min={0}
              max={120}
              onChange={(v) => setTakeover(v || 0)}
            />
          </div>

          {/* Inbound debounce — wait this many seconds after each
              inbound before the LLM fires. Every new inbound resets the
              timer, so 3 quick messages from the patient produce ONE
              combined reply instead of 3 racing ones. */}
          <NumberInput
            icon={Clock}
            label="Inbound debounce"
            suffix="sec"
            hint="Wait this long for follow-up messages before replying. 0 = reply instantly."
            value={inboundDebounce}
            min={0}
            max={120}
            onChange={(v) => setInboundDebounce(v || 0)}
          />

          {/* Reply delay — pause between LLM finishing and the message
              actually being sent. Combined with the typing indicator
              (auto-fired at the start of every run, kept alive for up
              to 45s) this gives a "human is reading + typing" feel. */}
          <NumberInput
            icon={Clock}
            label="Reply delay"
            suffix="sec"
            hint="0 = send immediately · paired with typing indicator"
            value={replyDelay}
            min={0}
            max={60}
            onChange={(v) => setReplyDelay(v || 0)}
          />

          {/* Response length — hard cap on reply length. Over-long replies
              are compressed to one short line. 0 = no limit. Keeps WhatsApp
              replies short and avoids spam-looking long paragraphs. */}
          <NumberInput
            icon={Gauge}
            label="Response length"
            suffix="words"
            hint="Max words per reply. Longer replies are auto-shortened. 0 = no limit."
            value={replyWordLimit}
            min={0}
            max={200}
            onChange={(v) => setReplyWordLimit(v || 0)}
          />

        </div>
      </div>
      </div>

      {/* Image flow — image-specific persona override + reply debounce
          + the LSQ stage-transition gate that fires when the first
          photo lands. Lives in its own card so the operator can scan
          everything photo-related at a glance. */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b px-5 py-3">
          <div className="text-sm font-semibold tracking-tight">Image flow</div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            What happens when a customer sends a photo — vision prompt, debounce, LSQ stage gate, and outbound text→image swaps.
          </p>
        </div>
        <div className="space-y-5 p-5">

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <FieldLabel icon={Database}>Image system prompt</FieldLabel>
            <AiAssistButton
              kind="image_system_prompt"
              value={imageSystemPrompt}
              onApply={setImageSystemPrompt}
            />
          </div>
          <div className="mt-1.5">
            <FullscreenTextarea
              value={imageSystemPrompt}
              onChange={setImageSystemPrompt}
              rows={6}
              maxLength={100000}
              placeholder="Used INSTEAD of the main persona when the inbound is an image. Leave blank to fall back to the main system prompt."
              title="Image system prompt"
              open={imagePromptFs}
              onOpenChange={setImagePromptFs}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 pr-12 text-xs font-mono outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              footer={
                <p className="text-[10px] text-muted-foreground">
                  Empty = use the main persona. {imageSystemPrompt.length}/100000
                </p>
              }
            />
          </div>
        </div>

        <NumberInput
          icon={Clock}
          label="Image reply delay"
          suffix="sec"
          hint="Bot waits this long; newer photos during the wait skip the older reply"
          value={imageReplyDelay}
          min={0}
          max={120}
          onChange={(v: number) => setImageReplyDelay(v || 0)}
        />

        <div>
          <FieldLabel icon={Database}>Photos-received → set stage to</FieldLabel>
          <input
            value={photoStageTarget}
            onChange={(e) => setPhotoStageTarget(e.target.value)}
            placeholder="Photos Received"
            className="mt-1.5 w-full rounded-md border bg-background px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
        </div>

        <StageAllowList
          stages={photoStageAllowedFrom}
          onChange={setPhotoStageAllowedFrom}
        />

        <ImageTriggersEditor
          triggers={imageTriggers}
          onChange={setImageTriggers}
        />
        </div>
      </div>

      {/* Transcription context — fed to Whisper as `prompt` so call
          recordings get transcribed with the right domain terminology
          (graft / FUE / DHT / etc.). Per-number, like the AI persona.
          Lead defaults moved out — they live on the LSQ page now since
          leads get created regardless of whether AI is enabled. */}
      <TranscriptionPromptEditor
        value={transcriptionPrompt}
        onChange={setTranscriptionPrompt}
      />

      {/* RAG — knowledge base mode. When on, the long system_prompt
          is replaced at runtime by a small core prompt + the top-K
          chunks retrieved from knowledge_chunks. ~75% token saving
          and easier to keep facts up-to-date (edit one chunk vs.
          a 14k-char persona). */}
      <KnowledgeBaseSection
        businessPhoneNumberId={row.business_phone_number_id}
        useRag={useRag}
        onToggleRag={setUseRag}
        topK={ragTopK}
        onTopKChange={setRagTopK}
        coreFromConfig={ragCorePrompt}
        onCorePromptChange={setRagCorePrompt}
      />

      <GuardrailsSection
        value={guardrails}
        onChange={setGuardrails}
      />

      {/* Stage-based personas — per LSQ stage, an extra persona appended to
          the base prompt when the contact is at that stage. */}
      <StagePersonasSection
        stages={lsqStages}
        value={stagePersonas}
        onChange={setStagePersonas}
      />

      {/* LSQ field mappings — runs a 2nd LLM call after the reply to
          pull structured info (name, age, email…) out of the chat and
          push it onto the matching LSQ lead. Empty by default. */}
      <FieldMappingsEditor
        mappings={fieldMappings}
        onChange={setFieldMappings}
      />

      {/* Save bar — anchored at the end of the card stack. Was sticky
          earlier; operator preferred it to flow with the page so it
          doesn't shadow the last card's controls. */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {err ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {err}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="text-xs text-muted-foreground">
            {savedAt ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            ) : dirty ? (
              <span>You have unsaved changes</span>
            ) : (
              <span>All changes saved</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </button>
        </div>
      </div>

      {installOpen ? (
        <InstallFullPromptModal
          bpid={row.business_phone_number_id}
          onClose={() => setInstallOpen(false)}
          onApply={(parts) => {
            setSystemPrompt(parts.system_prompt);
            setImageSystemPrompt(parts.image_system_prompt);
            setRagCorePrompt(parts.rag_core_prompt);
            // Any RAG prompt OR knowledge chunks → make sure RAG is on.
            if (parts.rag_core_prompt.trim() || parts.chunks_added > 0)
              setUseRag(true);
            setInstallOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Install full prompt — paste a single big bot system message, the AI
// splits it into Persona / Image / RAG fields AND extracts knowledge
// chunks (pricing, procedures, FAQs, etc.) which get embedded into the
// per-number RAG knowledge base in one go.
// ---------------------------------------------------------------------------
function InstallFullPromptModal({
  bpid,
  onClose,
  onApply,
}: {
  bpid: string;
  onClose: () => void;
  onApply: (parts: {
    system_prompt: string;
    image_system_prompt: string;
    rag_core_prompt: string;
    chunks_added: number;
  }) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    "idle" | "analyzing" | "chunking" | "done"
  >("idle");
  const [chunkProgress, setChunkProgress] = useState({ done: 0, total: 0 });
  const [chunkFailed, setChunkFailed] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setStage("analyzing");
    setChunkProgress({ done: 0, total: 0 });
    setChunkFailed(0);
    try {
      const res = await fetch("/api/automation/split-system-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json()) as {
        system_prompt?: string;
        image_system_prompt?: string;
        rag_core_prompt?: string;
        chunks?: Array<{ source: string; content: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);

      const chunks = Array.isArray(j.chunks) ? j.chunks : [];

      // Insert chunks into the knowledge base. Each POST embeds the
      // chunk inline (~1-2s), so 4 in parallel keeps the operator from
      // waiting forever without hammering the embeddings API.
      let added = 0;
      let failed = 0;
      if (chunks.length > 0) {
        setStage("chunking");
        setChunkProgress({ done: 0, total: chunks.length });
        const concurrency = 4;
        let cursor = 0;
        async function worker() {
          while (cursor < chunks.length) {
            const idx = cursor++;
            const c = chunks[idx];
            try {
              const r = await fetch("/api/automation/knowledge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  business_phone_number_id: bpid,
                  source: c.source || "general",
                  chunk_text: c.content,
                }),
              });
              if (r.ok) added++;
              else failed++;
            } catch {
              failed++;
            } finally {
              setChunkProgress({ done: added + failed, total: chunks.length });
              setChunkFailed(failed);
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
            worker(),
          ),
        );
      }

      setStage("done");
      onApply({
        system_prompt: j.system_prompt ?? "",
        image_system_prompt: j.image_system_prompt ?? "",
        rag_core_prompt: j.rag_core_prompt ?? "",
        chunks_added: added,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Split failed");
      setStage("idle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b bg-gradient-to-br from-violet-50 via-card to-card px-5 py-3.5">
          <div className="flex items-start gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-violet-100 text-violet-700 ring-1 ring-inset ring-violet-200">
              <Wand2 className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-tight">
                Install full system message
              </h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Apna pura bot training prompt paste karo — AI Persona /
                Image / RAG fields fill karega AUR factual sections
                (pricing, procedures, FAQs, policies) ko alag-alag
                knowledge-base chunks mein torrkar embed kar dega. Aap
                review karke Save kar sakte ho.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            rows={20}
            placeholder="Paste your full bot system message here…"
            className="w-full resize-y rounded-lg border bg-background px-3.5 py-3 font-mono text-[12.5px] leading-relaxed outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Persona, image-handling, RAG core, aur factual chunks — sab auto-detect honge.
            </span>
            <span className="tabular-nums">{text.length} chars</span>
          </div>

          {stage === "chunking" ? (
            <div className="mt-4 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2.5 text-[12px] text-violet-900">
              <div className="flex items-center gap-2 font-semibold">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Embedding chunks into knowledge base
                <span className="ml-auto tabular-nums">
                  {chunkProgress.done} / {chunkProgress.total}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-violet-100">
                <div
                  className="h-full bg-violet-500 transition-all"
                  style={{
                    width: `${
                      chunkProgress.total > 0
                        ? (chunkProgress.done / chunkProgress.total) * 100
                        : 0
                    }%`,
                  }}
                />
              </div>
              {chunkFailed > 0 ? (
                <p className="mt-1 text-[11px] text-rose-700">
                  {chunkFailed} chunk{chunkFailed === 1 ? "" : "s"} failed (will skip).
                </p>
              ) : null}
            </div>
          ) : null}

          {err ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {err}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void go()}
            disabled={busy || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {stage === "analyzing"
              ? "Analyzing…"
              : stage === "chunking"
                ? `Embedding ${chunkProgress.done}/${chunkProgress.total}…`
                : "Analyze & install"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// ChatTrainer — WhatsApp-styled phone preview that exercises the saved
// persona end-to-end. Lives in the right rail above ActivityFeed so the
// agent can flip between iterating the prompt (left) and watching the
// real reply unfold (right). Multi-turn — each Send carries the prior
// transcript to the LLM via /api/automation/test.
// =============================================================================
type ChatTurn = { role: "user" | "assistant"; content: string };

function ChatTrainer({
  phoneNumberId,
  numberLabel,
  numberSubLabel,
  dirty,
}: {
  phoneNumberId: string;
  numberLabel: string;
  numberSubLabel?: string | null;
  dirty: boolean;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [meta, setMeta] = useState<{
    model: string;
    latency_ms: number;
    provider: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live API health — actually pings the configured provider with a
  // tiny prompt instead of reading stale automation_logs. Refreshes
  // on mount, every 60s, and on manual click.
  const [health, setHealth] = useState<
    | { state: "ok"; model: string | null }
    | { state: "error"; message: string }
    | { state: "checking" }
    | { state: "unknown" }
  >({ state: "unknown" });

  async function refreshHealth() {
    setHealth({ state: "checking" });
    try {
      const res = await fetch("/api/automation/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_phone_number_id: phoneNumberId }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        model?: string;
        error?: string;
      };
      if (json.ok) {
        setHealth({ state: "ok", model: json.model ?? null });
      } else {
        setHealth({ state: "error", message: json.error ?? "API call failed" });
      }
    } catch (e) {
      setHealth({
        state: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  }

  useEffect(() => {
    setTurns([]);
    setMeta(null);
    refreshHealth();
    const id = setInterval(refreshHealth, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneNumberId]);

  // Auto-scroll to latest turn whenever transcript grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setDraft("");
    try {
      const res = await fetch("/api/automation/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: phoneNumberId,
          user_message: text,
          history: turns,
        }),
      });
      const json = (await res.json()) as {
        reply?: string;
        model?: string;
        latency_ms?: number;
        provider?: string;
        error?: string;
      };
      if (!res.ok) {
        setTurns([
          ...nextTurns,
          {
            role: "assistant",
            content: `⚠️ ${json.error ?? `HTTP ${res.status}`}`,
          },
        ]);
      } else {
        setTurns([...nextTurns, { role: "assistant", content: json.reply ?? "" }]);
        setMeta({
          model: json.model ?? "",
          latency_ms: json.latency_ms ?? 0,
          provider: json.provider ?? "openai",
        });
      }
    } catch (e) {
      setTurns([
        ...nextTurns,
        {
          role: "assistant",
          content: `⚠️ ${e instanceof Error ? e.message : "Network error"}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const initials =
    numberLabel
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "?";

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* Bar header — title + status chip + reset */}
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="truncate text-sm font-semibold">Agent trainer</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshHealth}
            disabled={health.state === "checking"}
            title="Recheck API"
            className="cursor-pointer disabled:cursor-default"
          >
            <HealthChip health={health} />
          </button>
          {turns.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setMeta(null);
              }}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Clear conversation"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          ) : null}
        </div>
      </header>

      {/* Phone-style preview */}
      <div className="bg-muted/40 px-3 py-3">
        <div className="mx-auto w-full max-w-[320px] overflow-hidden rounded-[24px] border border-black/10 bg-black shadow-md">
          {/* WhatsApp top bar */}
          <div className="flex items-center gap-2 bg-[#075E54] px-3 py-2 text-white">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-[10px] font-semibold">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold leading-tight">
                {numberLabel}
              </div>
              <div className="truncate text-[10px] text-white/70">
                {sending ? "typing…" : "online"}
              </div>
            </div>
          </div>

          {/* Chat thread (WhatsApp-style cream background) */}
          <div
            ref={scrollRef}
            className="h-[460px] overflow-y-auto bg-[#ECE5DD] px-2 py-3"
          >
            {turns.length === 0 && !sending ? (
              <div className="mt-12 text-center text-[11px] text-muted-foreground">
                {numberSubLabel ? (
                  <div className="mb-1 font-mono text-[10px] opacity-60">
                    {numberSubLabel}
                  </div>
                ) : null}
                Type a message below to test {numberLabel}.
                {dirty ? <div className="mt-1 text-amber-700">Save changes first.</div> : null}
              </div>
            ) : (
              <div className="space-y-1.5">
                {turns.map((t, i) => (
                  <Bubble key={i} role={t.role} content={t.content} />
                ))}
                {sending ? <TypingBubble /> : null}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 bg-[#F0F0F0] px-2 py-2">
            <div className="flex-1 rounded-2xl bg-white px-3 py-1.5 ring-1 ring-black/5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={1}
                disabled={sending || dirty}
                placeholder={dirty ? "Save changes first…" : "Message"}
                className="block w-full resize-none bg-transparent text-[13px] outline-none disabled:opacity-50"
                style={{ maxHeight: 80 }}
              />
            </div>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !draft.trim() || dirty}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-white shadow-sm hover:bg-[#1fbb5a] disabled:opacity-40"
              aria-label="Send"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {meta ? (
          <div className="mt-2 text-center text-[10px] text-muted-foreground">
            {meta.provider} · {meta.model} · {meta.latency_ms}ms
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  // user = customer (incoming, white bubble on left)
  // assistant = agent (outgoing, light-green bubble on right) — matches
  // how the operator sees the conversation in their own WhatsApp inbox.
  const isAgent = role === "assistant";
  return (
    <div className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12.5px] leading-snug shadow-sm",
          isAgent ? "bg-[#DCF8C6] text-foreground" : "bg-white text-foreground",
        )}
      >
        {content}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-end">
      <div className="rounded-lg bg-[#DCF8C6] px-3 py-2 shadow-sm">
        <span className="inline-flex gap-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
        </span>
      </div>
    </div>
  );
}

function HealthChip({
  health,
}: {
  health:
    | { state: "ok"; model: string | null }
    | { state: "error"; message: string }
    | { state: "checking" }
    | { state: "unknown" };
}) {
  if (health.state === "checking") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </span>
    );
  }
  if (health.state === "ok") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
        title={`Live ping OK · ${health.model ?? ""} · click to recheck`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        API working
      </span>
    );
  }
  if (health.state === "error") {
    const short =
      health.message.length > 60 ? `${health.message.slice(0, 60)}…` : health.message;
    return (
      <span
        className="inline-flex max-w-[420px] items-center gap-1.5 truncate rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive/15"
        title={`${health.message} — click to recheck`}
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span className="truncate">API error: {short}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      Idle
    </span>
  );
}

function FieldLabel({ icon: Icon, children }: { icon: typeof Bot; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3 w-3" />
      {children}
    </span>
  );
}

// ===========================================================================
// Stage allow-list editor — chips of LSQ ProspectStages that the
// photo-received transition is allowed to fire from. Outside the list
// = no auto-transition (manually-progressed leads stay where they are).
// ===========================================================================

const STAGE_PRESETS = [
  "Prospect",
  "Engaged",
  "Pending First Contact",
  "Photo Awaited",
];

function StageAllowList({
  stages,
  onChange,
}: {
  stages: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (s: string) => {
    const v = s.trim();
    if (!v) return;
    if (stages.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...stages, v]);
    setDraft("");
  };
  const remove = (s: string) =>
    onChange(stages.filter((x) => x !== s));
  return (
    <div>
      <FieldLabel icon={Database}>Allow stage transition only from</FieldLabel>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {stages.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200"
          >
            {s}
            <button
              type="button"
              onClick={() => remove(s)}
              className="text-emerald-700/70 hover:text-emerald-900"
              aria-label={`Remove ${s}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="Add stage (Enter)"
          className="h-7 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {STAGE_PRESETS.filter(
          (p) => !stages.some((s) => s.toLowerCase() === p.toLowerCase()),
        ).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => add(p)}
            className="rounded-full border border-dashed bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
          >
            + {p}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Photo arrival flips ProspectStage only if the lead is currently in one of these stages. Empty list = never auto-transition.
      </p>
    </div>
  );
}

// ===========================================================================
// Image-trigger editor — when the bot's outbound text matches any of
// the configured patterns AND the lead's stage gate passes, the
// pipeline replaces the text dispatch with this image (+ optional
// caption). Used to auto-send the "front/top/side scalp photo"
// instruction graphic instead of describing it in words.
// ===========================================================================

function ImageTriggersEditor({
  triggers,
  onChange,
}: {
  triggers: ImageResponseTrigger[];
  onChange: (next: ImageResponseTrigger[]) => void;
}) {
  const update = (idx: number, patch: Partial<ImageResponseTrigger>) => {
    onChange(triggers.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };
  const remove = (idx: number) =>
    onChange(triggers.filter((_, i) => i !== idx));
  const add = () =>
    onChange([
      ...triggers,
      {
        patterns: [],
        image_url: "",
        caption: "",
        gate_by_stage: true,
      },
    ]);

  return (
    <div>
      <FieldLabel icon={Database}>Trigger phrases → send image</FieldLabel>
      <p className="mt-1 text-[10px] text-muted-foreground">
        When the bot is about to send a reply that matches any pattern
        below, the text is replaced with this image. Stage-gated rules
        only fire when the lead is in the allow-list above.
      </p>
      <div className="mt-2 space-y-3">
        {triggers.map((t, idx) => (
          <ImageTriggerRow
            key={idx}
            trigger={t}
            onChange={(patch) => update(idx, patch)}
            onRemove={() => remove(idx)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-3 inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 text-xs font-medium text-primary hover:border-primary hover:bg-primary/10"
      >
        + Add another trigger
      </button>
    </div>
  );
}

function ImageTriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: ImageResponseTrigger;
  onChange: (patch: Partial<ImageResponseTrigger>) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const addPattern = () => {
    const v = draft.trim();
    if (!v) return;
    if (trigger.patterns.includes(v)) return;
    onChange({ patterns: [...trigger.patterns, v] });
    setDraft("");
  };
  const removePattern = (p: string) =>
    onChange({ patterns: trigger.patterns.filter((x) => x !== p) });

  return (
    <div className="rounded-md border bg-secondary/40 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Patterns (any match fires)
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-[11px] text-destructive hover:underline"
        >
          Remove rule
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {trigger.patterns.map((p) => (
          <span
            key={p}
            className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-200"
          >
            <span className="font-mono">{p}</span>
            <button
              type="button"
              onClick={() => removePattern(p)}
              className="text-violet-700/70 hover:text-violet-900"
              aria-label={`Remove ${p}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addPattern();
            }
          }}
          placeholder="Pattern (regex or substring) · Enter to add"
          className="h-7 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <button
          type="button"
          onClick={addPattern}
          disabled={!draft.trim()}
          className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <TriggerImagePicker
        url={trigger.image_url}
        onChange={(url) => onChange({ image_url: url })}
      />

      <div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Caption (optional)
        </span>
        <textarea
          value={trigger.caption ?? ""}
          onChange={(e) => onChange({ caption: e.target.value })}
          placeholder="e.g. Aap apni front, top aur side ki 2-3 clear scalp photos bhej do."
          rows={2}
          className="mt-1 w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={trigger.gate_by_stage !== false}
          onChange={(e) => onChange({ gate_by_stage: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border accent-emerald-600"
        />
        Only fire when lead&apos;s stage is in the allow-list above
      </label>
    </div>
  );
}

// Compact image picker — preview + upload + manual URL fallback.
// Uploads land in the public `automation-trigger-images` bucket and
// the resulting public URL is what gets stored in the trigger rule
// (Meta fetches it directly when the bot dispatches the image).
function TriggerImagePicker({
  url,
  onChange,
}: {
  url: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/automation/trigger-image", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.url) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      onChange(json.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Image
      </span>
      <div className="mt-1 flex items-start gap-2">
        {url ? (
          <img
            src={url}
            alt="trigger preview"
            className="h-16 w-16 shrink-0 rounded border object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">
            no image
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <input
            value={url}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://… (public URL) or upload below"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2.5 text-[11px] font-medium hover:bg-secondary disabled:opacity-50"
            >
              {busy ? "Uploading…" : url ? "Replace" : "Upload"}
            </button>
            {url ? (
              <button
                type="button"
                onClick={() => onChange("")}
                disabled={busy}
                className="text-[11px] text-muted-foreground hover:text-destructive"
              >
                Clear
              </button>
            ) : null}
            {error ? (
              <span className="text-[10px] text-destructive">{error}</span>
            ) : null}
          </div>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        onChange={onFile}
        className="hidden"
      />
    </div>
  );
}

// ===========================================================================
// Transcription prompt editor — Whisper's `prompt` parameter accepts a
// short context blurb that biases the model toward domain-specific
// terminology. Per-number so each clinic / brand can describe its own
// jargon. Plain textarea, max 4000 chars.
// ===========================================================================

function TranscriptionPromptEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <section className="border-t bg-sky-50/30">
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <FieldLabel icon={Sparkles}>Call transcription context</FieldLabel>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              Helps Whisper spell domain terms correctly
            </span>
            <AiAssistButton
              kind="transcription_prompt"
              value={value}
              onApply={onChange}
            />
          </div>
        </div>
        <p className="mb-2 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-1.5 text-[10px] text-sky-900">
          Describe what the calls are about + common terms the patient or
          agent might say. e.g.{" "}
          <span className="font-mono">
            &quot;Hair-transplant consultation in Hindi+English. Common
            terms: graft, FUE, DHT, telogen, donor area.&quot;
          </span>
        </p>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, 4000))}
          placeholder="Hair-transplant consultation. Hindi+English code-switching. Common terms: graft, FUE, DHT, donor area, baldness pattern…"
          rows={4}
          className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            Applied automatically when transcribing this number&apos;s call
            recordings.
          </span>
          <span className="tabular-nums">{value.length} / 4000</span>
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Knowledge base section — RAG mode toggle + chunk manager. When the
// "Use RAG" switch is on, the runtime ditches the long persona and
// replaces it with `rag_core_prompt` + retrieved chunks. The chunk
// manager calls /api/automation/knowledge to read/write rows on the
// knowledge_chunks table; embeddings are computed at write time so
// retrieval stays fast.
// ===========================================================================

interface KnowledgeChunk {
  id: string;
  business_phone_number_id: string;
  source: string;
  chunk_text: string;
  token_count: number | null;
  created_at: string;
  updated_at: string;
}

function KnowledgeBaseSection({
  businessPhoneNumberId,
  useRag,
  onToggleRag,
  topK,
  onTopKChange,
  coreFromConfig,
  onCorePromptChange,
}: {
  businessPhoneNumberId: string;
  useRag: boolean;
  onToggleRag: (next: boolean) => void;
  topK: number;
  onTopKChange: (next: number) => void;
  coreFromConfig: string;
  onCorePromptChange: (next: string) => void;
}) {
  const [chunks, setChunks] = useState<KnowledgeChunk[] | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch(
        `/api/automation/knowledge?business_phone_number_id=${encodeURIComponent(businessPhoneNumberId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as {
        chunks?: KnowledgeChunk[];
        total_tokens?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setChunks(json.chunks ?? []);
      setTotalTokens(json.total_tokens ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chunks");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessPhoneNumberId]);

  return (
    <section className="border-t bg-violet-50/30">
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <FieldLabel icon={Database}>Knowledge base (RAG)</FieldLabel>
          <span className="text-[10px] text-muted-foreground">
            {chunks ? `${chunks.length} chunks · ${totalTokens.toLocaleString()} tokens stored` : "loading…"}
          </span>
        </div>
        <p className="mb-3 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-1.5 text-[10px] text-violet-900">
          With <strong>Use RAG</strong> on, the bot replaces the long persona
          with a small <em>core prompt</em> + the top-K most-relevant chunks
          retrieved from this knowledge base. Typical saving: <strong>60–80%</strong>{" "}
          tokens per inbound. Edit knowledge by editing chunks here — no need to
          re-train the persona.
        </p>

        {/* Master toggle + top-K */}
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useRag}
              onChange={(e) => onToggleRag(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-violet-600"
            />
            <span className="font-medium">Use RAG</span>
            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
              {useRag ? "Enabled" : "Disabled"}
            </span>
          </label>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            Top-K
            <input
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => onTopKChange(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
              className="h-7 w-16 rounded-md border bg-background px-2 text-xs"
            />
            chunks per reply
          </span>
        </div>

        {/* Core prompt — small persona + rules used INSTEAD of the
            long system_prompt when RAG is on. Knowledge moves into chunks. */}
        <div className="mb-3 rounded-lg border bg-card p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              RAG core prompt
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {coreFromConfig.length} chars
              </span>
              <AiAssistButton
                kind="rag_core_prompt"
                value={coreFromConfig}
                onApply={onCorePromptChange}
              />
            </div>
          </div>
          <textarea
            value={coreFromConfig}
            onChange={(e) => onCorePromptChange(e.target.value)}
            rows={5}
            placeholder={
              "You are Diksha, QHT Clinic medical counselor. Reply in Hinglish, short + warm. Use only the facts in RELEVANT KNOWLEDGE below. If unsure, say you'll get back to them."
            }
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Keep it short (rules + tone only). The big knowledge moves into chunks below.
          </p>
        </div>

        {/* Chunks list */}
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Chunks
            </span>
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setEditingId(null);
              }}
              className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white shadow-sm hover:bg-violet-700"
            >
              <Plus className="h-2.5 w-2.5" />
              Add chunk
            </button>
          </div>

          {error ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}

          {adding ? (
            <ChunkEditor
              businessPhoneNumberId={businessPhoneNumberId}
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                load();
              }}
            />
          ) : null}

          {chunks === null ? (
            <div className="grid h-16 place-items-center text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          ) : chunks.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              No chunks yet. Click Add chunk to break your persona into bite-sized facts.
            </div>
          ) : (
            <ul className="divide-y">
              {chunks.map((c) => (
                <li key={c.id} className="px-3 py-2.5">
                  {editingId === c.id ? (
                    <ChunkEditor
                      businessPhoneNumberId={businessPhoneNumberId}
                      existing={c}
                      onClose={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        load();
                      }}
                    />
                  ) : (
                    <ChunkRow
                      chunk={c}
                      onEdit={() => setEditingId(c.id)}
                      onDeleted={load}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function ChunkRow({
  chunk,
  onEdit,
  onDeleted,
}: {
  chunk: KnowledgeChunk;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDelete() {
    if (!confirm(`Delete chunk "${chunk.source}"? This can't be undone.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/automation/knowledge/${chunk.id}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-100">
          {chunk.source}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {chunk.token_count ?? 0} tokens · {chunk.chunk_text.length} chars
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="inline-flex h-6 items-center justify-center rounded-md border bg-background px-2 text-[10px] font-medium hover:bg-secondary disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
            aria-label="Delete chunk"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <p className="line-clamp-3 text-[12px] leading-snug text-foreground/85 whitespace-pre-wrap">
        {chunk.chunk_text}
      </p>
      {err ? (
        <p className="text-[10px] text-destructive">{err}</p>
      ) : null}
    </div>
  );
}

function ChunkEditor({
  businessPhoneNumberId,
  existing,
  onClose,
  onSaved,
}: {
  businessPhoneNumberId: string;
  existing?: KnowledgeChunk;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState(existing?.source ?? "general");
  const [chunkText, setChunkText] = useState(existing?.chunk_text ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    const text = chunkText.trim();
    if (!text) {
      setErr("Chunk text cannot be empty");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const url = existing
        ? `/api/automation/knowledge/${existing.id}`
        : "/api/automation/knowledge";
      const method = existing ? "PATCH" : "POST";
      const body = existing
        ? { source: source.trim() || "general", chunk_text: text }
        : {
            business_phone_number_id: businessPhoneNumberId,
            source: source.trim() || "general",
            chunk_text: text,
          };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-violet-200 bg-violet-50/40 p-2.5">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source label (e.g. Pricing, Procedures, FAQ)"
          className="rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <span className="self-center text-[10px] text-muted-foreground tabular-nums">
          {chunkText.length} / 8000
        </span>
        <AiAssistButton
          kind="knowledge_chunk"
          value={chunkText}
          onApply={setChunkText}
          compact
        />
      </div>
      <textarea
        value={chunkText}
        onChange={(e) => setChunkText(e.target.value.slice(0, 8000))}
        rows={5}
        placeholder="One self-contained fact / FAQ / pricing block. Keep ~200-500 chars per chunk for best retrieval."
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
      />
      {err ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {err}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-md border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {existing ? "Save changes" : "Save + embed"}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Lead defaults editor — preserved here as a reusable component because
// LsqView (Settings → LeadSquared) imports it. Lives on the LSQ page now,
// not on the AI / Automation page, since leads get created regardless of
// whether the AI auto-reply is enabled.
// ===========================================================================

export function LeadDefaultsEditor({
  defaults,
  onChange,
  title = "Lead defaults",
  subtitle = "Stamped on every lead from this number — Source, Sub Source, etc.",
}: {
  defaults: LeadDefault[];
  onChange: (next: LeadDefault[]) => void;
  title?: string;
  subtitle?: string;
}) {
  function update(idx: number, patch: Partial<LeadDefault>) {
    onChange(defaults.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }
  function remove(idx: number) {
    onChange(defaults.filter((_, i) => i !== idx));
  }
  function add(preset?: { field: string; placeholder: string }) {
    onChange([
      ...defaults,
      preset
        ? { lsq_field: preset.field, value: "" }
        : { lsq_field: "", value: "" },
    ]);
  }

  const usedFields = new Set(defaults.map((d) => d.lsq_field));
  const availablePresets = LEAD_DEFAULT_PRESETS.filter(
    (p) => !usedFields.has(p.field),
  );

  return (
    <section className="border-t bg-violet-50/30">
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <FieldLabel icon={Database}>{title}</FieldLabel>
          <span className="text-[10px] text-muted-foreground">
            {subtitle}
          </span>
        </div>
        <p className="mb-2 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-1.5 text-[10px] text-violet-900">
          <strong>Both columns are editable.</strong> Schema name = the LSQ
          column you write to (e.g. <span className="font-mono">Source</span>,
          <span className="font-mono"> mx_Sub_source</span>). Value = what gets
          written. Click a preset below to add, then edit either side.
        </p>

        {defaults.length > 0 ? (
          <>
            <div className="mb-1 grid grid-cols-1 gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid-cols-[1fr_1fr_auto]">
              <span>LSQ schema field</span>
              <span>Value</span>
              <span className="w-7" />
            </div>
            <ul className="space-y-1.5">
              {defaults.map((d, idx) => {
                const preset = LEAD_DEFAULT_PRESETS.find((p) => p.field === d.lsq_field);
                return (
                  <li
                    key={idx}
                    className="grid grid-cols-1 items-center gap-2 rounded-lg border bg-card px-3 py-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <input
                      value={d.lsq_field}
                      onChange={(e) => update(idx, { lsq_field: e.target.value })}
                      placeholder="LSQ field (e.g. Source)"
                      title="Change this to any LSQ column name — e.g. mx_CustomField"
                      className="rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                    />
                    <input
                      value={d.value}
                      onChange={(e) => update(idx, { value: e.target.value })}
                      placeholder={preset?.placeholder ?? "Value"}
                      className="rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                    />
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="rounded-md border border-dashed bg-card/40 px-3 py-2.5 text-[11px] text-muted-foreground">
            No defaults yet. Add Source / Sub Source / Source Medium below — these stay constant per number.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {availablePresets.map((preset) => (
            <button
              key={preset.field}
              type="button"
              onClick={() => add(preset)}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5" />
              {preset.field}
            </button>
          ))}
          <button
            type="button"
            onClick={() => add()}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-2.5 w-2.5" />
            Custom default
          </button>
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// LSQ field-mappings editor — list of {description, lsq_field} rows the
// post-reply pipeline reads to know what to extract from the chat and
// where to push it on the LSQ lead. Description is what the LLM looks
// for; lsq_field is the schema column we update.
// ===========================================================================

// Field names match the QHT LSQ tenant's actual schema (mx_ prefixes
// confirmed via the Lead.CreateOrUpdate payload). Source-tracking
// attributes live in LEAD_DEFAULT_PRESETS instead — those are
// per-number constants, not extracted from chat.
const COMMON_LSQ_FIELDS: Array<{ field: string; description: string }> = [
  { field: "FirstName",       description: "patient's full name" },
  { field: "EmailAddress",    description: "email address" },
  { field: "mx_Lead_City",    description: "city the patient lives in" },
  { field: "mx_Lead_State",   description: "state the patient lives in" },
  { field: "Country",         description: "country" },
  { field: "mx_Patient_Age",  description: "patient's age in years (number only)" },
  { field: "mx_Zip",          description: "6-digit Indian pincode / ZIP code" },
];

// Static defaults the bot stamps on every lead from this number —
// classic source-tracking shape. The operator picks one value per
// preset (e.g. Source = "Alchemane" for the Alchemane number, "QHT" for the
// clinic number) and it gets re-applied on every Lead.CreateOrUpdate.
const LEAD_DEFAULT_PRESETS: Array<{ field: string; placeholder: string }> = [
  { field: "Source",        placeholder: "e.g. Alchemane" },
  { field: "mx_Sub_source", placeholder: "e.g. Whatsapp Inbound" },
  { field: "SourceMedium",  placeholder: "e.g. WhatsApp" },
  { field: "mx_utm_source", placeholder: "e.g. FB Forms" },
  { field: "mx_Brand",      placeholder: "e.g. QHT" },
  { field: "mx_NDR_Reason", placeholder: "e.g. QHT" },
];

// =====================================================================
// Guardrails — operator-defined "never do this" rules per number. Sits
// inside the system prompt as a strict-rules block so the model treats
// them as non-negotiable. Free-form text; one rule per line works well.
// =====================================================================
// =====================================================================
// Stage personas — per LSQ stage, an extra persona block appended to the
// base prompt when the contact is currently at that stage. Lets one number
// run different "scenarios" (Prospect, Photos Received, HT Done, …).
// =====================================================================
function StagePersonasSection({
  stages,
  value,
  onChange,
}: {
  stages: string[];
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [picker, setPicker] = useState("");
  const used = Object.keys(value);
  const available = stages.filter((s) => !used.includes(s));

  const add = (stage: string) => {
    if (!stage || stage in value) return;
    onChange({ ...value, [stage]: "" });
    setPicker("");
  };
  const setText = (stage: string, text: string) => onChange({ ...value, [stage]: text });
  const remove = (stage: string) => {
    const next = { ...value };
    delete next[stage];
    onChange(next);
  };

  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold tracking-tight">Stage personas</h2>
        <span className="text-[11px] text-muted-foreground">
          Lead jis LSQ stage pe ho, uska persona base prompt ke saath add ho jata hai.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={picker}
            onChange={(e) => add(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">+ Add stage…</option>
            {available.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {used.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed bg-secondary/30 px-3 py-3 text-center text-xs text-muted-foreground">
          Koi stage persona nahi. Upar se ek stage choose karke uska persona daalo. Base persona
          sab pe lagta hai; ye uske aage stage-specific scenario jodta hai.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {used.map((stage) => (
            <div key={stage} className="rounded-lg border bg-background p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="rounded-md bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-800 ring-1 ring-inset ring-violet-200">
                  {stage}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{value[stage].length} chars</span>
                  <button
                    type="button"
                    onClick={() => remove(stage)}
                    className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <textarea
                value={value[stage]}
                onChange={(e) => setText(stage, e.target.value)}
                rows={6}
                placeholder={`Persona / scenario for "${stage}" leads…`}
                className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:border-primary"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GuardrailsSection({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const lineCount = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
  return (
    <section className="overflow-hidden rounded-xl border-2 border-rose-100/70 bg-gradient-to-br from-rose-50/40 via-card to-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-100/60 px-5 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-rose-600 text-white shadow-md shadow-rose-600/30 ring-1 ring-inset ring-rose-300/50">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight">Guardrails</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Bot ko ye cheezein bilkul nahi karni — har reply pe enforce hota hai.
            </p>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
            lineCount > 0
              ? "bg-rose-100 text-rose-700 ring-rose-200"
              : "bg-secondary text-muted-foreground ring-border",
          )}
        >
          {lineCount > 0 ? `${lineCount} rule${lineCount === 1 ? "" : "s"}` : "off"}
        </span>
      </header>
      <div className="px-5 py-3">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          maxLength={20000}
          placeholder={
            "One rule per line. Examples:\n" +
            "• Never quote prices on WhatsApp — say a counselor will share them on a call.\n" +
            "• Never claim a guaranteed result or 100% success rate.\n" +
            "• Never mention competitor clinics by name.\n" +
            "• If patient mentions cardiac / pregnancy / minors, do not answer — say a doctor will reach out."
          }
          className="w-full resize-y rounded-lg border border-rose-200/70 bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-200/50"
        />
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          Tip: short, specific rules work best. The bot will politely decline
          and offer a human handoff when a request would break a rule.
        </p>
      </div>
    </section>
  );
}

function FieldMappingsEditor({
  mappings,
  onChange,
}: {
  mappings: FieldMapping[];
  onChange: (next: FieldMapping[]) => void;
}) {
  function update(idx: number, patch: Partial<FieldMapping>) {
    onChange(mappings.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }
  function remove(idx: number) {
    onChange(mappings.filter((_, i) => i !== idx));
  }
  function add(preset?: { field: string; description: string }) {
    onChange([
      ...mappings,
      preset
        ? { description: preset.description, lsq_field: preset.field }
        : { description: "", lsq_field: "" },
    ]);
  }

  // Presets the user hasn't already added — keeps the "Add common
  // field" buttons from offering duplicates.
  const usedFields = new Set(mappings.map((m) => m.lsq_field));
  const availablePresets = COMMON_LSQ_FIELDS.filter((p) => !usedFields.has(p.field));

  return (
    <section className="border-t bg-secondary/20">
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <FieldLabel icon={Database}>LSQ field mappings</FieldLabel>
          <span className="text-[10px] text-muted-foreground">
            Bot extracts these from chat → updates the LSQ lead
          </span>
        </div>
        <p className="mb-2 rounded-md border bg-card/60 px-3 py-1.5 text-[10px] text-muted-foreground">
          <strong>Both columns are editable.</strong> Description tells the
          extraction LLM what to look for; schema field is the LSQ column to
          update. Use any LSQ schema name including custom <span className="font-mono">mx_*</span> fields.
        </p>

        {mappings.length > 0 ? (
          <>
            <div className="mb-1 grid grid-cols-1 gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid-cols-[1fr_1fr_auto]">
              <span>What to extract</span>
              <span>LSQ schema field</span>
              <span className="w-7" />
            </div>
            <ul className="space-y-1.5">
              {mappings.map((m, idx) => (
                <li
                  key={idx}
                  className="grid grid-cols-1 items-center gap-2 rounded-lg border bg-card px-3 py-2 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <input
                    value={m.description}
                    onChange={(e) => update(idx, { description: e.target.value })}
                    placeholder="What to extract (e.g. patient's age)"
                    className="rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                  <input
                    value={m.lsq_field}
                    onChange={(e) => update(idx, { lsq_field: e.target.value })}
                    placeholder="LSQ field (e.g. mx_Patient_Age)"
                    title="Edit to match your LSQ tenant's exact column name"
                    className="rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="rounded-md border border-dashed bg-card/40 px-3 py-2.5 text-[11px] text-muted-foreground">
            No mappings yet. Add a common field below or define a custom one.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {availablePresets.map((preset) => (
            <button
              key={preset.field}
              type="button"
              onClick={() => add(preset)}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5" />
              {preset.field}
            </button>
          ))}
          <button
            type="button"
            onClick={() => add()}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-2.5 w-2.5" />
            Custom field
          </button>
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Provider toggle + Ollama health pill — used by NumberConfigCard.
// ===========================================================================
interface OllamaHealth {
  ok: boolean;
  base_url: string;
  models: string[];
  error: string | null;
}

function useOllamaHealth(active: boolean): OllamaHealth {
  const [health, setHealth] = useState<OllamaHealth>({
    ok: false,
    base_url: "",
    models: [],
    error: null,
  });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/ollama/health", { cache: "no-store" });
        const json = (await res.json()) as OllamaHealth;
        if (!cancelled) setHealth(json);
      } catch {
        if (!cancelled) {
          setHealth({ ok: false, base_url: "", models: [], error: "Network error" });
        }
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);
  return health;
}

function modelOptionsFor(
  provider: AutomationProvider,
  ollamaModels: string[],
): ModelOption[] {
  if (provider === "openai") return OPENAI_MODELS;
  if (ollamaModels.length === 0) return DEFAULT_OLLAMA_MODELS;
  // Map raw Ollama model names to the same {value,label,hint} shape so
  // the picker UI doesn't need to special-case the provider.
  return ollamaModels.map((name) => {
    const preset = DEFAULT_OLLAMA_MODELS.find((m) => m.value === name);
    return preset ?? { value: name, label: name, hint: "Local · installed" };
  });
}

function ProviderToggle({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-xs transition",
        active
          ? "border-emerald-300 bg-emerald-50/50 shadow-sm"
          : "hover:bg-secondary",
      )}
    >
      <span className="font-semibold">{label}</span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </button>
  );
}

function OllamaStatusLine({ health }: { health: OllamaHealth }) {
  if (health.ok) {
    return (
      <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Connected · {health.models.length} {health.models.length === 1 ? "model" : "models"} pulled
      </div>
    );
  }
  return (
    <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
      <div className="font-semibold">Ollama unreachable</div>
      <div className="mt-0.5 text-amber-800/80">
        {health.error ?? "Server not responding"}.{" "}
        Start it with <span className="font-mono">ollama serve</span>.
      </div>
    </div>
  );
}

function NumberInput({
  icon,
  label,
  suffix,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  icon: typeof Activity;
  label: string;
  suffix: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <FieldLabel icon={icon}>{label}</FieldLabel>
      <div className="mt-1.5 flex items-center rounded-lg border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-transparent px-3 py-1.5 text-sm tabular-nums outline-none"
        />
        <span className="pr-3 text-[10px] text-muted-foreground">{suffix}</span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow ring-1 ring-black/5 transition-transform",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ===========================================================================
// Activity feed
// ===========================================================================
function ActivityFeed({
  logs,
  onRefresh,
}: {
  logs: LogRow[] | null;
  onRefresh: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Live
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Last 50 runs · auto-refreshes every 15s
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
          aria-label="Refresh"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
      </header>
      {/* Internal scroll for the rows. The xl breakpoint's max-h matches
          the sticky wrapper minus the header so we don't get a nested
          scrollbar overlap. Below xl, falls back to natural document
          scroll alongside the rest of the page. */}
      <div className="divide-y xl:max-h-[calc(100vh-13rem)] xl:overflow-y-auto">
        {logs === null ? (
          <div className="grid h-24 place-items-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : logs.length === 0 ? (
          <div className="grid h-32 place-items-center px-6 text-center">
            <div>
              <div className="mx-auto mb-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <Activity className="h-4 w-4" />
              </div>
              <div className="text-xs font-medium">No runs yet</div>
              <div className="text-[11px] text-muted-foreground">
                Runs appear here when this number receives messages.
              </div>
            </div>
          </div>
        ) : (
          logs.map((l) => <ActivityRow key={l.id} log={l} />)
        )}
      </div>
    </section>
  );
}

function ActivityRow({ log }: { log: LogRow }) {
  // `processing` rows are mid-flight claims from the atomic-claim flow
  // (migration 0061). The UI shouldn't render them as final outcomes —
  // they'll flip to success/failed/skipped within a few seconds. Fall
  // back to the skipped icon so the row doesn't crash if one slips
  // through into the feed before being finalized.
  const cfg =
    {
      success: { Icon: CheckCircle2, ring: "bg-emerald-50 text-emerald-600 ring-emerald-100" },
      failed: { Icon: XCircle, ring: "bg-rose-50 text-rose-600 ring-rose-100" },
      skipped: { Icon: PauseCircle, ring: "bg-secondary text-muted-foreground ring-border" },
      processing: { Icon: Loader2, ring: "bg-sky-50 text-sky-600 ring-sky-100" },
    }[log.status] ?? {
      Icon: PauseCircle,
      ring: "bg-secondary text-muted-foreground ring-border",
    };
  // Tri-state from automation_logs.rag_chunks:
  //   null   → RAG was off for this reply (no pill)
  //   []     → RAG was on, no chunks matched (muted pill)
  //   [...]  → chunks the model received (amber pill, expandable)
  const ragWasOn = Array.isArray(log.rag_chunks);
  const chunks: RagChunkRef[] = log.rag_chunks ?? [];
  const [chunksOpen, setChunksOpen] = useState(false);
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <span
        className={cn(
          "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
          cfg.ring,
        )}
      >
        <cfg.Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{log.contact?.display ?? "—"}</span>
          <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatTime(log.created_at)}
          </time>
        </div>
        {log.status === "success" && log.cleaned_output ? (
          <div className="mt-0.5 line-clamp-2 rounded-md bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground/85">
            {log.cleaned_output}
          </div>
        ) : log.status === "failed" ? (
          <div className="mt-0.5 text-xs text-rose-700">{log.error_message ?? "Failed"}</div>
        ) : (
          <div className="mt-0.5 text-xs italic text-muted-foreground">
            Skipped — {log.skip_reason ?? "unknown reason"}
          </div>
        )}
        {log.status === "success" ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground">
            {log.model ? <Tag>{log.model}</Tag> : null}
            {log.prompt_tokens != null ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-violet-700 ring-1 ring-violet-100"
                title={`Prompt ${log.prompt_tokens} + Reply ${log.completion_tokens ?? 0} = ${(log.prompt_tokens + (log.completion_tokens ?? 0)).toLocaleString()} tokens used`}
              >
                <Sparkles className="h-2.5 w-2.5" />
                {(log.prompt_tokens + (log.completion_tokens ?? 0)).toLocaleString()} tokens
                <span className="opacity-60">
                  ({log.prompt_tokens.toLocaleString()}+{(log.completion_tokens ?? 0).toLocaleString()})
                </span>
              </span>
            ) : null}
            {log.duration_ms != null ? <Tag>{log.duration_ms}ms</Tag> : null}
            {ragWasOn && chunks.length > 0 ? (
              <button
                type="button"
                onClick={() => setChunksOpen((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ring-1 transition",
                  chunksOpen
                    ? "bg-amber-100 text-amber-800 ring-amber-300"
                    : "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100",
                )}
                title="Show the knowledge chunks the bot used for this reply"
              >
                <Database className="h-2.5 w-2.5" />
                {chunks.length} chunk{chunks.length === 1 ? "" : "s"}
                <ChevronDown
                  className={cn(
                    "h-2.5 w-2.5 transition-transform",
                    chunksOpen && "rotate-180",
                  )}
                />
              </button>
            ) : ragWasOn ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-50/60 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-700/70 ring-1 ring-amber-200/60"
                title="RAG was on but no chunks matched the patient's message — add a relevant chunk to the knowledge base."
              >
                <Database className="h-2.5 w-2.5" />
                RAG · 0 matched
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                title="RAG is off for this number — the bot used the full system prompt instead of retrieved knowledge."
              >
                <Database className="h-2.5 w-2.5 opacity-60" />
                RAG off
              </span>
            )}
          </div>
        ) : null}

        {chunksOpen && chunks.length > 0 ? (
          <div className="mt-2 space-y-1.5 rounded-md border border-amber-200/70 bg-amber-50/50 p-2">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-amber-700">
              Knowledge used
            </div>
            {chunks.map((c, i) => (
              <div
                key={c.id || i}
                className="rounded bg-card px-2 py-1.5 text-[11px] leading-snug text-foreground/85 ring-1 ring-inset ring-amber-100"
              >
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-semibold text-amber-700">
                    {c.source || "chunk"}
                  </span>
                  <span className="font-mono text-[9.5px] text-amber-600/80">
                    {(c.similarity * 100).toFixed(0)}% match
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-[11px] text-foreground/80">
                  {c.snippet}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">
      {children}
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ===========================================================================
// Empty / loading
// ===========================================================================
function SkeletonState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border bg-card shadow-sm">
            <div className="h-full animate-pulse rounded-xl bg-secondary/40" />
          </div>
        ))}
      </div>
      <div className="h-16 animate-pulse rounded-xl border bg-card shadow-sm" />
      <div className="h-96 animate-pulse rounded-xl border bg-card shadow-sm" />
    </div>
  );
}

function EmptyNumbersState() {
  return (
    <div className="grid place-items-center rounded-xl border-2 border-dashed bg-card/50 px-6 py-16 text-center">
      <div>
        <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="text-sm font-semibold">No WhatsApp numbers yet</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Connect a number from Settings → Portfolios. Once it receives its first message,
          you can configure auto-reply here.
        </div>
      </div>
    </div>
  );
}


// ===========================================================================
// Quality review — daily 10-minute loop. Operator skims the bot's
// recent unrated replies, marks each Good / Needs review / Wrong with
// an optional note. Patterns surface over weeks → fix chunks or rules.
// ===========================================================================
interface ReviewLog {
  id: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  cleaned_output: string | null;
  created_at: string;
  contact: { display: string; wa_id: string; id: string } | null;
  trigger_inbound: {
    content: string | null;
    type: string;
    timestamp: string;
  } | null;
}

function QualityReviewView({
  rows,
  selectedId,
  onSelect,
}: {
  rows: NumberRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [logs, setLogs] = useState<ReviewLog[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Row currently being corrected — when "Wrong" is clicked we open an
  // inline form asking what the bot SHOULD have said. That correction
  // becomes a knowledge chunk so future similar messages get the right
  // answer via RAG.
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  const load = useMemo(
    () => async (bpid: string | null) => {
      setErr(null);
      setLogs(null);
      try {
        const qs = new URLSearchParams({ unreviewed: "1", limit: "50" });
        if (bpid) qs.set("business_phone_number_id", bpid);
        const res = await fetch(`/api/automation/logs?${qs.toString()}`, {
          cache: "no-store",
        });
        const j = (await res.json()) as { logs?: ReviewLog[]; error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setLogs(j.logs ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Load failed");
      }
    },
    [],
  );

  useEffect(() => {
    void load(selectedId);
  }, [load, selectedId]);

  async function rate(id: string, rating: "good" | "needs_review" | "wrong") {
    if (busyId) return;
    // "Wrong" needs a correction — open the inline form instead of
    // submitting straight away.
    if (rating === "wrong") {
      setCorrectingId(id);
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/automation/logs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, note: "" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogs((prev) => (prev ?? []).filter((l) => l.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyId(null);
    }
  }

  // Save a "Wrong" rating + the operator's correct reply. The correction
  // is embedded as a knowledge chunk so the RAG retriever pulls it for
  // similar future inbounds and the bot learns the right answer.
  async function saveCorrection(log: ReviewLog) {
    const correction = (corrections[log.id] ?? "").trim();
    if (!correction || busyId) return;
    if (!log.business_phone_number_id) {
      setErr("This log has no business number — can't store the correction.");
      return;
    }
    setBusyId(log.id);
    try {
      const inbound =
        log.trigger_inbound?.content?.trim() ||
        (log.trigger_inbound
          ? `[${log.trigger_inbound.type}]`
          : "(no recent inbound)");
      const chunkText = [
        "PAST CORRECTION — operator-verified answer.",
        `Patient said: "${inbound}"`,
        `Correct reply: "${correction}"`,
        "Use this answer (or a close paraphrase) when a similar message arrives.",
      ].join("\n");
      const kbRes = await fetch("/api/automation/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: log.business_phone_number_id,
          source: "Past correction",
          chunk_text: chunkText,
        }),
      });
      if (!kbRes.ok) throw new Error(`Knowledge save HTTP ${kbRes.status}`);
      const patchRes = await fetch(
        `/api/automation/logs/${encodeURIComponent(log.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "wrong", note: correction }),
        },
      );
      if (!patchRes.ok) throw new Error(`Log save HTTP ${patchRes.status}`);
      setLogs((prev) => (prev ?? []).filter((l) => l.id !== log.id));
      setCorrectingId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Correction save failed");
    } finally {
      setBusyId(null);
    }
  }

  const selectedRow = rows.find(
    (r) => r.business_phone_number_id === selectedId,
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Quality review</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Pick a number to see the bot you&apos;re training, skim its
            recent replies, and mark each one. Wrong replies let you
            type the correct answer — it&apos;s saved as a knowledge
            chunk so the next similar message gets the right reply.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(selectedId)}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </header>

      {rows.length > 0 ? (
        <NumberPicker
          rows={rows}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}

      {err ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      ) : null}

      {logs === null ? (
        <div className="grid h-32 place-items-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-secondary/40 px-6 py-10 text-center">
          <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" />
          <div className="mt-2 text-sm font-semibold">All caught up</div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {selectedRow
              ? `No unrated replies for ${labelOf(selectedRow)} right now.`
              : "No unrated bot replies right now."}{" "}
            Come back tomorrow — daily review is what makes the bot
            world-class.
          </p>
        </div>
      ) : (
        <QualityMasterDetail
          logs={logs}
          selectedRow={selectedRow ?? null}
          busyId={busyId}
          correctingId={correctingId}
          setCorrectingId={setCorrectingId}
          corrections={corrections}
          setCorrections={setCorrections}
          onRate={rate}
          onSaveCorrection={(l) => void saveCorrection(l)}
        />
      )}
    </div>
  );
}

// Grouped master-detail — left column lists contacts with pending bot
// replies, right column shows that contact's reply queue. Keeps each
// reply card readably narrow and lets the operator chew through one
// contact's thread end-to-end before moving on.
function QualityMasterDetail({
  logs,
  selectedRow,
  busyId,
  correctingId,
  setCorrectingId,
  corrections,
  setCorrections,
  onRate,
  onSaveCorrection,
}: {
  logs: ReviewLog[];
  selectedRow: NumberRow | null;
  busyId: string | null;
  correctingId: string | null;
  setCorrectingId: React.Dispatch<React.SetStateAction<string | null>>;
  corrections: Record<string, string>;
  setCorrections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRate: (id: string, r: "good" | "needs_review" | "wrong") => Promise<void>;
  onSaveCorrection: (log: ReviewLog) => void;
}) {
  const grouped = useMemo(() => {
    const m = new Map<
      string,
      {
        contactId: string;
        contact: ReviewLog["contact"];
        logs: ReviewLog[];
        latestAt: string;
      }
    >();
    for (const l of logs) {
      if (!l.contact_id) continue;
      const g = m.get(l.contact_id);
      if (g) {
        g.logs.push(l);
        if (l.created_at > g.latestAt) g.latestAt = l.created_at;
      } else {
        m.set(l.contact_id, {
          contactId: l.contact_id,
          contact: l.contact,
          logs: [l],
          latestAt: l.created_at,
        });
      }
    }
    return Array.from(m.values()).sort((a, b) =>
      b.latestAt.localeCompare(a.latestAt),
    );
  }, [logs]);

  const [openContactId, setOpenContactId] = useState<string | null>(null);
  // Auto-select the first contact when the list loads / changes.
  useEffect(() => {
    if (grouped.length === 0) {
      setOpenContactId(null);
      return;
    }
    setOpenContactId((cur) => {
      if (cur && grouped.some((g) => g.contactId === cur)) return cur;
      return grouped[0].contactId;
    });
  }, [grouped]);

  const openGroup =
    grouped.find((g) => g.contactId === openContactId) ?? null;

  return (
    <div>
      <div className="mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">
        Training{selectedRow ? ` ${labelOf(selectedRow)}` : ""} · {grouped.length}{" "}
        contact{grouped.length === 1 ? "" : "s"} · {logs.length} reply
        {logs.length === 1 ? "" : "s"} waiting
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Left: contact list */}
        <aside className="space-y-1.5 lg:max-h-[calc(100vh-280px)] lg:overflow-y-auto lg:pr-1">
          {grouped.map((g) => {
            const active = g.contactId === openContactId;
            return (
              <button
                key={g.contactId}
                type="button"
                onClick={() => setOpenContactId(g.contactId)}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition",
                  active
                    ? "border-emerald-400 bg-gradient-to-br from-emerald-50 via-white to-white shadow-sm shadow-emerald-100"
                    : "border-input bg-card hover:-translate-y-px hover:border-emerald-200 hover:bg-emerald-50/30 hover:shadow-sm",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ring-1 ring-inset",
                    active
                      ? "bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800 ring-emerald-300"
                      : "bg-secondary text-muted-foreground ring-border",
                  )}
                >
                  {g.contact ? initialsOf(g.contact.display) : "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold leading-tight">
                    {g.contact?.display ?? "Unknown"}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground tabular-nums">
                    {new Date(g.latestAt).toLocaleString()}
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                    active
                      ? "bg-emerald-600 text-white"
                      : "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200",
                  )}
                >
                  {g.logs.length}
                </span>
              </button>
            );
          })}
        </aside>

        {/* Right: replies for selected contact */}
        <div className="min-w-0 space-y-3">
          {openGroup ? (
            openGroup.logs.map((l) => (
              <ReviewRow
                key={l.id}
                log={l}
                busy={busyId === l.id}
                correcting={correctingId === l.id}
                correction={corrections[l.id] ?? ""}
                onCorrection={(v) =>
                  setCorrections((m) => ({ ...m, [l.id]: v }))
                }
                onCancelCorrection={() => setCorrectingId(null)}
                onSaveCorrection={() => onSaveCorrection(l)}
                onRate={(r) => void onRate(l.id, r)}
              />
            ))
          ) : (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              Pick a contact from the left to see their pending replies.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Browser-native speech recognition (Web Speech API). Available in
// Chrome / Edge / Safari; unsupported in Firefox. When unsupported we
// just hide the mic button — the textarea still works for typing.
function useSpeechRecognition(lang = "hi-IN") {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<unknown>(null);
  const targetRef = useRef<{ onText: (text: string) => void } | null>(null);
  const baselineRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      SpeechRecognition?: new () => unknown;
      webkitSpeechRecognition?: new () => unknown;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) return;
    setSupported(true);
    const r = new SR() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: (e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void;
      onend: () => void;
      onerror: () => void;
      start: () => void;
      stop: () => void;
    };
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const t = result[0]?.transcript ?? "";
        if (result.isFinal) final += t;
        else interim += t;
      }
      if (final) {
        baselineRef.current = (baselineRef.current + " " + final).trim();
      }
      const combined = (
        baselineRef.current + (interim ? " " + interim : "")
      ).trim();
      targetRef.current?.onText(combined);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r;
    return () => {
      try {
        r.stop();
      } catch {
        /* idempotent */
      }
    };
  }, [lang]);

  function start(seed: string, onText: (text: string) => void) {
    const r = recRef.current as { start: () => void } | null;
    if (!r) return;
    baselineRef.current = seed ?? "";
    targetRef.current = { onText };
    try {
      r.start();
      setListening(true);
    } catch {
      /* already started — toggle off */
      stop();
    }
  }
  function stop() {
    const r = recRef.current as { stop: () => void } | null;
    try {
      r?.stop();
    } catch {
      /* no-op */
    }
    setListening(false);
  }
  return { supported, listening, start, stop };
}

function ReviewRow({
  log,
  busy,
  correcting,
  correction,
  onCorrection,
  onCancelCorrection,
  onSaveCorrection,
  onRate,
}: {
  log: ReviewLog;
  busy: boolean;
  correcting: boolean;
  correction: string;
  onCorrection: (v: string) => void;
  onCancelCorrection: () => void;
  onSaveCorrection: () => void;
  onRate: (r: "good" | "needs_review" | "wrong") => void;
}) {
  const inbound = log.trigger_inbound;
  const inboundText =
    inbound?.content?.trim() ||
    (inbound ? `[${inbound.type}]` : "(no recent inbound)");
  const speech = useSpeechRecognition("hi-IN");
  const toggleMic = () => {
    if (speech.listening) speech.stop();
    else speech.start(correction, onCorrection);
  };
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-[11px] font-bold text-muted-foreground">
            {log.contact ? initialsOf(log.contact.display) : "?"}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {log.contact?.display ?? "Unknown"}
            </div>
            <div className="text-[10.5px] text-muted-foreground tabular-nums">
              {new Date(log.created_at).toLocaleString()}
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-2 text-[13px]">
        <div className="rounded-lg border-l-4 border-l-slate-300 bg-secondary/40 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Patient said
          </div>
          <p className="mt-0.5 whitespace-pre-wrap leading-snug">{inboundText}</p>
        </div>
        <div className="rounded-lg border-l-4 border-l-emerald-400 bg-emerald-50/40 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
            Bot replied
          </div>
          <p className="mt-0.5 whitespace-pre-wrap leading-snug">
            {log.cleaned_output?.trim() || (
              <span className="italic text-muted-foreground">(empty reply)</span>
            )}
          </p>
        </div>
      </div>

      {correcting ? (
        // "Wrong" was clicked — operator types (or speaks) what the
        // bot SHOULD have said. On save we POST a knowledge chunk so
        // the RAG retriever surfaces this exact answer next time a
        // similar message comes.
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/50 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-800">
              <XCircle className="h-3.5 w-3.5" />
              What should the bot have said?
            </div>
            {speech.supported ? (
              <button
                type="button"
                onClick={toggleMic}
                disabled={busy}
                aria-pressed={speech.listening}
                title={speech.listening ? "Stop dictation" : "Dictate the reply"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-semibold transition",
                  speech.listening
                    ? "bg-rose-600 text-white shadow-md ring-2 ring-rose-300 animate-pulse"
                    : "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50",
                )}
              >
                {speech.listening ? (
                  <>
                    <MicOff className="h-3 w-3" /> Stop
                  </>
                ) : (
                  <>
                    <Mic className="h-3 w-3" /> Speak
                  </>
                )}
              </button>
            ) : null}
          </div>
          <textarea
            value={correction}
            onChange={(e) => onCorrection(e.target.value)}
            disabled={busy}
            rows={4}
            autoFocus
            placeholder={
              speech.supported
                ? "Type or tap Speak to dictate the correct reply…"
                : "Type the correct reply exactly as you'd want the bot to send it…"
            }
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-200"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[10.5px] leading-snug text-rose-900/80">
              Saved as a knowledge chunk under <strong>Past correction</strong>{" "}
              — the bot will use it (via RAG) when a similar message arrives.
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  speech.stop();
                  onCancelCorrection();
                }}
                disabled={busy}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  speech.stop();
                  onSaveCorrection();
                }}
                disabled={busy || !correction.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Save correction
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onRate("good")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Good
          </button>
          <button
            type="button"
            onClick={() => onRate("needs_review")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            Review
          </button>
          <button
            type="button"
            onClick={() => onRate("wrong")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            <XCircle className="h-3.5 w-3.5" />
            Wrong
          </button>
        </div>
      )}
    </article>
  );
}
