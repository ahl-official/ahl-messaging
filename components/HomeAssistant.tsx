"use client";

// In-app AI assistant that lives on the home page. The operator can
// ask questions about their WhatsApp data ("how many unread?", "last
// message from Naveen", "messages this week"); the server-side tools
// fetch the answer from Supabase under the operator's permission
// scope.
//
// Two input modes:
//   - Text: standard chat composer.
//   - Voice: hold-to-record (MediaRecorder) → POST to /transcribe →
//     paste transcript into the input and auto-send. Whisper handles
//     mixed Hindi/Hinglish far better than browser SpeechRecognition.
//
// Optional response TTS: when the speaker toggle is on, each assistant
// reply is spoken aloud via the browser's native SpeechSynthesis. We
// keep TTS browser-side (free, instant) — STT is the part where
// accuracy matters, so that goes through Whisper.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Mic,
  Send,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AssistantAvatar } from "@/components/AssistantAvatar";
import { emitFabClose, emitFabOpen, useFabsFlat } from "@/lib/fab-layout";
import {
  dockHideClasses,
  useFloatingDock,
} from "@/components/FloatingDockToggle";
import { AssistantMarkdown } from "@/components/AssistantMarkdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "qht:home-assistant:history";
const MAX_HISTORY = 40;

const SAMPLE_PROMPTS = [
  "Aaj kitne unread chats hain?",
  "Last 7 days me kitne messages aaye?",
  "Naveen ka latest message kya hai?",
  "Which number has the most unread?",
];

export function HomeAssistant() {
  const [messages, setMessages] = useState<Msg[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  // Closed by default — the floating avatar button (FAB) acts as the
  // entry point. Click to open the chat popover above it.
  const [open, setOpen] = useState(false);
  const flat = useFabsFlat();
  const { collapsed: dockCollapsed, mounted: dockMounted } = useFloatingDock();
  useEffect(() => {
    if (open) emitFabOpen("ai");
    else emitFabClose("ai");
    return () => emitFabClose("ai");
  }, [open]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click outside the panel closes it (mirrors the notifications
  // dropdown behaviour so the two floating UIs feel consistent).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (
        e.target instanceof Node &&
        containerRef.current.contains(e.target)
      ) {
        return;
      }
      // Keep open while a recording session is live — otherwise an
      // accidental outside click would silently drop the mic + lose
      // the in-progress utterance.
      if (recording) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, recording]);

  // Persist + auto-scroll on new messages.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(messages.slice(-MAX_HISTORY)),
      );
    } catch {
      /* localStorage full / disabled — chat still works in memory */
    }
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError(null);
      const next: Msg[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      setInput("");
      setBusy(true);
      try {
        const res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Keep the wire payload lean — last 16 turns is enough
            // context for follow-ups without bloating tokens.
            messages: next.slice(-16),
          }),
        });
        const j = await safeJson<{ reply?: string; error?: string }>(res);
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        const reply = (j.reply ?? "").trim();
        if (!reply) throw new Error("Empty reply from assistant.");
        setMessages((cur) => [...cur, { role: "assistant", content: reply }]);
        if (speakReplies) void speak(reply);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Assistant failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, speakReplies],
  );

  // ---- voice input -------------------------------------------------

  const startRecording = useCallback(async () => {
    if (recording || transcribing || busy) return;
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Voice not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The browser picks the codec; on Chrome that's webm/opus, on
      // Safari it's mp4/aac. Whisper accepts both.
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        // Always stop the underlying tracks so the browser's mic
        // indicator disappears.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", blob, "voice.webm");
          const res = await fetch("/api/assistant/transcribe", {
            method: "POST",
            body: form,
          });
          const j = await safeJson<{ text?: string; error?: string }>(res);
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          const text = (j.text ?? "").trim();
          if (text) {
            // Auto-send the transcribed message — voice mode UX should
            // feel hands-free; no extra click to confirm.
            await send(text);
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Transcription failed");
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mic permission denied");
    }
  }, [busy, recording, transcribing, send]);

  const stopRecording = useCallback(() => {
    if (!recording) return;
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, [recording]);

  const clearHistory = useCallback(() => {
    if (messages.length === 0) return;
    if (!confirm("Clear assistant chat history?")) return;
    setMessages([]);
    setError(null);
  }, [messages.length]);

  return (
    <div
      ref={containerRef}
      // Two layouts driven by `useFabsFlat()`:
      //   • idle (nothing open)   → stacked above the bell (bottom-24)
      //   • any FAB open (flat)   → flattens to a row at the bottom
      //                              alongside the bell (right-24)
      className={cn(
        "fixed z-[55] hidden md:block transition-all duration-300 ease-out",
        flat ? "bottom-5 right-24" : "bottom-24 right-5",
        dockHideClasses(dockCollapsed, dockMounted),
      )}
    >
      {open ? (
        <div className="relative mb-3 w-[22rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-border">
          {/* Decorative gradient glow that bleeds through the header. */}
          <span
            aria-hidden
            className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-emerald-300/40 via-teal-300/30 to-transparent blur-3xl"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-10 h-44 w-44 rounded-full bg-gradient-to-bl from-sky-300/25 via-indigo-300/15 to-transparent blur-3xl"
          />
          <header className="relative flex items-center justify-between gap-3 border-b border-border/60 bg-gradient-to-r from-emerald-50/40 via-transparent to-sky-50/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <AssistantAvatar busy={busy || transcribing} listening={recording} />
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <span className="bg-gradient-to-br from-emerald-700 via-teal-700 to-sky-700 bg-clip-text text-transparent">
                Assistant
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-emerald-100 to-sky-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-inset ring-emerald-200/60">
                <Sparkles className="h-2.5 w-2.5" />
                AI
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Apne data ke baare mein puch lo — chats, reports, actions, sab kuch.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSpeakReplies((v) => !v)}
            title={speakReplies ? "Mute assistant voice" : "Speak responses"}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground",
              speakReplies && "bg-emerald-50 text-emerald-700",
            )}
          >
            {speakReplies ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
          </button>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={clearHistory}
              title="Clear chat"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="max-h-[26rem] min-h-[12rem] space-y-2.5 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 ? (
          <div className="space-y-2.5">
            <p className="text-xs text-muted-foreground">
              Try one of these to get started:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  className="inline-flex rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 transition hover:bg-brand-100"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, idx) => (
            <div
              key={idx}
              className={cn(
                "flex",
                m.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-snug shadow-sm",
                  m.role === "user"
                    ? "whitespace-pre-wrap rounded-br-sm bg-gradient-to-br from-emerald-700 to-teal-700 text-white"
                    : "rounded-bl-sm bg-secondary text-foreground",
                )}
              >
                {m.role === "assistant" ? (
                  <AssistantMarkdown text={m.content} />
                ) : (
                  m.content
                )}
              </div>
            </div>
          ))
        )}
        {busy ? (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-sm bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Thinking…
            </div>
          </div>
        ) : null}
        {transcribing ? (
          <div className="flex justify-end">
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-br-sm bg-brand-50 px-3 py-2 text-xs text-brand-700 ring-1 ring-brand-200">
              <Loader2 className="h-3 w-3 animate-spin" />
              Transcribing voice…
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
            {error}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-center gap-2 border-t bg-card/50 px-3 py-2.5"
      >
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={busy || transcribing}
          title={recording ? "Stop & send" : "Record voice"}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
            recording
              ? "bg-rose-600 text-white shadow-md hover:bg-rose-700"
              : "bg-secondary text-foreground hover:bg-secondary/80",
            (busy || transcribing) && "cursor-not-allowed opacity-50",
          )}
        >
          {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            recording
              ? "Listening… click stop to send"
              : "Ask anything about your inbox…"
          }
          disabled={recording || busy || transcribing}
          className="h-9 flex-1 rounded-full border border-input bg-background px-3.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || recording || transcribing || !input.trim()}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-50",
          )}
          title="Send"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </form>
        </div>
      ) : null}

      {/* The FAB itself — circular, just the glowing avatar. Click to
          toggle the popover. Same footprint as the notifications bell
          for visual consistency. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group relative inline-flex h-16 w-16 items-center justify-center rounded-full bg-card shadow-lg ring-1 ring-border transition hover:scale-105 hover:shadow-xl",
          open && "ring-2 ring-emerald-300",
        )}
        title={open ? "Close assistant" : "AI assistant — chat, reports, actions"}
        aria-label="AI assistant"
      >
        <AssistantAvatar
          size={56}
          busy={busy || transcribing}
          listening={recording}
        />
      </button>
    </div>
  );
}

// ---------- helpers ----------------------------------------------- //

function loadHistory(): Msg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Msg[];
    if (Array.isArray(parsed)) return parsed.slice(-MAX_HISTORY);
  } catch {
    /* corrupt blob — start fresh */
  }
  return [];
}

// Safely parse the JSON body of a fetch response — middleware (rate
// limiter, proxy 502) and timeouts both return non-JSON. Without this
// wrapper, `await res.json()` throws "Unexpected end of JSON input" or
// "Unexpected token '<'", surfaced to the operator as cryptic noise.
// We read the body as text once, try JSON.parse, and fall back to a
// synthetic `{ error }` shape so callers can show the real upstream
// message ("Too many requests. Slow down.", "HTTP 504", etc.).
async function safeJson<T extends Record<string, unknown>>(
  res: Response,
): Promise<T & { error?: string }> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    return { error: `HTTP ${res.status} (no body)` } as T & { error?: string };
  }
  const trimmed = body.trim();
  if (!trimmed) {
    return { error: `HTTP ${res.status} (empty response)` } as T & {
      error?: string;
    };
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return {
      error: `HTTP ${res.status}: ${trimmed.slice(0, 200)}`,
    } as T & { error?: string };
  }
}

// Module-level audio handle so a new reply can stop whatever is
// currently playing before it queues itself — otherwise multiple
// answers would talk over each other.
let currentAudio: HTMLAudioElement | null = null;

async function speak(text: string): Promise<void> {
  if (typeof window === "undefined") return;
  // Stop any in-flight audio + cancel the browser fallback queue.
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  try {
    // Primary path: ElevenLabs (multilingual, natural Hindi/Hinglish).
    // The endpoint streams audio/mpeg back so playback starts as soon
    // as the first chunk arrives.
    const res = await fetch("/api/assistant/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
    };
    await audio.play();
    return;
  } catch {
    // Fallback: browser SpeechSynthesis. Less natural on Hindi but at
    // least the user hears SOMETHING if ElevenLabs is unreachable /
    // out of credits.
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[ऀ-ॿ]/.test(text) ? "hi-IN" : "en-IN";
    synth.speak(u);
  }
}
