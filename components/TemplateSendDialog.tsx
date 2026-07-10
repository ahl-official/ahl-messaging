"use client";

import { useEffect, useMemo, useRef, useState } from "react";


import { Image as ImageIcon, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/ModalShell";
import type { TemplateSummary } from "@/components/TemplatePicker";

interface Props {
  template: TemplateSummary;
  onClose: () => void;
  onSend: (
    components: unknown[],
    renderedBody: string,
    /** Public URL of the header media we just uploaded (image/video/document) — */
    /** stored on the message row so the dashboard can render the header bubble. */
    mediaUrl?: string,
  ) => Promise<void>;
  /** Interakt numbers don't go through Meta — the approved sample is used
   *  directly (no Meta media mirror / upload required). */
  isInterakt?: boolean;
  /** Business number the template is sent from — needed so the media
   *  upload routes resolve the right portfolio's Meta creds. */
  phoneNumberId?: string | null;
}

function countBodyVars(body: string): number {
  const matches = body.match(/\{\{(\d+)\}\}/g);
  if (!matches) return 0;
  const nums = new Set(matches.map((m) => Number(m.slice(2, -2))));
  return nums.size;
}

function renderBody(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? `{{${n}}}`);
}

const MEDIA_ACCEPT: Record<string, string> = {
  IMAGE: "image/jpeg,image/png",
  VIDEO: "video/mp4",
  DOCUMENT: "application/pdf",
};

export function TemplateSendDialog({ template, onClose, onSend, isInterakt, phoneNumberId }: Props) {
  const varCount = useMemo(() => countBodyVars(template.body), [template.body]);
  const headerFormat = (template.header_format ?? "TEXT") as string;
  const needsMedia = headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT";

  const [values, setValues] = useState<string[]>(Array(varCount).fill(""));
  const [mediaId, setMediaId] = useState<string | null>(null);
  /** Stable public URL of the uploaded media (Supabase Storage). Survives
   *  page reload — used to persist header image on the message row. */
  const [mediaPublicUrl, setMediaPublicUrl] = useState<string | null>(null);
  // Ref mirror so handleSend reads the latest URL synchronously even if it
  // fires in the same React batch as the upload state update.
  const mediaPublicUrlRef = useRef<string | null>(null);
  /** Local preview shown in the dialog. Falls back to a blob URL if the
   *  Storage upload didn't return a public URL. */
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Synchronous lock — useState `sending` alone leaves a window where two
  // rapid Send clicks both see `sending=false` (closure stale) and both
  // proceed, creating duplicate template messages.
  const sendingLockRef = useRef(false);

  // "Use the approved sample" path. Meta won't fetch its own
  // scontent.whatsapp.net URLs when sending a template (those URLs require
  // WhatsApp client auth), so passing them as `image.link` always errors
  // with "Media upload error". Instead, when the dialog opens with a media
  // template that has an approved sample on file, we mirror it through our
  // own /api/upload-from-url route which:
  //   1. Downloads the sample server-side (where the scontent URL is OK)
  //   2. Re-uploads to Meta to get a fresh, sendable media_id
  //   3. Caches a public Supabase Storage copy for stable previews
  // The mirrored media_id then gets used like any normal upload.
  const [mirroring, setMirroring] = useState(false);
  const mirroredOnceRef = useRef(false);

  useEffect(() => {
    // Interakt uses the approved sample directly — no Meta mirror needed.
    if (isInterakt) return;
    if (!needsMedia) return;
    if (mediaId) return;
    if (!template.header_url) return;
    if (mirroredOnceRef.current) return;
    mirroredOnceRef.current = true;
    setMirroring(true);
    setError(null);
    fetch("/api/upload-from-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: template.header_url,
        template_id: template.id,
        phone_number_id: phoneNumberId ?? undefined,
      }),
    })
      .then(async (r) => {
        const j = (await r.json()) as { media_id?: string; media_url?: string; error?: string };
        if (!r.ok || !j.media_id) throw new Error(j.error ?? `HTTP ${r.status}`);
        setMediaId(j.media_id);
        setMediaPublicUrl(j.media_url ?? template.header_url ?? null);
        mediaPublicUrlRef.current = j.media_url ?? template.header_url ?? null;
      })
      .catch((e: Error) => {
        setError(`Couldn't prepare approved sample: ${e.message}. Upload an image to send.`);
      })
      .finally(() => setMirroring(false));
    // template.id / header_url are stable per dialog open — running once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const canSend =
    values.every((v) => v.trim().length > 0) &&
    // Interakt sends the approved sample directly — no uploaded mediaId needed.
    (!needsMedia || !!mediaId || isInterakt) &&
    !sending &&
    !uploading &&
    !mirroring;

  async function onPickFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/upload-media${phoneNumberId ? `?phone_number_id=${encodeURIComponent(phoneNumberId)}` : ""}`,
        { method: "POST", body: fd },
      );
      const j = (await res.json()) as { media_id?: string; media_url?: string; error?: string };
      if (!res.ok || !j.media_id) throw new Error(j.error ?? `HTTP ${res.status}`);
      // eslint-disable-next-line no-console
      console.log("[TemplateSendDialog] upload response:", {
        media_id: j.media_id,
        media_url: j.media_url ?? null,
      });
      setMediaId(j.media_id);
      setMediaPublicUrl(j.media_url ?? null);
      mediaPublicUrlRef.current = j.media_url ?? null;
      setMediaPreview(j.media_url ?? (file.type.startsWith("image") ? URL.createObjectURL(file) : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSend() {
    if (sendingLockRef.current) return;
    if (!canSend) return;
    sendingLockRef.current = true;
    setError(null);
    setSending(true);
    try {
      const components: Record<string, unknown>[] = [];

      if (needsMedia) {
        const mediaKey = headerFormat.toLowerCase(); // image / video / document
        if (isInterakt) {
          // Interakt fetches media by public URL — pass the approved sample's
          // URL (or an uploaded one) as the header link.
          const link = mediaPublicUrlRef.current ?? template.header_url ?? null;
          if (link) {
            components.push({
              type: "header",
              parameters: [{ type: mediaKey, [mediaKey]: { link } }],
            });
          }
        } else if (mediaId) {
          components.push({
            type: "header",
            parameters: [{ type: mediaKey, [mediaKey]: { id: mediaId } }],
          });
        }
      }

      if (varCount > 0) {
        components.push({
          type: "body",
          parameters: values.map((v) => ({ type: "text", text: v.trim() })),
        });
      }

      // Read from ref first to bypass any stale-closure window after upload.
      // When sending the approved sample, fall back to the template's stored
      // header URL so the bubble can render the same image agents see in the
      // dialog preview.
      const urlToSend =
        mediaPublicUrlRef.current ?? mediaPublicUrl ?? template.header_url ?? undefined;
      // eslint-disable-next-line no-console
      console.log("[TemplateSendDialog] handleSend:", {
        urlFromRef: mediaPublicUrlRef.current,
        urlFromState: mediaPublicUrl,
        sending: urlToSend,
      });
      await onSend(components, renderBody(template.body, values), urlToSend);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      sendingLockRef.current = false;
      setSending(false);
    }
  }

  return (
    <ModalShell
      overlayClassName="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-lg border bg-card shadow-xl"
    >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Send template</div>
            <div className="text-xs text-muted-foreground">{template.name}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {needsMedia ? (
            <div>
              <label className="mb-1 block text-xs font-semibold">
                {headerFormat === "IMAGE" ? "Image" : headerFormat === "VIDEO" ? "Video" : "Document"} for header
              </label>

              {/* Approved-sample preview — shown when the template has a Meta-
                  approved header image and the user hasn't uploaded a
                  replacement. While the sample is being mirrored to a fresh
                  media_id we show a spinner; once ready, the badge flips to
                  "Ready to send" and the Send button activates. */}
              {!mediaId &&
              template.header_url &&
              (headerFormat === "IMAGE" || headerFormat === "VIDEO") &&
              !mediaPreview ? (
                <div className="mb-2 rounded-md border border-primary/25 bg-primary/10 p-2">
                  {headerFormat === "VIDEO" ? (
                    <video
                      src={template.header_url}
                      controls
                      className="max-h-40 w-full rounded object-contain"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={template.header_url}
                      alt="Approved sample"
                      className="max-h-40 w-full rounded object-contain"
                    />
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
                    {mirroring ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Preparing approved sample…
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                        ✓ Approved sample ready
                      </span>
                    )}
                    {!isInterakt ? (
                      <span className="text-muted-foreground">
                        Or upload below to send a different image
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {!isInterakt ? (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    className="hidden"
                    accept={MEDIA_ACCEPT[headerFormat] ?? ""}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onPickFile(f);
                      e.currentTarget.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                    className={cn(
                      "inline-flex h-20 w-32 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input bg-background text-xs font-medium text-primary hover:bg-secondary",
                      uploading && "opacity-60",
                    )}
                  >
                    {uploading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <>
                        <ImageIcon className="h-5 w-5 text-muted-foreground" />
                        <span className="underline">{mediaId ? "Replace" : "Upload"}</span>
                      </>
                    )}
                  </button>
                  {mediaPreview && headerFormat === "IMAGE" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mediaPreview} alt="Header" className="mt-2 max-h-32 rounded-md border" />
                  ) : null}
                  {mediaId ? (
                    <div className="mt-1 inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      ✓ Ready to send
                    </div>
                  ) : null}
                </>
              ) : null}
              {isInterakt ? (
                <p className="mt-1 text-[11px] font-medium text-primary">
                  ✓ Approved sample header automatically bheja jayega.
                </p>
              ) : null}
            </div>
          ) : null}

          {varCount > 0 ? (
            <div>
              <label className="mb-1 block text-xs font-semibold">Variables</label>
              <div className="space-y-2">
                {Array.from({ length: varCount }).map((_, i) => (
                  <div key={i}>
                    <label className="mb-0.5 block text-[10px] font-semibold text-muted-foreground">
                      {"{{"}
                      {i + 1}
                      {"}}"}
                    </label>
                    <Input
                      value={values[i] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                      }
                      placeholder={`Value for {{${i + 1}}}`}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Live preview */}
          <div className="rounded-md border bg-secondary/40 p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Preview</div>
            {template.header_text ? (
              <div className="mb-1 text-[11px] font-bold">{template.header_text}</div>
            ) : null}
            <p className="whitespace-pre-wrap text-xs">{renderBody(template.body, values)}</p>
            {template.footer ? (
              <p className="mt-1 text-[10px] italic text-muted-foreground">{template.footer}</p>
            ) : null}
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
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
    </ModalShell>
  );
}
