"use client";

// Voice / audio bubble renderer. The default <audio controls> looked
// busted on dark chat backgrounds (huge grey strip). This wrapper
// gives it a clinic-themed shell + an inline "Show transcript" toggle
// that loads the cached transcript (or kicks one off) so the operator
// can read what the patient said without listening.

import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Mic, Sparkles } from "lucide-react";

interface Props {
  messageId: string;
  url: string;
  caption: string | null;
}

interface TranscriptResp {
  ok?: boolean;
  transcript?: string | null;
  cached?: boolean;
  error?: string;
}

export function AudioBubble({ messageId, url, caption }: Props) {
  const [transcript, setTranscript] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the cached transcript on mount (cheap GET — server returns
  // null when nothing's cached and never invokes Whisper). Lets the
  // operator see the toggle as "Show transcript" instantly when one
  // exists from the inbound auto-transcribe pass.
  // Optimistic bubbles use a temporary `tmp-…` id — there's no DB row yet,
  // so skip the transcript fetch (it would 500 on the non-UUID id).
  const isOptimistic = messageId.startsWith("tmp-");
  useEffect(() => {
    if (isOptimistic) return;
    let cancelled = false;
    void fetch(`/api/messages/${messageId}/transcribe`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: TranscriptResp) => {
        if (cancelled) return;
        if (j.transcript) setTranscript(j.transcript);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [messageId, isOptimistic]);

  const transcribeNow = async () => {
    if (isOptimistic) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${messageId}/transcribe`, {
        method: "POST",
      });
      const json = (await res.json()) as TranscriptResp;
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setTranscript(json.transcript ?? "");
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcribe failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-[320px] max-w-full space-y-1.5 sm:w-[360px]">
      <div className="flex items-center gap-2 rounded-md bg-foreground/5 px-2 py-2 ring-1 ring-inset ring-border">
        <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
        <audio
          src={url}
          controls
          preload="metadata"
          className="h-8 min-w-0 flex-1"
          style={{ width: "100%" }}
        />
      </div>
      {caption ? (
        <p className="whitespace-pre-wrap break-words text-sm">{caption}</p>
      ) : null}
      <div className="flex items-center gap-2">
        {transcript ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={
                "h-3 w-3 transition-transform " + (open ? "rotate-180" : "")
              }
            />
            {open ? "Hide" : "Show"} transcript
          </button>
        ) : (
          <button
            type="button"
            onClick={transcribeNow}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {loading ? "Transcribing…" : "Transcribe"}
          </button>
        )}
        {error ? (
          <span className="text-[10px] text-destructive">{error}</span>
        ) : null}
      </div>
      {open && transcript ? (
        <div className="rounded-md bg-foreground/5 px-2.5 py-1.5 text-[12px] italic text-foreground/80 ring-1 ring-inset ring-border">
          {transcript || <span className="opacity-60">(no speech detected)</span>}
        </div>
      ) : null}
    </div>
  );
}
