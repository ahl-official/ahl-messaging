// Shared sub-header for every Settings page. Sits below the global
// gradient hero (rendered by app/(dashboard)/settings/layout.tsx) and
// gives each tab a consistent icon + title + subtitle + optional
// right-side action slot.
//
// NOT a client component — it has no hooks or handlers, just renders
// markup. Keeping it server-flexible matters: the /settings/notice page
// is a SERVER component and passes `icon={Megaphone}` directly. If this
// were a client component, that icon (a function) would cross the
// server→client boundary and crash with "Functions cannot be passed to
// Client Components". As a plain shared component it works in both
// server pages and client View components.

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Tailwind tone — picks the icon-tile background. */
  tone?: "emerald" | "violet" | "sky" | "amber" | "rose" | "slate";
  right?: React.ReactNode;
  /** Extra row rendered below the subtitle — e.g. stat chips. */
  meta?: React.ReactNode;
}

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  emerald: "bg-primary/10 text-primary ring-primary/25",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
};

export function SettingsPageHeader({
  icon: Icon,
  title,
  subtitle,
  tone = "emerald",
  right,
  meta,
}: Props) {
  return (
    <div className="border-b bg-card">
      <div className="mx-auto flex max-w-5xl items-start justify-between gap-3 px-6 py-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
              TONE[tone],
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            ) : null}
            {meta ? <div className="mt-2">{meta}</div> : null}
          </div>
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}
