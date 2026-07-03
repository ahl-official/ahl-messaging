"use client";

// Settings → AI. Each block is fully self-contained — its own editor,
// Default reset, and Save button — so a prompt can be tuned and saved
// without touching the others. Adding a future AI prompt = drop in one
// more <PromptCard> with its own fieldKey; nothing else changes.
//
//   • Chat summary     — drives the "AI Summary" widget.
//   • Reply suggestion — drives the "Suggested reply" widget.
//   • Package Shared   — drives the "Package Shared" section (CRM notes).
//   • Output language  — language the package extract is written in.

import { useCallback, useEffect, useState } from "react";
import {
  CalendarCheck,
  FileText,
  Loader2,
  MessageSquareReply,
  Package,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { cn } from "@/lib/utils";

interface PromptPair {
  prompt: string;
  default: string;
}

type Lang = "english" | "hindi" | "hinglish";
type PromptField = "summary" | "reply" | "package";

const LANGS: Array<{ key: Lang; label: string }> = [
  { key: "english", label: "English" },
  { key: "hindi", label: "Hindi" },
  { key: "hinglish", label: "Hinglish" },
];

/** Save one field on its own — the PUT route takes partial bodies. */
async function saveField(body: Record<string, string>): Promise<void> {
  const res = await fetch("/api/settings/ai-prompts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
}

export function AiSettingsView() {
  const [data, setData] = useState<{
    summary: PromptPair;
    reply: PromptPair;
    package: PromptPair;
    language: Lang;
    booking_template: { name: string; lang: string };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/ai-prompts", { cache: "no-store" });
      const j = (await res.json()) as {
        summary?: PromptPair;
        reply?: PromptPair;
        package?: PromptPair;
        language?: Lang;
        booking_template?: { name: string; lang: string };
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setData({
        summary: j.summary ?? { prompt: "", default: "" },
        reply: j.reply ?? { prompt: "", default: "" },
        package: j.package ?? { prompt: "", default: "" },
        language: j.language ?? "english",
        booking_template: j.booking_template ?? { name: "", lang: "en_US" },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Sub-tab — one AI area at a time (like Settings → Team's Members /
  // Groups / Login activity strip). Future AI areas: add a SUB_TABS row.
  const [tab, setTab] = useState<"summary" | "reply" | "package" | "booking">(
    "summary",
  );
  const SUB_TABS = [
    { key: "summary" as const, label: "Chat summary", icon: FileText },
    { key: "reply" as const, label: "Reply suggestion", icon: MessageSquareReply },
    { key: "package" as const, label: "Package Shared", icon: Package },
    { key: "booking" as const, label: "Booking confirm", icon: CalendarCheck },
  ];

  return (
    <div>
      <SettingsPageHeader
        icon={Sparkles}
        title="AI"
        subtitle="Tune what the AI is told inside the dashboard."
        tone="violet"
      />

      {/* Sub-tab strip */}
      <div className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-1 px-6 py-2">
          {SUB_TABS.map((s) => {
            const active = tab === s.key;
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setTab(s.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  active
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-6">
        {loading ? (
          <div className="grid h-40 place-items-center text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </span>
          </div>
        ) : error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        ) : data ? (
          // All cards stay mounted (hidden when inactive) so unsaved
          // edits survive a sub-tab switch.
          <>
            <div className={tab === "summary" ? "" : "hidden"}>
              <PromptCard
                field="summary"
                title="Chat summary prompt"
                hint="What the AI follows when an agent clicks “AI Summary” on a chat. The conversation transcript is sent right after this prompt."
                initial={data.summary.prompt}
                fallback={data.summary.default}
              />
            </div>
            <div className={tab === "reply" ? "" : "hidden"}>
              <PromptCard
                field="reply"
                title="Reply suggestion prompt"
                hint="What the AI follows when an agent clicks “Suggested reply”. It analyses the chat and drafts the next message — tuned to move the client toward booking."
                initial={data.reply.prompt}
                fallback={data.reply.default}
              />
            </div>
            {/* Package Shared — prompt + the output language it uses. */}
            <div
              className={cn(
                "space-y-5",
                tab === "package" ? "" : "hidden",
              )}
            >
              <PromptCard
                field="package"
                title="Package Shared prompt"
                hint="What the AI follows for the “Package Shared” section. It reads the CRM lead notes and pulls out only the package quoted to the client."
                initial={data.package.prompt}
                fallback={data.package.default}
              />
              <LanguageCard initial={data.language} />
            </div>
            <div className={tab === "booking" ? "" : "hidden"}>
              <BookingTemplateCard
                initialName={data.booking_template.name}
                initialLang={data.booking_template.lang}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Self-contained prompt block — own editor, Default, Save ──────────
function PromptCard({
  field,
  title,
  hint,
  initial,
  fallback,
}: {
  field: PromptField;
  title: string;
  hint: string;
  initial: string;
  fallback: string;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveField({ [field]: value });
      setSaved(value);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 max-w-xl text-[11px] text-muted-foreground">
            {hint}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setValue(fallback)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Default
        </button>
      </div>
      <div className="p-5">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={12}
          maxLength={8000}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
            {value.length}/8000
          </span>
          <div className="flex items-center gap-3">
            {error ? (
              <span className="text-xs text-rose-600">{error}</span>
            ) : savedAt && !dirty ? (
              <span className="text-xs text-emerald-600">Saved</span>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Self-contained output-language block ─────────────────────────────
function LanguageCard({ initial }: { initial: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const [saved, setSaved] = useState<Lang>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = lang !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveField({ language: lang });
      setSaved(lang);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Output language</h2>
        <p className="mt-0.5 max-w-xl text-[11px] text-muted-foreground">
          Language the AI writes the “Package Shared” summary in. Switch
          any time — no prompt editing needed.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex gap-1.5">
          {LANGS.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => setLang(l.key)}
              className={cn(
                "rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition",
                lang === l.key
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : "border-input bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {error ? (
            <span className="text-xs text-rose-600">{error}</span>
          ) : savedAt && !dirty ? (
            <span className="text-xs text-emerald-600">Saved</span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Booking confirmation template — name + language an owner can change ──
// When a name is set, a confirmed booking is delivered as that WhatsApp
// UTILITY template ({{1}}=client name, {{2}}=date). Clearing the name
// falls back to a plain text message (inside the 24h window only).
function BookingTemplateCard({
  initialName,
  initialLang,
}: {
  initialName: string;
  initialLang: string;
}) {
  const [name, setName] = useState(initialName);
  const [lang, setLang] = useState(initialLang);
  const [savedName, setSavedName] = useState(initialName);
  const [savedLang, setSavedLang] = useState(initialLang);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== savedName || lang !== savedLang;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveField({
        booking_template_name: name,
        booking_template_lang: lang || "en_US",
      });
      setSavedName(name);
      setSavedLang(lang);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Booking confirmation template</h2>
        <p className="mt-0.5 max-w-xl text-[11px] text-muted-foreground">
          When set, a confirmed Date Align booking is delivered as this approved
          WhatsApp UTILITY template — {"{{1}}"} = client name, {"{{2}}"} = date.
          Leave the name blank to send a plain text message instead.
        </p>
      </div>
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              Template name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="booking_confirmation"
              className="w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Exact name from Meta — lowercase, numbers, underscores only.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              Language code
            </label>
            <input
              type="text"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              placeholder="en_US"
              className="w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Must match the template’s language.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3">
          {error ? (
            <span className="text-xs text-rose-600">{error}</span>
          ) : savedAt && !dirty ? (
            <span className="text-xs text-emerald-600">Saved</span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
