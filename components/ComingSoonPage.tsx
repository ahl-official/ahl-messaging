import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  features: string[];
  status?: "planned" | "in-development" | "early-access";
  cta?: { label: string; href: string };
}

const STATUS_LABEL: Record<NonNullable<Props["status"]>, string> = {
  "planned": "Planned",
  "in-development": "In development",
  "early-access": "Early access",
};

const STATUS_CLASS: Record<NonNullable<Props["status"]>, string> = {
  "planned": "border-slate-200 bg-slate-50 text-slate-700",
  "in-development": "border-amber-200 bg-amber-50 text-amber-900",
  "early-access": "border-emerald-200 bg-emerald-50 text-emerald-900",
};

export function ComingSoonPage({
  icon: Icon,
  title,
  description,
  features,
  status = "in-development",
  cta,
}: Props) {
  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <div className="grid h-full place-items-center px-6 py-12">
        <div className="w-full max-w-2xl text-center">
          <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 ring-1 ring-brand-100">
            <Icon className="h-7 w-7" />
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_CLASS[status]}`}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            {STATUS_LABEL[status]}
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{description}</p>

          {features.length > 0 ? (
            <div className="mt-8 grid gap-3 text-left sm:grid-cols-2">
              {features.map((f) => (
                <div
                  key={f}
                  className="flex items-start gap-2.5 rounded-lg border bg-card px-4 py-3 text-sm shadow-sm"
                >
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-700">
                    ✓
                  </span>
                  <span className="text-foreground">{f}</span>
                </div>
              ))}
            </div>
          ) : null}

          {cta ? (
            <Link
              href={cta.href}
              className="mt-8 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              {cta.label}
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
