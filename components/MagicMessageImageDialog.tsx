"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Upload, WandSparkles, X } from "lucide-react";
import { cn, imageFromClipboard } from "@/lib/utils";
import { ModalShell } from "@/components/ui/ModalShell";

interface Props {
  contactId: string;
  waId: string;
  contactName: string;
  /** Pre-selected image — set when the dialog was opened by pasting an
   *  image into the chat. Skips the file picker; agent only adds the name. */
  initialFile?: File | null;
  onClose: () => void;
  /** Called after the magic_message template send succeeds. */
  onSent: () => void;
}

interface ApiResponse {
  ok?: boolean;
  error?: string;
  message?: { id: string };
}

const ACCEPT = "image/jpeg,image/png";
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

// Pre-fills the patient-name input with whatever we already know about the
// contact. Falls back to an empty string for phone-only contacts so the
// agent has to type a name in (no awkward "Hi +91…" sends).
function deriveDefaultName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  // Phone-only or masked ("•••• 91") display name → not a real name.
  if (trimmed.includes("•") || /^\+?\d[\d\s-]*$/.test(trimmed)) return "";
  return trimmed;
}

// Image branch of Magic Message. The agent picks a JPEG/PNG from disk; we
// upload it as the `magic_message` template's header. No text generation
// step — the chosen image goes straight through.
export function MagicMessageImageDialog({
  contactId,
  waId,
  contactName,
  initialFile,
  onClose,
  onSent,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState(() => deriveDefaultName(contactName));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke the blob URL when component unmounts or file changes — avoids
  // leaking object URLs.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function pickFile(f: File | null) {
    setError(null);
    if (!f) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!["image/jpeg", "image/png"].includes(f.type)) {
      setError("Use a JPEG or PNG image.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`File too large (${Math.round(f.size / 1024 / 1024)}MB) — max 5MB.`);
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  // Keep a stable handle on the latest pickFile so the once-only listeners
  // below don't need it in their dep arrays.
  const pickFileRef = useRef(pickFile);
  pickFileRef.current = pickFile;

  // Prefill when opened via a paste in the chat.
  useEffect(() => {
    if (initialFile) pickFileRef.current(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paste an image anywhere while the dialog is open to (re)select it —
  // no need to hunt for the file on disk.
  useEffect(() => {
    function onPaste(e: globalThis.ClipboardEvent) {
      const f = imageFromClipboard(e.clipboardData);
      if (!f) return;
      e.preventDefault();
      pickFileRef.current(f);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const trimmedName = customerName.trim();
  const canSend = !!file && !!trimmedName && !sending;

  async function handleSend() {
    if (!canSend || !file) return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("contact_id", contactId);
      fd.append("wa_id", waId);
      fd.append("customer_name", trimmedName);
      fd.append("file", file);

      const res = await fetch("/api/magic-message/image", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSent();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <ModalShell
      overlayClassName="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-lg border bg-card shadow-xl"
    >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100">
              <WandSparkles className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5">
                Magic Message
                <span className="inline-flex items-center gap-1 rounded bg-fuchsia-50 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-700 ring-1 ring-fuchsia-100">
                  <ImageIcon className="h-3 w-3" />
                  Image
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                To {contactName}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Patient name <span className="text-rose-600">*</span>
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="DIGANT SHARMA"
              maxLength={80}
              disabled={sending}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-60"
            />
            <div className="mt-1 text-[10px] text-muted-foreground">
              Will appear in the message — &quot;Hi {trimmedName || "Name"},&quot;
            </div>
          </div>

          <div>
            <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Choose an image
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                pickFile(f);
                // Allow re-selecting the same file later.
                e.currentTarget.value = "";
              }}
            />

            {previewUrl ? (
              <div className="rounded-md border bg-emerald-50/40 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt="Selected"
                  className="max-h-64 w-full rounded object-contain"
                />
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-muted-foreground">
                    {file?.name} · {file ? Math.round(file.size / 1024) : 0} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending}
                    className="shrink-0 rounded-md border bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
                  >
                    Replace
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-input bg-background py-10 text-sm font-medium transition",
                  "hover:border-fuchsia-300 hover:bg-fuchsia-50",
                )}
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100">
                  <Upload className="h-5 w-5" />
                </span>
                <span className="text-foreground">Click to pick a JPEG / PNG</span>
                <span className="text-[11px] text-muted-foreground">Max 5 MB</span>
              </button>
            )}

          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-semibold text-white shadow-sm",
              "bg-fuchsia-600 hover:bg-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <WandSparkles className="h-3.5 w-3.5" />
                Send Magic Message
              </>
            )}
          </button>
        </div>
    </ModalShell>
  );
}
