"use client";

// One-click "Suggest reply" button. Calls /api/contacts/[id]/reply-
// suggestion and hands the drafted message back via onPick — the caller
// drops it into whatever textarea it owns (the composer, Magic Message,
// etc.). Language is "auto" — the draft mirrors the client.

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function SuggestReplyButton({
  contactId,
  onPick,
  disabled,
  variant = "icon",
}: {
  contactId: string;
  onPick: (text: string) => void;
  disabled?: boolean;
  /** "icon" — composer toolbar; "chip" — labelled pill (Magic Message). */
  variant?: "icon" | "chip";
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function go() {
    if (loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(
        `/api/contacts/${contactId}/reply-suggestion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: "auto" }),
        },
      );
      const j = (await res.json()) as { reply?: string };
      if (res.ok && typeof j.reply === "string" && j.reply.trim()) {
        onPick(j.reply.trim());
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (variant === "chip") {
    return (
      <button
        type="button"
        onClick={go}
        disabled={disabled || loading}
        title="Draft a reply with AI"
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        Suggest reply
      </button>
    );
  }

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={go}
        disabled={disabled || loading}
        aria-label="Suggested by AI"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-emerald-600 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </button>
      <span
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap",
          "rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background shadow-md",
          "opacity-0 transition-opacity group-hover:opacity-100",
        )}
      >
        {error ? "Couldn't suggest — retry" : "Suggested by AI"}
      </span>
    </span>
  );
}
