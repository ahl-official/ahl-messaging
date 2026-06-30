"use client";

import { useEffect, useRef, useState } from "react";
import { Download, X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

interface Props {
  url: string;
  mime: string;
  filename?: string;
  onClose: () => void;
}

export function MediaLightbox({ url, mime, filename, onClose }: Props) {
  // Image zoom + pan state.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const MIN = 1;
  const MAX = 6;
  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));
  function zoomBy(delta: number) {
    setScale((s) => {
      const next = clamp(Math.round((s + delta) * 100) / 100);
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }
  function reset() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomBy(0.5);
      else if (e.key === "-") zoomBy(-0.5);
      else if (e.key === "0") reset();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Mime is often missing/empty for media that arrived via Evolution
  // (Baileys), so fall back to the URL's file extension — otherwise an
  // image with no mime drops into the <iframe> branch and renders at
  // natural size top-left in a white box instead of fitting the frame.
  const ext = (() => {
    try {
      const path = new URL(url, "http://x").pathname.toLowerCase();
      const m = path.match(/\.([a-z0-9]+)$/);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  })();
  const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif", "svg"];
  const VIDEO_EXTS = ["mp4", "webm", "mov", "m4v", "3gp", "mkv", "avi"];
  const isImage = mime.startsWith("image/") || (!mime && IMAGE_EXTS.includes(ext));
  const isVideo = mime.startsWith("video/") || (!mime && VIDEO_EXTS.includes(ext));

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 animate-in fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Top-right actions */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {isImage ? (
          <div className="mr-1 flex items-center gap-1 rounded-md bg-white/10 px-1 backdrop-blur" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => zoomBy(-0.5)}
              disabled={scale <= MIN}
              className="inline-flex h-9 w-9 items-center justify-center rounded text-white hover:bg-white/20 disabled:opacity-40"
              title="Zoom out (-)"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="w-10 text-center text-xs text-white/80 tabular-nums">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => zoomBy(0.5)}
              disabled={scale >= MAX}
              className="inline-flex h-9 w-9 items-center justify-center rounded text-white hover:bg-white/20 disabled:opacity-40"
              title="Zoom in (+)"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={scale === 1 && offset.x === 0 && offset.y === 0}
              className="inline-flex h-9 w-9 items-center justify-center rounded text-white hover:bg-white/20 disabled:opacity-40"
              title="Reset (0)"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <a
          href={url}
          download={filename}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white/10 px-3 text-sm text-white hover:bg-white/20 backdrop-blur"
          title="Download"
        >
          <Download className="h-4 w-4" />
          Download
        </a>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20 backdrop-blur"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Filename */}
      {filename ? (
        <div className="absolute top-4 left-4 max-w-[60%] truncate text-sm text-white/80">
          {filename}
        </div>
      ) : null}

      {/* Content — stop propagation so clicks don't close */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] overflow-hidden"
        onWheel={
          isImage
            ? (e) => {
                e.preventDefault();
                zoomBy(e.deltaY < 0 ? 0.25 : -0.25);
              }
            : undefined
        }
      >
        {isImage ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt={filename ?? "preview"}
            draggable={false}
            onPointerDown={(e) => {
              if (scale <= 1) return;
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
            }}
            onPointerMove={(e) => {
              if (!dragRef.current) return;
              setOffset({
                x: dragRef.current.ox + (e.clientX - dragRef.current.x),
                y: dragRef.current.oy + (e.clientY - dragRef.current.y),
              });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onDoubleClick={() => (scale > 1 ? reset() : zoomBy(1))}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              cursor: scale > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
              transition: dragRef.current ? "none" : "transform 0.12s ease-out",
            }}
            className="max-h-[90vh] max-w-[90vw] rounded-md object-contain select-none"
          />
        ) : isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            className="max-h-[90vh] max-w-[90vw] rounded-md"
          />
        ) : (
          <iframe
            src={url}
            title={filename ?? "preview"}
            className="h-[85vh] w-[85vw] rounded-md bg-white"
          />
        )}
      </div>
    </div>
  );
}
