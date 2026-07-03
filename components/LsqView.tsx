"use client";

// Settings → CRM. Owner-only configuration / status page for
// the LSQ CRM integration. Configuration lives in .env.local
// (LSQ_HOST + LSQ_ACCESS_KEY + LSQ_SECRET_KEY) — this page only shows
// whether each is set and offers a "Test connection" button that
// pings LSQ with the configured creds.
//
// Future phases will add: lead push on contact create, lead update on
// chat events, lead lookup in the contact panel, etc.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  Loader2,
  Megaphone,
  Phone,
  Plus,
  PlugZap,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LeadDefaultsEditor, type LeadDefault } from "@/components/AutomationView";
import { FB_AD_SOURCES } from "@/lib/utm";
import { PremiumHeader } from "@/components/PremiumHeader";
import { LsqBackfillPanel } from "@/components/settings/LsqBackfillPanel";
import { LsqFirstChatFillPanel } from "@/components/settings/LsqFirstChatFillPanel";
import { LsqPushFailuresPanel } from "@/components/settings/LsqPushFailuresPanel";
import { LsqWebhookEventsPanel } from "@/components/settings/LsqWebhookEventsPanel";
import { LsqWebhookGenerator } from "@/components/settings/LsqWebhookGenerator";
import { NightlySyncPanel } from "@/components/settings/NightlySyncPanel";

interface Status {
  host_set: boolean;
  access_key_set: boolean;
  secret_key_set: boolean;
  host_value: string;
  configured: boolean;
}

interface PingResult {
  ok: boolean;
  status: number;
  error: string | null;
}

export function LsqView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/lsq/status", { cache: "no-store" });
        const json = (await res.json()) as Status & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setLoadErr(json.error ?? `HTTP ${res.status}`);
          return;
        }
        setStatus(json);
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTest() {
    setPinging(true);
    setPingResult(null);
    try {
      const res = await fetch("/api/lsq/ping", { method: "POST" });
      const json = (await res.json()) as PingResult & { error?: string };
      setPingResult(json);
    } catch (e) {
      setPingResult({
        ok: false,
        status: 0,
        error: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setPinging(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={Database}
        title="CRM"
        subtitle="CRM integration for lead capture, status sync, and activity logging."
        tone="violet"
        right={
          <a
            href="https://help.leadsquared.com/api-documentation/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30"
          >
            API docs
            <ExternalLink className="h-3 w-3" />
          </a>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <strong>Secrets stay in <span className="font-mono">.env.local</span>.</strong>{" "}
              Configure <span className="font-mono">LSQ_HOST</span>,{" "}
              <span className="font-mono">LSQ_ACCESS_KEY</span>, and{" "}
              <span className="font-mono">LSQ_SECRET_KEY</span> in your env file
              and restart the server. This page never displays the keys
              themselves.
            </div>
          </div>

          {loadErr ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loadErr}
            </div>
          ) : null}

          {/* Connection status card */}
          <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
              <div className="flex items-center gap-2">
                <PlugZap className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Connection</h2>
              </div>
              {status ? (
                status.configured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Configured
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Incomplete
                  </span>
                )
              ) : null}
            </header>

            <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
              <EnvField
                label="Host"
                envName="LSQ_HOST"
                set={!!status?.host_set}
                value={status?.host_value || null}
                hint="e.g. https://api-in21.leadsquared.com"
              />
              <EnvField
                label="Access Key"
                envName="LSQ_ACCESS_KEY"
                set={!!status?.access_key_set}
                value={null}
                hint="Public-side credential pair"
              />
              <EnvField
                label="Secret Key"
                envName="LSQ_SECRET_KEY"
                set={!!status?.secret_key_set}
                value={null}
                hint="Treat like a password"
              />
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-secondary/30 px-5 py-3">
              <div className="text-[11px] text-muted-foreground">
                Test the connection to verify the keys authenticate against the host.
              </div>
              <button
                type="button"
                onClick={handleTest}
                disabled={pinging || !status?.configured}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pinging ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                Test connection
              </button>
            </footer>

            {pingResult ? (
              <div
                className={cn(
                  "border-t px-5 py-3 text-xs",
                  pingResult.ok
                    ? "border-emerald-100 bg-emerald-50/50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900",
                )}
              >
                {pingResult.ok ? (
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Connection OK · LSQ responded with HTTP {pingResult.status}.
                  </span>
                ) : (
                  <span className="inline-flex items-start gap-1.5 font-medium">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Connection failed
                      {pingResult.status > 0 ? ` · HTTP ${pingResult.status}` : ""}
                      {pingResult.error ? ` — ${pingResult.error}` : ""}
                    </span>
                  </span>
                )}
              </div>
            ) : null}
          </section>

          {/* Live webhook — CRM pushes every lead-stage change here so
              the inbox reflects it without a re-sync. */}
          <LsqWebhookGenerator />

          {/* Full payload log of recent webhook events (form submissions etc.). */}
          <LsqWebhookEventsPanel />

          {/* One-time bulk backfill — exports CRM leads and caches stage /
              lead # / owner on matching contacts. */}
          <LsqBackfillPanel configured={!!status?.configured} />

          {/* Backfill Source/Sub-source onto blank leads from the number the
              client first chatted on. */}
          <LsqFirstChatFillPanel configured={!!status?.configured} />

          {/* Failed pushes (rate-limit) + auto-retry status. */}
          <LsqPushFailuresPanel />

          {/* Nightly Evolution → CRM sync, scheduled by IST clock time. */}
          <NightlySyncPanel configured={!!status?.configured} />

          <EvolutionLeadCreateToggle configured={!!status?.configured} />

          <LeadDefaultsPerNumber configured={!!status?.configured} />

          {/* Live feature list — all shipped except Stage transitions */}
          <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <header className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">What this integration does</h2>
              <p className="text-[11px] text-muted-foreground">
                Per-number toggles for each feature live under Settings → Capabilities.
              </p>
            </header>
            <ul className="divide-y">
              <FeatureRow
                state="now"
                title="Connection auth"
                description="Verify LSQ host + access/secret keys from this page."
              />
              <FeatureRow
                state="now"
                title="Auto-create lead on first inbound"
                description="When a new contact messages your WhatsApp number, push them to LSQ as a fresh lead with the Source / Sub Source defaults you set above. Existing leads are only re-attributed when 'Also update existing leads' is ON for that number."
              />
              <FeatureRow
                state="now"
                title="Lead lookup in contact panel"
                description="Show CRM lead score, owner, stage, and recent activity inline next to the chat."
              />
              <FeatureRow
                state="now"
                title="Activity log on every reply"
                description="Each outbound message + each AI reply gets logged as a ProspectActivity in LSQ for the lead."
              />
              <FeatureRow
                state="planned"
                title="Stage transitions"
                description="Update CRM stage when an agent marks a chat as resolved or applies a specific tag."
              />
            </ul>
          </section>

          <section className="rounded-xl border bg-card px-5 py-4 text-xs">
            <div className="font-semibold">Where do I find these keys?</div>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
              <li>Log in to CRM as an admin.</li>
              <li>
                Settings → API and Webhooks → <strong>API Access Credentials</strong>.
              </li>
              <li>
                Copy <span className="font-mono">Access Key</span> and{" "}
                <span className="font-mono">Secret Key</span> for the user you want
                this integration to act as.
              </li>
              <li>
                The <span className="font-mono">Host</span> is the API URL shown on
                that page (region-specific, e.g.{" "}
                <span className="font-mono">api-in21.leadsquared.com</span>).
              </li>
              <li>
                Paste all three into <span className="font-mono">.env.local</span>{" "}
                and restart the server.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

function EnvField({
  label,
  envName,
  set,
  value,
  hint,
}: {
  label: string;
  envName: string;
  set: boolean;
  value: string | null;
  hint: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {set ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        )}
      </div>
      <div className="mt-1 truncate rounded-md border bg-secondary/40 px-2 py-1 font-mono text-[11px]">
        {set ? (value ?? "set") : "—"}
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">
        <span className="font-mono">{envName}</span> · {hint}
      </div>
    </div>
  );
}

interface NumberRow {
  business_phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname?: string | null;
  provider?: string | null;
  portfolio?: { key: string; name: string; provider: string } | null;
  config: {
    lead_defaults: LeadDefault[] | null;
    update_lead_fields?: LeadDefault[] | null;
    update_existing_lead_source?: boolean | null;
    update_existing_lead_max_age_days?: number | null;
    lsq_activity_log_enabled?: boolean | null;
    activity_note_suffix?: string | null;
    lsq_fb_ads_fields?: FbAdsField[] | null;
    lsq_lead_create_enabled?: boolean | null;
  } | null;
}

interface FbAdsField {
  lsq_field: string;
  source: string;
}

// Workspace-wide kill switch for CRM lead creation from Evolution
// (Baileys) numbers. When OFF, every Evolution-provider inbound skips
// the LSQ /ensure-lead path — useful when those numbers flood the CRM
// with junk leads. Meta numbers are unaffected.
function EvolutionLeadCreateToggle({ configured }: { configured: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/lsq/evolution-toggle", {
          cache: "no-store",
        });
        const j = (await res.json()) as { enabled?: boolean; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setErr(j.error ?? `HTTP ${res.status}`);
          return;
        }
        setEnabled(j.enabled ?? true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function flip(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/lsq/evolution-toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setEnabled(next);
      setSavedFlash(next ? "Evolution leads ON." : "Evolution leads OFF.");
      setTimeout(() => setSavedFlash(null), 1500);
    } finally {
      setBusy(false);
    }
  }

  if (!configured) return null;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Evolution → CRM lead creation</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Global kill switch for all Evolution (Baileys) WhatsApp numbers.
          When OFF, no leads are created in LSQ from any Evolution number.
          Meta numbers keep working normally.
        </p>
      </header>
      <div className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Create CRM leads from Evolution numbers</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Turn OFF if Evolution-side inbounds are pushing too many junk
            leads into LSQ. Re-enable any time.
          </div>
          {err ? (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
              {err}
            </div>
          ) : null}
          {savedFlash ? (
            <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
              <Check className="h-3 w-3" /> {savedFlash}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          onClick={() => enabled !== null && flip(!enabled)}
          disabled={busy || enabled === null}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 rounded-full transition",
            enabled ? "bg-violet-600" : "bg-slate-300",
            (busy || enabled === null) && "opacity-50",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-all",
              enabled ? "left-[1.4rem]" : "left-0.5",
            )}
          />
        </button>
      </div>
    </section>
  );
}

function LeadDefaultsPerNumber({ configured }: { configured: boolean }) {
  const [rows, setRows] = useState<NumberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Which portfolio groups are expanded. Collapsed by default; the group
  // holding the active number auto-opens.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/automation/config", { cache: "no-store" });
      const json = (await res.json()) as { rows?: NumberRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      if (!activeId && json.rows?.length) {
        setActiveId(json.rows[0].business_phone_number_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(
    () => rows?.find((r) => r.business_phone_number_id === activeId) ?? null,
    [rows, activeId],
  );

  // Numbers grouped by portfolio, honouring the search box.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const m = new Map<string, NumberRow[]>();
    for (const r of rows ?? []) {
      if (
        q &&
        !(
          (r.nickname ?? "").toLowerCase().includes(q) ||
          (r.verified_name ?? "").toLowerCase().includes(q) ||
          (r.display_phone_number ?? "").toLowerCase().includes(q) ||
          r.business_phone_number_id.includes(q)
        )
      )
        continue;
      const name = r.portfolio?.name || "Other";
      (m.get(name) ?? m.set(name, []).get(name)!).push(r);
    }
    return [...m.entries()];
  }, [rows, search]);

  // Auto-open the group that holds the active number.
  useEffect(() => {
    const activeGroup = (rows ?? []).find(
      (r) => r.business_phone_number_id === activeId,
    )?.portfolio?.name;
    if (activeGroup) setOpenGroups((s) => new Set(s).add(activeGroup));
  }, [rows, activeId]);

  // While searching, expand every matching group so results are visible.
  const searching = search.trim().length > 0;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Lead defaults per number</h2>
            <p className="text-[11px] text-muted-foreground">
              Source / Sub Source / SourceMedium etc. stamped on every lead
              created from each WhatsApp number — applies whether the AI is
              enabled or not.
            </p>
          </div>
        </div>
      </header>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <div className="grid h-32 place-items-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">
          No business numbers connected yet.
        </div>
      ) : (
        <div className="grid gap-0 lg:grid-cols-[300px_1fr]">
          {/* Number picker rail — grouped by portfolio, collapsible. */}
          <nav className="flex flex-col gap-1 border-b bg-secondary/30 p-2.5 lg:max-h-[80vh] lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or number…"
              className="mb-1 w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
            />
            {groups.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {searching ? "No match." : "No numbers."}
              </div>
            ) : (
              groups.map(([portfolio, opts]) => {
                const open = searching || openGroups.has(portfolio);
                return (
                  <div key={portfolio}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenGroups((s) => {
                          const next = new Set(s);
                          if (next.has(portfolio)) next.delete(portfolio);
                          else next.add(portfolio);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary"
                    >
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <Building2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{portfolio}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
                        {opts.length}
                      </span>
                    </button>
                    {open ? (
                      <div className="mb-1 flex flex-col gap-1 pl-2">
                        {opts.map((r) => {
                          const isActive = r.business_phone_number_id === activeId;
                          const overrideCount = (r.config?.lead_defaults ?? []).length;
                          return (
                            <button
                              key={r.business_phone_number_id}
                              type="button"
                              onClick={() => setActiveId(r.business_phone_number_id)}
                              className={cn(
                                "flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left transition",
                                isActive
                                  ? "border-primary/40 bg-primary/5"
                                  : "border-transparent hover:bg-secondary",
                              )}
                            >
                              <span className="min-w-0 leading-tight">
                                <span className="block truncate text-xs font-medium">
                                  {r.nickname || r.verified_name || r.display_phone_number || r.business_phone_number_id}
                                </span>
                                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                  {r.display_phone_number || r.business_phone_number_id}
                                </span>
                              </span>
                              {overrideCount > 0 ? (
                                <span className="inline-flex h-5 shrink-0 items-center justify-center rounded-full bg-violet-50 px-1.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-100">
                                  {overrideCount}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </nav>

          {/* Editor */}
          <div className="min-w-0">
            {active ? (
              <LeadDefaultsForNumber
                key={active.business_phone_number_id}
                row={active}
                disabled={!configured}
                onSaved={load}
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function LeadDefaultsForNumber({
  row,
  disabled,
  onSaved,
}: {
  row: NumberRow;
  disabled: boolean;
  onSaved: () => void;
}) {
  const initial = row.config?.lead_defaults ?? [];
  const initialUpdateFields = row.config?.update_lead_fields ?? [];
  const initialUpdateExisting = row.config?.update_existing_lead_source === true;
  const initialMaxAge = row.config?.update_existing_lead_max_age_days ?? null;
  // Activity logging defaults to ON when the column is null (matches the
  // capability flag default in Settings → Capabilities).
  const initialActivityLog = row.config?.lsq_activity_log_enabled !== false;
  const initialSuffix = row.config?.activity_note_suffix ?? "";
  const initialFbAds = row.config?.lsq_fb_ads_fields ?? [];
  const [fbAds, setFbAds] = useState<FbAdsField[]>(initialFbAds);
  const [defaults, setDefaults] = useState<LeadDefault[]>(initial);
  const [updateFields, setUpdateFields] = useState<LeadDefault[]>(initialUpdateFields);
  const [updateExisting, setUpdateExisting] = useState<boolean>(initialUpdateExisting);
  const [maxAgeDays, setMaxAgeDays] = useState<string>(
    initialMaxAge != null ? String(initialMaxAge) : "",
  );
  const [activityLog, setActivityLog] = useState<boolean>(initialActivityLog);
  const [suffix, setSuffix] = useState<string>(initialSuffix);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (JSON.stringify(initial) !== JSON.stringify(defaults)) return true;
    if (JSON.stringify(initialUpdateFields) !== JSON.stringify(updateFields)) return true;
    if (updateExisting !== initialUpdateExisting) return true;
    const parsed = maxAgeDays.trim() === "" ? null : Number(maxAgeDays);
    const initialParsed = initialMaxAge ?? null;
    if (parsed !== initialParsed) return true;
    if (activityLog !== initialActivityLog) return true;
    if (suffix !== initialSuffix) return true;
    if (JSON.stringify(initialFbAds) !== JSON.stringify(fbAds)) return true;
    return false;
  }, [
    initial,
    defaults,
    initialUpdateFields,
    updateFields,
    updateExisting,
    initialUpdateExisting,
    maxAgeDays,
    initialMaxAge,
    activityLog,
    initialActivityLog,
    suffix,
    initialSuffix,
    initialFbAds,
    fbAds,
  ]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const parsed = maxAgeDays.trim() === "" ? null : Number(maxAgeDays);
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 3650)) {
        throw new Error("Max age must be 0–3650 days or blank.");
      }
      const res = await fetch("/api/automation/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: row.business_phone_number_id,
          lead_defaults: defaults,
          update_lead_fields: updateFields,
          update_existing_lead_source: updateExisting,
          update_existing_lead_max_age_days: parsed,
          lsq_activity_log_enabled: activityLog,
          activity_note_suffix: suffix,
          lsq_fb_ads_fields: fbAds.filter((f) => f.lsq_field.trim() && f.source),
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="border-b bg-secondary/20 px-5 py-2.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Phone className="h-3 w-3" />
          {row.verified_name || row.display_phone_number || row.business_phone_number_id}
          {row.display_phone_number ? (
            <span className="font-mono">· {row.display_phone_number}</span>
          ) : null}
        </span>
      </div>

      <LeadDefaultsEditor defaults={defaults} onChange={setDefaults} />

      {/* Activity logging — toggle + suffix. When ON, every inbound +
          outbound + AI reply on this number gets logged as a
          ProspectActivity in LSQ. Suffix appears as " - (<text>)" on
          each activity note so LSQ reports can group by source. */}
      <div className="border-t bg-sky-50/40 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-sky-400 text-sky-600 focus:ring-sky-400"
                checked={activityLog}
                onChange={(e) => setActivityLog(e.target.checked)}
              />
              <span>
                <span className="block text-sm font-medium">
                  Log activities to LSQ
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  When ON, every message on this number gets logged as a
                  ProspectActivity against the matching lead. OFF = no
                  activity pushes (lead still gets created on first inbound).
                </span>
              </span>
            </label>
          </div>
          <div className="shrink-0">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Activity note suffix
            </label>
            <input
              type="text"
              maxLength={200}
              placeholder="e.g. Insta WA 9084723091"
              value={suffix}
              disabled={!activityLog}
              onChange={(e) => setSuffix(e.target.value)}
              className="mt-1 w-64 rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:cursor-not-allowed disabled:bg-secondary/60 disabled:opacity-60"
            />
            <div className="mt-1 text-[10px] text-muted-foreground">
              Appears as: <span className="font-mono">{`<message> - (${suffix || "auto"})`}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Re-attribution controls (0027). Off by default — preserves the
          original Source on existing LSQ leads. Operator opts in. */}
      <div className="border-t bg-amber-50/40 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-400 text-amber-600 focus:ring-amber-400"
                checked={updateExisting}
                onChange={(e) => setUpdateExisting(e.target.checked)}
              />
              <span>
                <span className="block text-sm font-medium">
                  Also update existing leads&apos; source
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  When ON, an inbound from a phone that already has an LSQ lead
                  will patch the fields you pick below. When OFF (default),
                  original attribution stays untouched.
                </span>
              </span>
            </label>
          </div>
          <div className="shrink-0">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Max lead age (days)
            </label>
            <input
              type="number"
              min={0}
              max={3650}
              step={1}
              inputMode="numeric"
              placeholder="any age"
              value={maxAgeDays}
              disabled={!updateExisting}
              onChange={(e) => setMaxAgeDays(e.target.value)}
              className="mt-1 w-32 rounded-md border bg-background px-2 py-1.5 text-sm font-mono shadow-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-not-allowed disabled:bg-secondary/60 disabled:opacity-60"
            />
            <div className="mt-1 text-[10px] text-muted-foreground">
              Blank = no age cap.
            </div>
          </div>
        </div>

        {/* Which fields to patch on existing leads — same add/remove editor
            as the create defaults, but a separate list so update ≠ create. */}
        {updateExisting ? (
          <div className="mt-3 rounded-lg border bg-card">
            <LeadDefaultsEditor
              defaults={updateFields}
              onChange={setUpdateFields}
              title="Fields to update on existing leads"
              subtitle="Only these get patched on a lead that already exists. Empty = use the create defaults above."
            />
          </div>
        ) : null}
      </div>

      {/* Facebook Ads fields — map Meta ad-attribution values captured on
          the contact (Source ID, Ad Click ID, Campaign …) to LSQ schema
          fields, so they get posted to the CRM lead. */}
      <div className="border-t bg-indigo-50/40 px-5 py-4">
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-indigo-600" />
          <div>
            <h3 className="text-sm font-medium">Facebook Ads fields</h3>
            <p className="text-[11px] text-muted-foreground">
              CTWA lead ka attribution value (Source ID, Ad Click ID, Campaign,
              Ad set, Ad) chuni hui LSQ schema field me post hoga. Source ID aur
              Ad Click ID turant milte hain; Campaign/Ad set/Ad tabhi jab
              attribution resolve ho jaye.
            </p>
          </div>
        </div>
        <div className="mt-3">
          <FbAdsEditor fields={fbAds} onChange={setFbAds} />
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t bg-secondary/30 px-5 py-3">
        <div className="text-xs text-muted-foreground">
          {!disabled ? null : "CRM keys not configured — defaults won't apply yet."}
          {err ? (
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" /> {err}
            </span>
          ) : savedAt ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : dirty ? (
            "Unsaved changes"
          ) : (
            "All saved"
          )}
        </div>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save defaults
        </button>
      </footer>
    </div>
  );
}

// Editor for the Facebook-ad → CRM field mappings. Each row picks which
// ad value (Source ID / Ad Click ID / Campaign …) flows into which LSQ
// schema field. Mirrors LeadDefaultsEditor's add/remove pattern.
function FbAdsEditor({
  fields,
  onChange,
}: {
  fields: FbAdsField[];
  onChange: (next: FbAdsField[]) => void;
}) {
  function update(i: number, patch: Partial<FbAdsField>) {
    onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function remove(i: number) {
    onChange(fields.filter((_, idx) => idx !== i));
  }
  function add(source: string) {
    onChange([...fields, { lsq_field: "", source }]);
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b bg-secondary/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Ad value → LSQ schema field
      </div>
      {fields.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Abhi koi field nahi. Neeche se add karo.
        </div>
      ) : (
        <ul className="divide-y">
          {fields.map((f, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-2">
              <select
                value={f.source}
                onChange={(e) => update(i, { source: e.target.value })}
                className="w-36 shrink-0 rounded-md border bg-background px-2 py-1.5 text-xs shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                {FB_AD_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="shrink-0 text-muted-foreground">→</span>
              <input
                type="text"
                placeholder="LSQ schema field (e.g. mx_Ad_Click_Id)"
                value={f.lsq_field}
                onChange={(e) => update(i, { lsq_field: e.target.value })}
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm font-mono shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50"
                aria-label="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5 border-t bg-secondary/20 px-3 py-2">
        {FB_AD_SOURCES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => add(s.key)}
            className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[11px] font-medium hover:bg-secondary"
          >
            <Plus className="h-3 w-3 text-indigo-600" /> {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FeatureRow({
  state,
  title,
  description,
}: {
  state: "now" | "next" | "planned";
  title: string;
  description: string;
}) {
  const tone = {
    now:    { ring: "ring-emerald-200", bg: "bg-emerald-50", text: "text-emerald-700", label: "Live" },
    next:   { ring: "ring-amber-200",   bg: "bg-amber-50",   text: "text-amber-800",   label: "Next" },
    planned:{ ring: "ring-border",      bg: "bg-secondary",  text: "text-muted-foreground", label: "Later" },
  }[state];
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
          tone.ring,
          tone.bg,
          tone.text,
        )}
      >
        {tone.label}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
    </li>
  );
}
