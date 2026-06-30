"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** "light" = on light bg, show logo as-is. "dark" = on dark/coloured bg, wrap in soft white tile. "bare" = no wrapper, transparent. */
  variant?: "light" | "dark" | "bare";
  /** px size of the rendered logo image (default 32). */
  size?: number;
  /** Optional className applied to the outer wrapper. */
  className?: string;
  /** Show wordmark text next to the logo. */
  withWordmark?: boolean;
  wordmark?: string;
  wordmarkClassName?: string;
}

/**
 * Single source of truth for the AHL brand mark.
 * Drop the file at `public/logo.png` (square, transparent or white background).
 * If the file is missing, a clean text badge is shown as a graceful fallback.
 */
export function Logo({
  variant = "light",
  size = 32,
  className,
  withWordmark = false,
  wordmark = "AHL Messaging",
  wordmarkClassName,
}: Props) {
  const [errored, setErrored] = useState(false);

  const padding = variant === "dark" ? Math.round(size * 0.18) : 0;
  const wrapperSize = size + padding * 2;

  const fallback = (
    <span
      className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground font-bold tracking-tight"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      AHL
    </span>
  );

  const img = errored ? (
    fallback
  ) : (
    <img
      src="/logo.png"
      alt="American Hairline"
      width={size}
      height={size}
      onError={() => setErrored(true)}
      className="block object-contain"
      style={{ width: size, height: size }}
    />
  );

  let mark: React.ReactNode;
  if (variant === "dark") {
    mark = (
      <span
        className="inline-flex items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-white/30"
        style={{ width: wrapperSize, height: wrapperSize, padding }}
      >
        {img}
      </span>
    );
  } else if (variant === "light") {
    mark = (
      <span
        className="inline-flex items-center justify-center"
        style={{ width: wrapperSize, height: wrapperSize }}
      >
        {img}
      </span>
    );
  } else {
    mark = img;
  }

  if (!withWordmark) {
    return <span className={cn("inline-flex shrink-0", className)}>{mark}</span>;
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {mark}
      <span className={cn("font-semibold tracking-tight", wordmarkClassName)}>{wordmark}</span>
    </span>
  );
}
