"use client";

// ✨ button that lives on a textarea field. Click → modal asks the
// operator to describe what they want → calls /api/ai-assist with
// the field's `kind` so the model knows the format constraints →
// drops the result into the field. Used on Persona, Image system
// prompt, Transcription context, RAG core prompt, and individual
// RAG chunk editors.

import { useState } from "react";
import { Loader2, Sparkles, Wand2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type AssistKind =
  | "persona"
  | "image_system_prompt"
  | "transcription_prompt"
  | "rag_core_prompt"
  | "knowledge_chunk"
  | "magic_campaign_brief";

interface Props {
  kind: AssistKind;
  /** Current textarea value — passed to the API so the model can
   *  rewrite / extend rather than start from scratch. */
  value: string;
  /** Receive the generated text. The caller decides how to apply it
   *  (replace vs. append) — usually replace. */
  onApply: (text: string) => void;
  /** Optional business context blurb (e.g. "QHT Salon, hair services").
   *  Helps the model write specific copy instead of generic filler. */
  context?: string;
  /** Optional className for the trigger button so callers can pin it
   *  in the corner of their textarea. */
  className?: string;
  /** Compact (icon-only) for tight spaces vs. label trigger. */
  compact?: boolean;
}

const PRESETS: Record<AssistKind, { title: string; placeholder: string; defaults: string[] }> = {
  persona: {
    title: "Generate persona",
    placeholder: "e.g. Hindi-speaking hair-service counselor for QHT Salon. Always asks for photos before quoting prices. Never reveals it's an AI. Reply <150 words.",
    defaults: [
      "Make it warmer and more conversational",
      "Add a hard rule to never give medical advice",
      "Mention WhatsApp call permission flow",
    ],
  },
  image_system_prompt: {
    title: "Generate image-mode prompt",
    placeholder: "e.g. When client sends scalp photos, acknowledge, ask for front/top/side angles, set expectation that doctor will call.",
    defaults: [
      "Standard scalp-photo handling for hair salon",
      "Skin-condition photos for dermatology salon",
    ],
  },
  transcription_prompt: {
    title: "Generate transcription context",
    placeholder: "e.g. Hair-service consultation calls in Hindi+English. Common terms: service, FUE, DHT, telogen, donor area.",
    defaults: [
      "Hair-service consultations in Hinglish",
      "Skin-salon consultations with dermatology terms",
    ],
  },
  rag_core_prompt: {
    title: "Generate RAG core prompt",
    placeholder: "e.g. QHT Salon hair counselor. Hinglish. Use only RELEVANT KNOWLEDGE chunks. <150 words. Escalate to human when user mentions emergency.",
    defaults: [
      "Short hair-salon counselor that relies on knowledge base",
      "Customer-support agent that never invents pricing",
    ],
  },
  knowledge_chunk: {
    title: "Generate knowledge chunk",
    placeholder: "e.g. Pricing block — hair service starts ₹65k for 1500 services, photo review required, includes 1 follow-up call.",
    defaults: [
      "Pricing for hair service procedures",
      "Refund + cancellation policy",
      "Operating hours + salon locations",
    ],
  },
  magic_campaign_brief: {
    title: "Generate campaign brief",
    placeholder: "e.g. Re-engage clients who stopped replying 30+ days ago. Mention we have new monsoon offer slots. Ask them to reply YES to book. Use {{name}} to greet them.",
    defaults: [
      "Follow-up reminder for clients with upcoming appointments",
      "Re-engage clients who went silent on the consultation flow",
      "Diwali / festival offer announcement (no exact prices)",
      "Photo request — ask for front/top/side scalp shots",
      "Post-procedure check-in (1 week after)",
    ],
  },
};

export function AiAssistButton({
  kind,
  value,
  onApply,
  context,
  className,
  compact,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-100",
          className,
        )}
        title="Generate with AI"
      >
        <Sparkles className="h-3 w-3" />
        {compact ? null : "AI generate"}
      </button>
      {open ? (
        <AssistModal
          kind={kind}
          existing={value}
          context={context}
          onClose={() => setOpen(false)}
          onApply={(text) => {
            onApply(text);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function AssistModal({
  kind,
  existing,
  context,
  onClose,
  onApply,
}: {
  kind: AssistKind;
  existing: string;
  context?: string;
  onClose: () => void;
  onApply: (text: string) => void;
}) {
  const preset = PRESETS[kind];
  const [instruction, setInstruction] = useState("");
  const [generated, setGenerated] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ prompt_tokens?: number; completion_tokens?: number } | null>(null);

  async function generate() {
    if (!instruction.trim()) {
      setErr("Tell the model what you want");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          instruction,
          existing,
          context,
        }),
      });
      const json = (await res.json()) as {
        text?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setGenerated(json.text ?? "");
      setUsage(json.usage ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b bg-gradient-to-br from-violet-50 to-background px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
              <Wand2 className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">{preset.title}</h3>
              <p className="text-[11px] text-muted-foreground">
                Tell the model what you want. It rewrites the field for you.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              What should this say?
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value.slice(0, 4000))}
              rows={4}
              autoFocus
              placeholder={preset.placeholder}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {preset.defaults.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setInstruction(d)}
                  className="rounded-full border bg-background px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {existing && existing.trim().length > 0 ? (
            <div className="rounded-md border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
              The current text in the field will be passed as context. Tell
              the model to <strong>rewrite</strong> or <strong>extend</strong> it
              instead of starting from scratch.
            </div>
          ) : null}

          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          ) : null}

          {generated ? (
            <div className="rounded-lg border bg-violet-50/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                  Generated preview
                </span>
                {usage ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {usage.prompt_tokens ?? 0}p / {usage.completion_tokens ?? 0}c tokens
                  </span>
                ) : null}
              </div>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground/90">
                {generated}
              </pre>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          {generated ? (
            <button
              type="button"
              onClick={() => setGenerated("")}
              className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
            >
              Regenerate
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          {generated ? (
            <button
              type="button"
              onClick={() => onApply(generated)}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-700"
            >
              <Sparkles className="h-3 w-3" />
              Apply to field
            </button>
          ) : (
            <button
              type="button"
              onClick={generate}
              disabled={loading || !instruction.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
              Generate
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
