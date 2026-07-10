"use client";

// CRM section in the contact-details panel. Fetches the CRM lead that
// matches this contact's WhatsApp number and renders the dashboard-
// relevant fields (name, email, age, city/state, country, created-on,
// lead number, assignee). When LSQ isn't configured yet, the section
// shows a neutral hint linking to /integrations/lsq instead of an
// error — keeps the panel calm for non-LSQ tenants.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Cake,
  Calendar,
  CheckCircle2,
  Database,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  RefreshCcw,
  ShieldQuestion,
  Tag,
  User,
  UserCheck,
} from "lucide-react";

interface LsqLead {
  prospect_id: string;
  lead_number: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  age: number | null;
  dob: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  created_on: string | null;
  owner_name: string | null;
  source: string | null;
  status: string | null;
  lead_url: string | null;
}

interface ApiResponse {
  configured?: boolean;
  ok?: boolean;
  found?: boolean;
  lead?: LsqLead | null;
  error?: string;
}

type Phase = "loading" | "not-configured" | "not-found" | "found" | "error";

interface State {
  phase: Phase;
  lead: LsqLead | null;
  error: string | null;
}

export function LsqLeadPanel({ waId }: { waId: string }) {
  const [state, setState] = useState<State>({ phase: "loading", lead: null, error: null });

  async function load() {
    setState((s) => ({ ...s, phase: "loading", error: null }));
    try {
      const res = await fetch(`/api/lsq/lead?mobile=${encodeURIComponent(waId)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) {
        setState({ phase: "error", lead: null, error: json.error ?? `HTTP ${res.status}` });
        return;
      }
      if (!json.configured) {
        setState({ phase: "not-configured", lead: null, error: null });
        return;
      }
      if (!json.found || !json.lead) {
        setState({ phase: "not-found", lead: null, error: json.error ?? null });
        return;
      }
      setState({ phase: "found", lead: json.lead, error: null });
    } catch (e) {
      setState({
        phase: "error",
        lead: null,
        error: e instanceof Error ? e.message : "Network error",
      });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waId]);

  return (
    <section className="border-b">
      <header className="flex items-center justify-between gap-2 px-4 pt-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight">CRM</h3>
        </div>
        <div className="flex items-center gap-1">
          {state.phase === "found" && state.lead?.lead_url ? (
            <a
              href={state.lead.lead_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Open in LSQ"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={load}
            disabled={state.phase === "loading"}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
            aria-label="Refresh"
          >
            {state.phase === "loading" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCcw className="h-3 w-3" />
            )}
          </button>
        </div>
      </header>

      <div className="px-4 pb-4 pt-2">
        {state.phase === "loading" ? (
          <SkeletonRows />
        ) : state.phase === "not-configured" ? (
          <NotConfigured />
        ) : state.phase === "error" ? (
          <ErrorState message={state.error} onRetry={load} />
        ) : state.phase === "not-found" ? (
          <NotFound waId={waId} />
        ) : (
          <FoundState lead={state.lead!} />
        )}
      </div>
    </section>
  );
}

function FoundState({ lead }: { lead: LsqLead }) {
  return (
    <div className="space-y-2.5">
      {lead.status ? (
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
          <CheckCircle2 className="h-3 w-3" />
          {lead.status}
          {lead.source ? (
            <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {lead.source}
            </span>
          ) : null}
        </div>
      ) : null}

      <Row icon={Tag}       label="Lead #"           value={`#${lead.lead_number}`} mono />
      <Row icon={User}      label="Name"             value={lead.full_name} />
      <Row icon={Mail}      label="Email"            value={lead.email} />
      <Row icon={Cake}      label="Age"              value={lead.age != null ? `${lead.age} yrs` : null} />
      <Row icon={MapPin}    label="City & State"     value={joinCommaSep([lead.city, lead.state])} />
      <Row icon={MapPin}    label="Country"          value={lead.country} />
      <Row icon={Calendar}  label="Lead created"     value={formatDate(lead.created_on)} />
      <Row icon={UserCheck} label="Lead assigned to" value={lead.owner_name} />
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div
          className={[
            "mt-0.5 truncate text-[13px]",
            value ? "text-foreground" : "italic text-muted-foreground/70",
            mono ? "font-mono text-[12px]" : "",
          ].join(" ")}
        >
          {value ?? "—"}
        </div>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed bg-secondary/40 px-3 py-2.5 text-[11px] text-muted-foreground">
      <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        CRM not configured yet.{" "}
        <Link href="/integrations/lsq" className="font-medium text-primary hover:underline">
          Set it up →
        </Link>
      </div>
    </div>
  );
}

function NotFound({ waId }: { waId: string }) {
  return (
    <div className="rounded-md bg-secondary/40 px-3 py-2.5 text-[11px] text-muted-foreground">
      No LSQ lead found for{" "}
      <span className="font-mono text-foreground/80">+{waId}</span>. The lead may not be in LSQ yet, or it&apos;s stored under a different number format.
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Couldn&apos;t fetch CRM lead</div>
        <div className="mt-0.5 break-words text-amber-800/80">
          {message ?? "Unknown error"}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 font-medium underline-offset-4 hover:underline"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-start gap-2.5">
          <div className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full bg-secondary" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-2 w-16 rounded bg-secondary" />
            <div className="h-3 w-32 rounded bg-secondary" />
          </div>
        </div>
      ))}
    </div>
  );
}

function joinCommaSep(parts: (string | null | undefined)[]): string | null {
  const filtered = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  return filtered.length > 0 ? filtered.join(", ") : null;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
