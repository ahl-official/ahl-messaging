"use client";

// Shared top-of-page hero used across non-Settings top-level pages
// (Contacts, Templates, Automation, Call history, LeadSquared). Same
// emerald-on-dark gradient as Settings + Home so the whole product
// reads as one family.
//
// Slots:
//   • icon, title, subtitle  — left content (mandatory)
//   • badges                 — optional row of role/tone chips
//   • right                  — action buttons (Refresh, Create, etc.)
//   • below                  — extra strip rendered under the hero
//                              (number selector, KPI tiles, tab strip)

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Pick the icon-tile + accent. Defaults to emerald. */
  tone?: "emerald" | "violet" | "sky" | "amber" | "rose";
  /** Optional small chips rendered next to the title (e.g. "INBOX", "OWNER"). */
  badges?: React.ReactNode;
  /** Right-side action area — buttons, links, etc. Rendered on the
   *  hero gradient so children should opt for glass / solid styles
   *  that read well on dark green. */
  right?: React.ReactNode;
  /** Optional strip rendered below the hero, still inside the same
   *  card so transitions feel seamless (e.g. number pills, KPIs). */
  below?: React.ReactNode;
}

// Uniform tile across all pages — operator preference. The `tone` prop
// is still accepted for API stability, but every value resolves to the
// same white-on-emerald-ring look that matches the Settings shield.
const TILE_CLASSES =
  "bg-white text-emerald-700 ring-emerald-100 shadow-emerald-900/15";

export function PremiumHeader({
  icon: Icon,
  title,
  subtitle,
  tone = "emerald",
  badges,
  right,
  below,
}: Props) {
  return (
    <header className="relative overflow-hidden bg-gradient-to-br from-emerald-900 via-emerald-800 to-teal-900 text-white">
      {/* Soft glow orbs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-teal-300/10 blur-3xl"
      />
      {/* Subtle grid texture */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative px-6 py-6 lg:px-10 lg:py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            <span
              className={cn(
                "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-lg ring-1 ring-inset",
                TILE_CLASSES,
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">
                  {title}
                </h1>
                {badges}
              </div>
              {subtitle ? (
                <p className="mt-1 max-w-2xl text-xs text-emerald-100/80 sm:text-[13px]">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          {right ? <div className="shrink-0">{right}</div> : null}
        </div>

        {below ? <div className="mt-5">{below}</div> : null}
      </div>
    </header>
  );
}
