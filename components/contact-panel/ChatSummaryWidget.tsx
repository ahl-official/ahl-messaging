"use client";

// "AI Summary" widget body in the contact-details panel. One click on a
// language button POSTs the whole conversation to
// /api/contacts/[id]/summary and renders the model's bullet summary.
// No two-step flow — the language IS the generate action. The system
// prompt behind it is editable in Settings → AI.

import { useState } from "react";
import { Loader2, RefreshCcw, Sparkles } from "lucide-react";

type Lang = "english" | "hinglish";

export function ChatSummaryWidget({ contactId }: { contactId: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState<Lang | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(language: Lang) {
    setLoading(language);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
      });
      const j = (await res.json()) as { summary?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSummary((j.summary ?? "").trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to summarise");
    } finally {
      setLoading(null);
    }
  }

  // Loading — gentle shimmer that mirrors the bullet layout.
  if (loading) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-violet-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the conversation…
        </div>
        <div className="space-y-2">
          {[90, 75, 82, 60].map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-1 w-1 shrink-0 rounded-full bg-violet-200" />
              <span
                className="h-2.5 rounded bg-secondary"
                style={{ width: `${w}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (summary) {
    const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
    return (
      <div className="rounded-xl border border-violet-100 bg-gradient-to-b from-violet-50/60 to-transparent p-3">
        <ul className="space-y-2">
          {lines.map((line, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-violet-500" />
              <span>{line.replace(/^[-*•]\s*/, "")}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-1.5 border-t border-violet-100 pt-2.5">
          <RefreshCcw className="h-3 w-3 text-muted-foreground" />
          <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Redo
          </span>
          <button
            type="button"
            onClick={() => generate("english")}
            className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-100"
          >
            English
          </button>
          <button
            type="button"
            onClick={() => generate("hinglish")}
            className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-100"
          >
            Hinglish
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-[11px] text-rose-700 ring-1 ring-inset ring-rose-200">
          {error}
        </div>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Instant AI recap of the whole conversation — what the patient
          wants, what was promised, and the next step.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => generate("english")}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-700 active:scale-[0.98]"
        >
          <Sparkles className="h-3.5 w-3.5" />
          English
        </button>
        <button
          type="button"
          onClick={() => generate("hinglish")}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 transition hover:bg-violet-100 active:scale-[0.98]"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Hinglish
        </button>
      </div>
    </div>
  );
}
