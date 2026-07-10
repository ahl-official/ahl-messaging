"use client";

// "Suggested reply" widget body in the contact-details panel. One click
// on a language button POSTs the conversation to
// /api/contacts/[id]/reply-suggestion and renders a ready-to-send draft
// tuned to move the client toward booking. Agent copies it into the
// composer. The system prompt is editable in Settings → AI.

import { useState } from "react";
import { Check, Copy, Loader2, RefreshCcw, Sparkles } from "lucide-react";

type Lang = "english" | "hinglish";

export function ReplySuggestionWidget({ contactId }: { contactId: string }) {
  const [reply, setReply] = useState<string | null>(null);
  const [loading, setLoading] = useState<Lang | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate(language: Lang) {
    setLoading(language);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/contacts/${contactId}/reply-suggestion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
      });
      const j = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setReply((j.reply ?? "").trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to suggest a reply");
    } finally {
      setLoading(null);
    }
  }

  async function copy() {
    if (!reply) return;
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — text is still selectable */
    }
  }

  if (loading) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Thinking of the best reply…
        </div>
        <div className="space-y-2">
          {[95, 88, 70].map((w, i) => (
            <span
              key={i}
              className="block h-2.5 rounded bg-secondary"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (reply) {
    return (
      <div className="space-y-2.5">
        <div className="rounded-xl border border-primary/20 bg-gradient-to-b from-primary/10 to-transparent p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {reply}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-primary/90"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy reply"}
          </button>
          <span className="mx-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Redo
          </span>
          <button
            type="button"
            onClick={() => generate("english")}
            className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-primary/15"
          >
            English
          </button>
          <button
            type="button"
            onClick={() => generate("hinglish")}
            className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-primary/15"
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
          AI reads the whole chat and drafts the best next message — written
          to move the client toward booking. Then copy &amp; send.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => generate("english")}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-primary/90 active:scale-[0.98]"
        >
          <Sparkles className="h-3.5 w-3.5" />
          English
        </button>
        <button
          type="button"
          onClick={() => generate("hinglish")}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary transition hover:bg-primary/15 active:scale-[0.98]"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Hinglish
        </button>
      </div>
    </div>
  );
}
