"use client";

// Reusable "premium" empty state — soft gradient card, ping-animated
// gradient icon tile, optional CTA. Designed to feel high-end so even
// "you've got nothing here" pages don't feel hollow.
//
// Drop it anywhere you'd otherwise render a sparse "no items" message:
//   <EmptyState
//     icon={Megaphone}
//     title="No campaigns yet"
//     description="Send a WhatsApp template to a tagged segment."
//     action={canCreate ? { label: "Create your first campaign", onClick: onCreate, icon: Plus } : undefined}
//   />
//
// Variants for tone — emerald (default), sky, violet, amber, rose —
// just swap the gradient + decorative blur colours.

import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "emerald" | "sky" | "violet" | "amber" | "rose";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  /** Optional secondary action — rendered as a ghost button next to the CTA. */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  tone?: Tone;
  /** Tighter padding for in-panel placements (drawer / sidebar). */
  compact?: boolean;
  /** Optional class for the wrapper card. */
  className?: string;
}

const TONE: Record<
  Tone,
  {
    cardBg: string;
    blob1: string;
    blob2: string;
    pingRing: string;
    iconTile: string;
    iconShadow: string;
    ctaBg: string;
    ctaShadow: string;
  }
> = {
  emerald: {
    cardBg: "from-primary/10 via-card to-sky-50/40",
    blob1: "bg-primary/20/40",
    blob2: "bg-sky-200/40",
    pingRing: "bg-[#6098FF]/30",
    iconTile: "from-[#6098FF] to-[#6098FF]",
    iconShadow: "shadow-primary/30",
    ctaBg: "from-[#6098FF] via-primary to-[#1e56c7]",
    ctaShadow: "shadow-primary/30",
  },
  sky: {
    cardBg: "from-sky-50/60 via-card to-indigo-50/40",
    blob1: "bg-sky-200/40",
    blob2: "bg-indigo-200/40",
    pingRing: "bg-sky-400/30",
    iconTile: "from-sky-500 to-indigo-600",
    iconShadow: "shadow-sky-700/30",
    ctaBg: "from-sky-500 via-sky-600 to-indigo-600",
    ctaShadow: "shadow-sky-700/30",
  },
  violet: {
    cardBg: "from-violet-50/60 via-card to-fuchsia-50/40",
    blob1: "bg-violet-200/40",
    blob2: "bg-fuchsia-200/40",
    pingRing: "bg-violet-400/30",
    iconTile: "from-violet-500 to-fuchsia-600",
    iconShadow: "shadow-violet-700/30",
    ctaBg: "from-violet-500 via-violet-600 to-fuchsia-600",
    ctaShadow: "shadow-violet-700/30",
  },
  amber: {
    cardBg: "from-amber-50/60 via-card to-orange-50/40",
    blob1: "bg-amber-200/40",
    blob2: "bg-orange-200/40",
    pingRing: "bg-amber-400/30",
    iconTile: "from-amber-500 to-orange-600",
    iconShadow: "shadow-amber-700/30",
    ctaBg: "from-amber-500 via-amber-600 to-orange-600",
    ctaShadow: "shadow-amber-700/30",
  },
  rose: {
    cardBg: "from-rose-50/60 via-card to-pink-50/40",
    blob1: "bg-rose-200/40",
    blob2: "bg-pink-200/40",
    pingRing: "bg-rose-400/30",
    iconTile: "from-rose-500 to-pink-600",
    iconShadow: "shadow-rose-700/30",
    ctaBg: "from-rose-500 via-rose-600 to-pink-600",
    ctaShadow: "shadow-rose-700/30",
  },
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "emerald",
  compact = false,
  className,
}: EmptyStateProps) {
  const t = TONE[tone];
  const ActionIcon = action?.icon;
  const SecondaryIcon = secondaryAction?.icon;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border bg-gradient-to-br text-center shadow-sm",
        compact ? "p-8" : "p-12",
        t.cardBg,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full blur-3xl",
          t.blob1,
        )}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -left-12 -bottom-12 h-40 w-40 rounded-full blur-3xl",
          t.blob2,
        )}
      />

      <div className="relative mx-auto inline-flex h-16 w-16 items-center justify-center">
        <span
          className={cn(
            "absolute inset-0 inline-flex h-full w-full animate-ping rounded-full",
            t.pingRing,
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg ring-4 ring-white",
            t.iconTile,
            t.iconShadow,
          )}
        >
          <Icon className="h-7 w-7" />
        </span>
      </div>

      <h3 className="relative mt-5 text-base font-bold tracking-tight">
        {title}
      </h3>
      {description ? (
        <p className="relative mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      {action || secondaryAction ? (
        <div className="relative mt-5 flex flex-wrap items-center justify-center gap-2">
          {action ? (
            <button
              type="button"
              onClick={action.onClick}
              className={cn(
                "group inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br px-4 py-2 text-xs font-bold text-white shadow-md transition hover:shadow-lg hover:brightness-105",
                t.ctaBg,
                t.ctaShadow,
              )}
            >
              {ActionIcon ? (
                <ActionIcon className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
              ) : null}
              {action.label}
            </button>
          ) : null}
          {secondaryAction ? (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex items-center gap-1.5 rounded-xl border bg-card px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary"
            >
              {SecondaryIcon ? <SecondaryIcon className="h-3.5 w-3.5" /> : null}
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
