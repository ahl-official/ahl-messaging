"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Record a voice note in the browser and hand the audio File to the parent.
 *  Only mounted for Evolution numbers (sendWhatsAppAudio). */
export function VoiceRecordButton({
  onRecorded,
  disabled,
}: {
  onRecorded: (file: File) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [secs, setSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function pickMime(): string {
    const prefs = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const m of prefs) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
    return "audio/webm";
  }

  async function start() {
    if (disabled || recording || sending) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      cancelledRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        setRecording(false);
        if (cancelledRef.current || chunksRef.current.length === 0) return;
        const type = rec.mimeType || mime;
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunksRef.current, { type });
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type });
        setSending(true);
        try {
          await onRecorded(file);
        } finally {
          setSending(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setSecs(0);
      timerRef.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      alert("Mic access nahi mila. Browser permission allow karo.");
    }
  }

  function stop(cancel: boolean) {
    cancelledRef.current = cancel;
    recorderRef.current?.stop();
  }

  const mmss = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

  if (sending) {
    return (
      <div className="inline-flex h-8 items-center gap-1 px-1 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Sending…
      </div>
    );
  }

  if (recording) {
    return (
      <div className="inline-flex h-8 items-center gap-1.5 rounded-full bg-rose-50 px-2 ring-1 ring-rose-200">
        <button type="button" onClick={() => stop(true)} title="Cancel" className="text-rose-600 hover:text-rose-700">
          <X className="h-4 w-4" />
        </button>
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 tabular-nums">
          <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> {mmss}
        </span>
        <button type="button" onClick={() => stop(false)} title="Send voice" className="text-emerald-600 hover:text-emerald-700">
          <Square className="h-4 w-4 fill-current" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      title="Record voice note"
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50",
      )}
    >
      <Mic className="h-[18px] w-[18px]" />
    </button>
  );
}
