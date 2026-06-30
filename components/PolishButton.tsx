"use client";

// Hinglish → professional English. Sends the current draft through the AI
// (POST /api/spell-correct with mode="professional") and hands the rewritten
// text back via onResult so the operator can review, copy, or send it.
// Two looks: "icon" for the composer toolbar, "chip" for the Magic Message
// dialog (next to "Suggest reply").

import { useState } from "react";
import { Languages, Loader2 } from "lucide-react";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";
import { cn } from "@/lib/utils";

export function PolishButton({
  text,
  onResult,
  disabled,
  variant = "icon",
}: {
  text: string;
  onResult: (text: string) => void;
  disabled?: boolean;
  variant?: "icon" | "chip";
}) {
  const [loading, setLoading] = useState(false);

  async function go() {
    const t = text.trim();
    if (!t || loading || disabled) return;
    setLoading(true);
    try {
      const res = await fetch("/api/spell-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, mode: "professional" }),
      });
      const j = (await res.json()) as { text?: string };
      if (res.ok && j.text) onResult(j.text);
    } catch {
      /* silent — operator can re-trigger */
    } finally {
      setLoading(false);
    }
  }

  if (variant === "chip") {
    return (
      <button
        type="button"
        onClick={go}
        disabled={disabled || loading || !text.trim()}
        title="Rewrite in professional English"
        className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-100 disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Languages className="h-3.5 w-3.5" />
        )}
        To English
      </button>
    );
  }

  return (
    <ComposerIconButton
      icon={loading ? Loader2 : Languages}
      label={loading ? "Translating…" : "Rewrite in professional English"}
      disabled={disabled || loading || !text.trim()}
      onClick={go}
      className={cn(loading && "[&_svg]:animate-spin")}
    />
  );
}
