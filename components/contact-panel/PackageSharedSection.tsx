"use client";

// "Package Shared" content — shown when the Package Shared tab is open.
// Two CRM options; picking one shows, for that CRM's lead:
//   • the quoted package (AI extract of the lead's package fields), with
//     who moved the lead to the "Package Shared" stage, and
//   • a full AI summary of the lead's CRM notes / activity log.
// Prompt + output language are editable in Settings → AI.

import { useEffect, useState } from "react";
import { Loader2, Package, StickyNote, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { useLsqLead } from "@/components/contact-panel/useLsqLead";

type Crm = "primary" | "secondary";

interface CrmResult {
  loading: boolean;
  error: string | null;
  pkg: string | null;
  sharedBy: string | null;
  notes: string | null;
}

function bullets(text: string | null): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*•]\s*/, ""));
}

export function PackageSharedContent({
  lsq,
  lsq2,
  showSecondary,
}: {
  lsq: ReturnType<typeof useLsqLead>;
  lsq2: ReturnType<typeof useLsqLead>;
  showSecondary: boolean;
}) {
  const [crm, setCrm] = useState<Crm>("primary");
  const [results, setResults] = useState<Partial<Record<Crm, CrmResult>>>({});

  const meta: Record<Crm, { label: string; prospectId: string | null }> = {
    primary: {
      label: lsq.label || "Haridwar/Delhi",
      prospectId: lsq.lead?.prospect_id ?? null,
    },
    secondary: {
      label: lsq2.label || "Hyderabad/Gurgaon",
      prospectId: lsq2.lead?.prospect_id ?? null,
    },
  };

  async function pick(which: Crm) {
    setCrm(which);
    if (results[which] && !results[which]?.error) return; // cached
    const pid = meta[which].prospectId;
    if (!pid) {
      setResults((r) => ({
        ...r,
        [which]: {
          loading: false,
          error: `No lead in ${meta[which].label}.`,
          pkg: null,
          sharedBy: null,
          notes: null,
        },
      }));
      return;
    }
    setResults((r) => ({
      ...r,
      [which]: { loading: true, error: null, pkg: null, sharedBy: null, notes: null },
    }));
    try {
      const res = await fetch("/api/lsq/notes-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospect_id: pid, crm: which }),
      });
      const j = (await res.json()) as {
        package?: string | null;
        sharedBy?: string | null;
        notes?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setResults((r) => ({
        ...r,
        [which]: {
          loading: false,
          error: null,
          pkg: j.package ?? null,
          sharedBy: j.sharedBy ?? null,
          notes: j.notes ?? null,
        },
      }));
    } catch (e) {
      setResults((r) => ({
        ...r,
        [which]: {
          loading: false,
          error: e instanceof Error ? e.message : "Failed",
          pkg: null,
          sharedBy: null,
          notes: null,
        },
      }));
    }
  }

  const primaryPid = lsq.lead?.prospect_id ?? null;
  useEffect(() => {
    void pick("primary");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryPid]);

  const active = results[crm];
  const tabs: Crm[] = showSecondary ? ["primary", "secondary"] : ["primary"];

  return (
    <div className="animate-in fade-in slide-in-from-top-1 space-y-2.5 duration-200">
      {/* CRM options */}
      <div
        className={cn(
          "grid gap-1 rounded-lg bg-secondary p-1",
          showSecondary ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pick(t)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center rounded-md px-2 py-1.5 text-[11px] font-semibold transition",
              crm === t
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{meta[t].label}</span>
          </button>
        ))}
      </div>

      {!active || active.loading ? (
        <div className="flex items-center gap-2 px-1 text-[11px] text-violet-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the CRM lead…
        </div>
      ) : active.error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          {active.error}
        </div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {/* Package */}
          <Block
            icon={Package}
            title="Package"
            sub={active.sharedBy ? `Shared by ${active.sharedBy}` : null}
            lines={bullets(active.pkg)}
            empty="No package has been shared with this patient yet."
            tone="violet"
          />
          {/* Full notes / activity summary */}
          <Block
            icon={StickyNote}
            title="Notes summary"
            sub={null}
            lines={bullets(active.notes)}
            empty="No CRM notes or activity on this lead."
            tone="sky"
          />
        </div>
      )}
    </div>
  );
}

function Block({
  icon: Icon,
  title,
  sub,
  lines,
  empty,
  tone,
}: {
  icon: typeof Package;
  title: string;
  sub: string | null;
  lines: string[];
  empty: string;
  tone: "violet" | "sky";
}) {
  const ring = tone === "violet" ? "border-violet-100" : "border-sky-100";
  const dot = tone === "violet" ? "bg-violet-500" : "bg-sky-500";
  const grad =
    tone === "violet"
      ? "from-violet-50/60"
      : "from-sky-50/60";
  return (
    <div className={cn("min-w-0 rounded-xl border bg-gradient-to-b to-transparent p-3", ring, grad)}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
      </div>
      {sub ? (
        <div className="mb-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700">
          <UserCheck className="h-3 w-3" />
          {sub}
        </div>
      ) : null}
      {lines.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
              <span className={cn("mt-[7px] h-1 w-1 shrink-0 rounded-full", dot)} />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
