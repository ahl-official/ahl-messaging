"use client";

// Inbound-photos strip for the contact-details panel. Pulls every
// client-sent image from /api/contacts/[id]/photos, renders them as
// a horizontally-scrollable thumbnail row, and opens a fullscreen
// lightbox on click. Lightbox supports keyboard nav (←/→/Esc) and a
// "Set as profile" action that calls PUT /api/contacts/[id]/avatar.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  ImageOff,
  Mic,
  UserCircle,
  X,
} from "lucide-react";
import { emitAvatarChanged } from "@/lib/avatar-events";

interface Photo {
  id: string;
  /** Who sent it — inbound = client, outbound = our team. Drives the
   *  tiny "Sent" badge on outbound thumbnails so the operator can tell
   *  team-shared images apart from client-shared ones at a glance. */
  direction?: "inbound" | "outbound";
  kind?: "image" | "audio";
  url: string;
  mime: string;
  caption: string;
  transcript?: string | null;
  timestamp: string;
}

export function PhotosRow({
  contactId,
  onAvatarChanged,
}: {
  contactId: string;
  onAvatarChanged?: (url: string) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // Legacy media whose WhatsApp CDN url expired — the <img> 404s, so we
  // show an "unavailable" tile instead of the browser's broken icon.
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/photos`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { photos?: Photo[] };
      setPhotos(json.photos ?? []);
    } catch {
      /* silent — empty list is the safe default */
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || photos.length === 0) return null;

  return (
    <>
      <div className="border-b p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ImageIcon className="h-3 w-3" />
            Media
            <span className="rounded-full bg-secondary px-1.5 text-[9px] tabular-nums">
              {photos.length}
            </span>
          </span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setOpenIdx(i)}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-secondary/40 transition-all duration-200 hover:-translate-y-0.5 hover:ring-2 hover:ring-primary/60 hover:shadow-md"
              title={new Date(p.timestamp).toLocaleString()}
            >
              {failed.has(p.id) ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-secondary text-muted-foreground">
                  <ImageOff className="h-4 w-4" />
                  <span className="text-[8px] font-medium uppercase tracking-wide">
                    Expired
                  </span>
                </div>
              ) : p.kind === "audio" ? (
                // Same square footprint as the photo thumbnails so
                // the row stays uniform; voice-note tile is a violet
                // gradient + mic glyph so it's visually distinct
                // without breaking the grid.
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-violet-400 to-violet-600 text-white">
                  <Mic className="h-5 w-5" />
                  <span className="text-[9px] font-medium uppercase tracking-wide opacity-90">
                    Voice
                  </span>
                </div>
              ) : (
                <img
                  src={p.url}
                  alt=""
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  loading="lazy"
                  onError={() =>
                    setFailed((s) => {
                      const next = new Set(s);
                      next.add(p.id);
                      return next;
                    })
                  }
                />
              )}
              {p.direction === "outbound" ? (
                <span
                  className="pointer-events-none absolute bottom-0.5 right-0.5 inline-flex items-center rounded-sm bg-primary/90 px-1 text-[8px] font-bold uppercase tracking-wider text-white shadow-sm"
                  title="Sent by our team"
                >
                  Sent
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {openIdx !== null ? (
        <PhotoLightbox
          photos={photos}
          startIdx={openIdx}
          contactId={contactId}
          onClose={() => setOpenIdx(null)}
          onAvatarChanged={onAvatarChanged}
        />
      ) : null}
    </>
  );
}

function PhotoLightbox({
  photos,
  startIdx,
  contactId,
  onClose,
  onAvatarChanged,
}: {
  photos: Photo[];
  startIdx: number;
  contactId: string;
  onClose: () => void;
  onAvatarChanged?: (url: string) => void;
}) {
  const [idx, setIdx] = useState(startIdx);
  const [busy, setBusy] = useState(false);
  const [setOk, setSetOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prev = useCallback(
    () => setIdx((i) => (i === 0 ? photos.length - 1 : i - 1)),
    [photos.length],
  );
  const next = useCallback(
    () => setIdx((i) => (i === photos.length - 1 ? 0 : i + 1)),
    [photos.length],
  );

  // Keyboard nav + scroll lock with scrollbar compensation, mirroring
  // the FullscreenTextarea modal so the page doesn't horizontally
  // shift when the lightbox opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      }
    }
    document.addEventListener("keydown", onKey);
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0)
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
    };
  }, [prev, next, onClose]);

  const setAsProfile = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/avatar`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: photos[idx].url }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        avatar_url?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setSetOk(true);
      setTimeout(() => setSetOk(false), 1500);
      const newUrl = json.avatar_url ?? photos[idx].url;
      emitAvatarChanged({ contactId, avatarUrl: newUrl });
      onAvatarChanged?.(newUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const photo = photos[idx];

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/85 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <div className="text-xs tabular-nums opacity-80">
          {idx + 1} / {photos.length}
        </div>
        <div className="flex items-center gap-2">
          {photo.kind !== "audio" ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void setAsProfile();
              }}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white/15 px-3 text-xs font-medium text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-50"
            >
              <UserCircle className="h-3.5 w-3.5" />
              {setOk ? "Set as profile ✓" : busy ? "Setting…" : "Set as profile"}
            </button>
          ) : null}
          <a
            href={photo.url}
            download
            onClick={(e) => e.stopPropagation()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
            aria-label="Download"
            title="Download"
          >
            <Download className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Media area — image OR audio depending on kind. Same nav
          chrome (←/→/Esc) wraps both so the operator can flip
          through the client's photos and voice notes uniformly. */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {photos.length > 1 ? (
          <button
            type="button"
            onClick={prev}
            className="absolute left-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25"
            aria-label="Previous (←)"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        {photo.kind === "audio" ? (
          <div className="flex w-[min(640px,90vw)] flex-col items-center gap-5 rounded-2xl bg-white/5 p-8 text-white ring-1 ring-white/10 backdrop-blur">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 shadow-lg">
              <Mic className="h-9 w-9" />
            </div>
            <div className="text-center text-xs uppercase tracking-[0.18em] text-white/60">
              Voice note
            </div>
            <audio
              src={photo.url}
              controls
              autoPlay
              preload="metadata"
              className="w-full"
            />
            {photo.transcript ? (
              <div className="max-h-40 w-full overflow-y-auto rounded-md bg-white/5 px-4 py-2 text-[13px] italic text-white/85 ring-1 ring-inset ring-white/10">
                {photo.transcript}
              </div>
            ) : null}
          </div>
        ) : (
          <img
            src={photo.url}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        )}
        {photos.length > 1 ? (
          <button
            type="button"
            onClick={next}
            className="absolute right-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25"
            aria-label="Next (→)"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      {/* Footer — caption + meta */}
      <div className="px-4 py-3 text-xs text-white/80">
        <div className="flex items-center justify-between gap-3">
          <span className="tabular-nums">
            {new Date(photo.timestamp).toLocaleString()}
          </span>
          {error ? <span className="text-rose-300">{error}</span> : null}
        </div>
        {photo.caption ? (
          <div className="mt-1 truncate text-white/70">{photo.caption}</div>
        ) : null}
      </div>
    </div>
  );
}
