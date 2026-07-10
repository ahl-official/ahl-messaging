"use client";

// Modern animated avatar for the home AI assistant. Layered:
//   1. Outer pulse ring — soft halo that drifts in/out.
//   2. Spinning gradient orbit when busy/listening.
//   3. Inner glassy core with a constellation-style monogram (✦) so
//      it doesn't read as "yet another generic bot icon".
//
// Pure CSS / SVG — no images, no animation library.

import { cn } from "@/lib/utils";

interface Props {
  /** Outbound network call in flight — gradient orbit speeds up. */
  busy?: boolean;
  /** Mic is recording — switch to rose/amber accent + faster ring. */
  listening?: boolean;
  /** Default 44 — matches a ~h-11 row. */
  size?: number;
}

export function AssistantAvatar({ busy = false, listening = false, size = 44 }: Props) {
  const tone = listening
    ? "from-rose-400 via-amber-400 to-orange-400"
    : busy
      ? "from-[#6098FF] via-primary to-sky-500"
      : "from-primary via-[#6098FF] to-sky-600";
  const ringSpeed = listening || busy ? "qht-assistant-spin-fast" : "qht-assistant-spin-slow";

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Outer soft pulse halo */}
      <span
        className={cn(
          "absolute inset-0 rounded-full blur-md opacity-60",
          "bg-gradient-to-br",
          tone,
          "qht-assistant-pulse",
        )}
      />
      {/* Spinning gradient orbit — conic gradient via mask */}
      <span
        className={cn(
          "absolute inset-0 rounded-full",
          ringSpeed,
        )}
        style={{
          background:
            "conic-gradient(from 0deg, rgba(16,185,129,0.0), rgba(16,185,129,0.85), rgba(56,189,248,0.85), rgba(16,185,129,0.0))",
          WebkitMask:
            "radial-gradient(circle, transparent 60%, #000 62%, #000 100%)",
          mask: "radial-gradient(circle, transparent 60%, #000 62%, #000 100%)",
        }}
      />
      {/* Inner glass core */}
      <span
        className="absolute inset-[18%] rounded-full bg-gradient-to-br from-white via-white to-primary/10 shadow-inner ring-1 ring-primary/60"
      />
      {/* Monogram — diamond/star glyph */}
      <svg
        viewBox="0 0 24 24"
        className="relative h-[42%] w-[42%]"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        style={{ color: listening ? "#b91c1c" : "#047857" }}
      >
        <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
        <circle cx="18" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </svg>
    </span>
  );
}
