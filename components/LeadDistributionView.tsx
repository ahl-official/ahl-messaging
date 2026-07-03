"use client";

import { useEffect, useMemo, useState } from "react";
import { Split, Copy, Check, RefreshCcw, Plus, Pencil, Trash2, Users, Webhook, UserPlus, Activity, CheckSquare, Timer, X, type LucideIcon } from "lucide-react";
import { PremiumHeader } from "@/components/PremiumHeader";
import { SearchableMultiSelect } from "@/components/SearchableMultiSelect";
import { LeadAutomationFlow } from "@/components/automation/LeadAutomationFlow";
import { cn } from "@/lib/utils";

// Render a UTC timestamp as IST (Asia/Kolkata) — the run_at values are stored
// in UTC, so the report must convert them or the "Scheduled" time reads wrong.
function istDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

interface Config {
  enabled: boolean;
  webhook_secret: string | null;
  stages: string[];
  brands: string[];
  sources: string[];
  working_start: string;
  working_end: string;
}
interface Agent {
  lsq_id: string;
  agent_name: string;
  agent_email: string;
  priority: string | null;
  daily_cap: number;
  week_off: string | null;
  leads_today: number;
  is_active: boolean;
  international_lead: string | null;
  assigned_total?: number;
}

interface StageGroup {
  id: string;
  name: string;
  stages: string[];
  agent_ids: string[];
  brands: string[];
  enabled: boolean;
  priority: number;
  working_start: string;
  working_end: string;
}

const INTL_TAGS = ["", "English International", "Hindi International"];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function LeadDistributionView() {
  const [config, setConfig] = useState<Config | null>(null);
  const [serverUrl, setServerUrl] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<StageGroup[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [brandValues, setBrandValues] = useState<string[]>(["American Hairline", "Alchemane"]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"setup" | "agents" | "executions" | "report" | "lsq" | "automations">("setup");

  // Safe JSON fetch — returns null on any failure (404 HTML page, network,
  // non-JSON) instead of throwing, so one missing endpoint (e.g. a route not
  // yet deployed) doesn't break the whole page.
  async function getJson<T>(url: string): Promise<T | null> {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }

  async function loadAll() {
    const [c, a, g] = await Promise.all([
      getJson<{ config: Config | null; webhook_url: string }>("/api/lead-distribution/config"),
      getJson<{ agents: Agent[] }>("/api/lead-distribution/agents"),
      getJson<{ groups: StageGroup[] }>("/api/lead-distribution/groups"),
    ]);
    if (c) {
      setConfig(c.config ?? null);
      setServerUrl(c.webhook_url ?? "");
    } else {
      setErr("Config load nahi hui — server par deploy + migration check karo.");
    }
    setAgents(a?.agents ?? []);
    setGroups(g?.groups ?? []);
  }
  useEffect(() => {
    loadAll();
    getJson<{ stages?: string[] }>("/api/lsq/stages").then((j) =>
      setStages(Array.isArray(j?.stages) ? (j!.stages as string[]) : []),
    );
    getJson<{ fields?: { schema: string; values: string[] }[] }>("/api/lsq/field-values").then((j) => {
      const fields = j?.fields ?? [];
      const brand = fields.find((f) => f.schema.toLowerCase() === "mx_brand");
      const brandVals = Array.isArray(brand?.values) ? brand!.values : [];
      // Always include the two known brands; merge any LSQ-returned values.
      setBrandValues(Array.from(new Set(["American Hairline", "Alchemane", ...brandVals])));
    });
  }, []);

  const webhookUrl = useMemo(() => {
    // Server builds it from NEXT_PUBLIC_APP_URL (live domain on the deployed
    // server). Fall back to the page origin only if that env isn't set.
    if (serverUrl && !serverUrl.startsWith("/api")) return serverUrl;
    if (!config?.webhook_secret) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/api/lead-distribution/webhook/${config.webhook_secret}`;
  }, [serverUrl, config?.webhook_secret]);

  async function saveConfig(patch: Partial<Config> & { regenerate_secret?: boolean }) {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/lead-distribution/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setConfig(j.config);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={Split}
        title="Lead Distribution"
        subtitle="Incoming CRM leads ko agents ke beech distribute karo — working hours, region, cap, priority ke hisaab se."
        tone="emerald"
        right={
          config ? (
            <button
              type="button"
              onClick={() => saveConfig({ enabled: !config.enabled })}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 backdrop-blur transition",
                config.enabled
                  ? "bg-emerald-400/20 text-white ring-emerald-300/40"
                  : "bg-white/15 text-white ring-white/25 hover:bg-white/25",
              )}
            >
              {config.enabled ? "Enabled" : "Disabled"}
            </button>
          ) : null
        }
      />

      {/* Tabs */}
      <div className="border-b bg-card px-6">
        <div className="mx-auto flex max-w-3xl gap-1">
          {(["setup", "agents", "executions", "report", "lsq", "automations"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "border-b-2 px-3 py-2.5 text-xs font-semibold capitalize transition whitespace-nowrap",
                tab === t
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "agents" ? "Agent priority" : t === "executions" ? "Executions" : t === "report" ? "Report" : t === "lsq" ? "CRM lead assignment" : t === "automations" ? "Lead automations" : "Setup"}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "executions" ? (
          <ExecutionsPanel lsqStages={stages} />
        ) : tab === "report" ? (
          <ReportPanel allAgents={agents} />
        ) : tab === "lsq" ? (
          <LsqAssignmentPanel lsqStages={stages} />
        ) : tab === "automations" ? (
          <AutomationsPanel webhookUrl={webhookUrl} lsqStages={stages} />
        ) : tab === "agents" ? (
          <div className="mx-auto max-w-5xl px-6 py-6">
            <AgentsSection agents={agents} days={DAYS} lsqStages={stages} onChanged={loadAll} />
          </div>
        ) : (
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {err}
            </div>
          ) : null}
          {config === null ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              {/* Master ON/OFF — when ON, leads get assigned in LSQ. */}
              <section
                className={cn(
                  "flex items-center gap-3 rounded-2xl border p-4 shadow-sm",
                  config.enabled ? "border-emerald-300 bg-emerald-50" : "bg-card",
                )}
              >
                <div className="flex-1">
                  <h2 className="text-sm font-bold">
                    Lead distribution — {config.enabled ? "ON (live)" : "OFF"}
                  </h2>
                  <p className="text-[11px] text-muted-foreground">
                    {config.enabled
                      ? "Leads automatically agents ko assign ho rahi hain (CRM me OwnerId set ho raha)."
                      : "Band hai — koi CRM assignment nahi. Live karne ke liye ON karo."}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.enabled}
                  disabled={saving}
                  onClick={() => saveConfig({ enabled: !config.enabled })}
                  title={config.enabled ? "Turn OFF" : "Turn ON (go live)"}
                  className={cn(
                    "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                    config.enabled ? "bg-emerald-600" : "bg-slate-300",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                      config.enabled ? "translate-x-6" : "translate-x-1",
                    )}
                  />
                </button>
              </section>

              {/* Webhook */}
              <section className="rounded-2xl border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <Webhook className="h-4 w-4 text-emerald-600" />
                  <h2 className="text-sm font-bold">Webhook URL</h2>
                  <span className="text-[11px] text-muted-foreground">CRM Automation me ye URL POST pe set karo.</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    readOnly
                    value={webhookUrl}
                    className="w-full rounded-md border bg-secondary/40 px-3 py-2 font-mono text-[11px] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(webhookUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2.5 py-2 text-xs font-semibold hover:bg-secondary"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </section>

              {/* Per-stage agent groups (brand + working hours per group) */}
              <GroupsSection groups={groups} agents={agents} stages={stages} brandValues={brandValues} onChanged={loadAll} />

              <p className="text-center text-[11px] text-muted-foreground">
                Sales agents / priority ab <b>Agent priority</b> tab me hai.
              </p>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

interface TriggerCondition {
  connector: "and" | "or";
  field: string;
  operator: string;
  value: string;
}
interface TriggerConfig {
  lead_field?: string;
  change_from?: string;
  change_to?: string;       // = start stage (lead enters automation here)
  exit_stage?: string;      // lead exits automation when it reaches this stage
  run_once?: boolean;
  exit_condition?: string;
  conditions?: TriggerCondition[];
}
interface AutomationRow {
  id: string;
  name: string;
  trigger_type: string;
  scope: string;
  status: string;
  note: string | null;
  config: TriggerConfig | null;
  created_by: string | null;
  created_at: string;
}

interface ReportRow {
  mobile: string;
  lead_number: string;
  name: string;
  template: string;
  at: string;
}
interface ReportData {
  steps: number;
  sent: ReportRow[];
  failed: ReportRow[];
  queue: ReportRow[];
  scheduled: ReportRow[];
  recipients: number;
  completed: number;
  in_progress: number;
}

const COND_FIELDS = ["Lead Stage", "Lead Source", "Owner", "Mobile Number", "Phone Number", "Sub Source", "Brand"];
const COND_OPERATORS = ["is", "is not", "starts with", "contains"];
const LEAD_FIELDS = ["Lead Stage", "Lead Source", "Owner", "Mobile Number", "Phone Number"];

const TRIGGER_GROUPS: {
  category: string;
  icon: LucideIcon;
  triggers: { name: string; desc: string; recommended?: boolean }[];
}[] = [
  {
    category: "Lead Trigger",
    icon: UserPlus,
    triggers: [
      { name: "New Lead", desc: "When a new Lead is created or added", recommended: true },
      { name: "Lead Update", desc: "When a Lead field is updated or changed (e.g. stage → Photos Received)", recommended: true },
      { name: "Lead Added To List", desc: "When a Lead is added to a static list" },
      { name: "On a Specific Date", desc: "Such as birthday, renewal date etc." },
    ],
  },
  { category: "Activity Trigger", icon: Activity, triggers: [{ name: "Activity Trigger", desc: "When an activity is posted on a Lead" }] },
  { category: "User Trigger", icon: Users, triggers: [{ name: "User Trigger", desc: "When a user action happens" }] },
  { category: "Task Trigger", icon: CheckSquare, triggers: [{ name: "Task Trigger", desc: "When a task is created or completed" }] },
  { category: "At Regular Intervals", icon: Timer, triggers: [{ name: "At Regular Intervals", desc: "Run on a recurring schedule" }] },
];

// Mirrors LSQ's Automation screen: tracked automations on the left, a
// Create button + webhook + reports on the right. Create opens a centred
// modal to pick the trigger point, then name it — saved to our registry.
function AutomationsPanel({ webhookUrl, lsqStages }: { webhookUrl: string; lsqStages: string[] }) {
  const [rows, setRows] = useState<AutomationRow[] | null>(null);
  const [openRow, setOpenRow] = useState<AutomationRow | null>(null); // flow editor
  const [copied, setCopied] = useState(false);
  // Rename modal (in-app, centered — replaces the browser prompt).
  const [renameTarget, setRenameTarget] = useState<AutomationRow | null>(null);
  const [renameText, setRenameText] = useState("");
  // Run report for one automation — Sent / Failed / Queue + progress.
  const [reportRow, setReportRow] = useState<AutomationRow | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [reportTab, setReportTab] = useState<"sent" | "failed" | "queue" | "scheduled">("sent");
  const [reportSearch, setReportSearch] = useState("");
  function openReport(r: AutomationRow) {
    setReportRow(r);
    setReport(null);
    setReportTab("sent");
    setReportSearch("");
    fetch(`/api/lead-distribution/automations/report?id=${r.id}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((j: ReportData) => setReport(j))
      .catch(() => setReport({ steps: 0, sent: [], failed: [], queue: [], scheduled: [], recipients: 0, completed: 0, in_progress: 0 }));
  }
  const [creating, setCreating] = useState(false); // modal open
  const [picked, setPicked] = useState<string | null>(null); // selected trigger
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Trigger build (scratch) — mirrors LSQ's trigger detail.
  const [leadField, setLeadField] = useState("Lead Stage");
  const [changeFrom, setChangeFrom] = useState("Any Stage");
  const [changeTo, setChangeTo] = useState("");
  const [runOnce, setRunOnce] = useState(false);
  const [scope, setScope] = useState("Global");
  const [exitStage, setExitStage] = useState("");
  const [exitCondition, setExitCondition] = useState("");
  const [conditions, setConditions] = useState<TriggerCondition[]>([]);
  const isLeadUpdate = picked === "Lead Update";

  async function load() {
    // Retry once on a network-level reject ("Failed to fetch") — e.g. a dev
    // HMR recompile or a brief blip — so the panel self-heals instead of
    // sticking on the error.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/lead-distribution/automations", { cache: "no-store" });
        const json = (await res.json()) as { automations?: AutomationRow[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setRows(json.automations ?? []);
        setErr(null);
        return;
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        setErr(e instanceof Error ? e.message : "Load failed");
        setRows([]);
      }
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function openCreate() {
    setPicked(null);
    setName("");
    setErr(null);
    setLeadField("Lead Stage");
    setChangeFrom("Any Stage");
    setChangeTo("");
    setRunOnce(false);
    setScope("Global");
    setExitStage("");
    setExitCondition("");
    setConditions([]);
    setCreating(true);
  }

  async function save() {
    if (!picked || !name.trim()) return;
    setSaving(true);
    setErr(null);
    const config: TriggerConfig = {
      run_once: runOnce,
      exit_stage: exitStage.trim() || undefined,
      exit_condition: exitCondition.trim() || undefined,
      conditions: conditions.filter((c) => c.field && c.value.trim()),
    };
    if (isLeadUpdate) {
      config.lead_field = leadField;
      config.change_from = changeFrom;
      config.change_to = changeTo;
    }
    try {
      const res = await fetch("/api/lead-distribution/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), trigger_type: picked, scope, config }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCreating(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this automation from the list?")) return;
    await fetch(`/api/lead-distribution/automations?id=${id}`, { method: "DELETE" });
    await load();
  }

  function rename(row: AutomationRow) {
    setRenameTarget(row);
    setRenameText(row.name);
  }

  async function saveRename() {
    const row = renameTarget;
    if (!row) return;
    const next = renameText.trim();
    setRenameTarget(null);
    if (!next || next === row.name) return;
    setRows((prev) => prev?.map((x) => (x.id === row.id ? { ...x, name: next } : x)) ?? prev);
    await fetch(`/api/lead-distribution/automations?id=${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    }).catch(() => load());
  }

  async function toggleStatus(row: AutomationRow) {
    const next = row.status === "Published" ? "Draft" : "Published";
    setRows((prev) => prev?.map((x) => (x.id === row.id ? { ...x, status: next } : x)) ?? prev);
    await fetch(`/api/lead-distribution/automations?id=${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    }).catch(() => load());
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left — tracked automations list */}
        <div className="min-w-0 flex-1 rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-bold">Automation</h2>
            <span className="text-[11px] text-muted-foreground">{rows?.length ?? 0} tracked</span>
          </div>
          {err ? (
            <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>
          ) : null}
          {rows === null ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              Abhi koi automation track nahi. LSQ me automation banao, phir yahan <b>Create automation</b> se uska naam + trigger record karo.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Trigger Type</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Created</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-secondary/30">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => setOpenRow(r)} className="font-semibold text-emerald-700 hover:underline">
                            {r.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => rename(r)}
                            className="rounded p-0.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
                            title="Rename"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div>{r.trigger_type}</div>
                        {r.config?.change_to ? (
                          <div className="text-[10px] text-muted-foreground">
                            {(r.config.change_from || "Any")} → {r.config.change_to}
                          </div>
                        ) : null}
                        {r.config?.conditions?.length ? (
                          <div className="text-[10px] text-muted-foreground">{r.config.conditions.length} condition(s)</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={r.status === "Published"}
                            onClick={() => toggleStatus(r)}
                            title={r.status === "Published" ? "On (live) — click to turn off" : "Off (draft) — click to turn on"}
                            className={cn(
                              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                              r.status === "Published" ? "bg-emerald-600" : "bg-slate-300",
                            )}
                          >
                            <span className={cn("inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform", r.status === "Published" ? "translate-x-4" : "translate-x-1")} />
                          </button>
                          <span className={cn("text-[10px] font-semibold", r.status === "Published" ? "text-emerald-700" : "text-muted-foreground")}>
                            {r.status === "Published" ? "On" : "Off"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{(r.created_at || "").slice(0, 10)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => openReport(r)}
                          className="mr-1 rounded p-1 text-muted-foreground hover:bg-emerald-50 hover:text-emerald-700"
                          title="Report — sent count + numbers"
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(r.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right — create + webhook + reports */}
        <aside className="w-full shrink-0 space-y-3 lg:w-72">
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-rose-700 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-800"
          >
            <Plus className="h-4 w-4" /> Create automation
          </button>

          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-3 shadow-sm">
            <div className="flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              <h3 className="text-xs font-bold text-emerald-900">Webhook connected</h3>
            </div>
            <p className="mt-1 text-[10px] text-emerald-800/80">
              Automations aapke existing CRM webhooks (Lead Stage Change) se hi chalti hain —
              koi alag webhook add karne ki zaroorat nahi.
            </p>
          </section>

          <section className="rounded-2xl border bg-card p-3 shadow-sm">
            <h3 className="text-xs font-bold">Related settings</h3>
            <div className="mt-1.5 flex flex-col gap-1 text-[11px] font-semibold text-emerald-700">
              <span className="cursor-default text-muted-foreground">Automation Failure Report</span>
              <span className="cursor-default text-muted-foreground">Automation Termination Report</span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Reports CRM ke andar hi available hain.</p>
          </section>
        </aside>
      </div>

      {/* Create modal — pick trigger point, then name it */}
      {creating ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreating(false)}>
          <div
            className="max-h-[85vh] w-full max-w-md overflow-auto rounded-xl bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-bold">{picked ? `Build trigger — ${picked}` : "When will your automation start?"}</h3>
              <button type="button" onClick={() => setCreating(false)} className="rounded p-1 hover:bg-secondary">
                <span className="text-lg leading-none text-muted-foreground">×</span>
              </button>
            </div>

            {!picked ? (
              <div className="space-y-4 p-4">
                {TRIGGER_GROUPS.map((g) => {
                  const GIcon = g.icon;
                  return (
                    <div key={g.category}>
                      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        <GIcon className="h-3.5 w-3.5" /> {g.category}
                      </div>
                      <div className="space-y-2">
                        {g.triggers.map((t) => (
                          <button
                            key={t.name}
                            type="button"
                            onClick={() => {
                              setPicked(t.name);
                              setName(t.name);
                            }}
                            className={cn(
                              "relative block w-full overflow-hidden rounded-lg border bg-background px-3 py-2.5 text-left transition hover:border-emerald-400 hover:bg-emerald-50/40",
                              t.recommended ? "border-emerald-300" : "border-input",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold">{t.name}</span>
                              {t.recommended ? (
                                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700">Distribution</span>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-500" />
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3 p-4">
                <div className="flex items-center justify-between rounded-md border bg-secondary/30 px-3 py-2 text-xs">
                  <span>Trigger: <b>{picked}</b></span>
                  <button type="button" onClick={() => setPicked(null)} className="text-emerald-700 hover:underline">
                    change
                  </button>
                </div>

                <label className="block text-xs font-semibold">
                  Automation name
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Photos Received → Distribution"
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-emerald-400"
                  />
                </label>

                {/* Lead Update — field + change from/to (LSQ trigger shape) */}
                {isLeadUpdate ? (
                  <>
                    <label className="block text-xs font-semibold">
                      Lead Field
                      <select
                        value={leadField}
                        onChange={(e) => setLeadField(e.target.value)}
                        className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm outline-none focus:border-emerald-400"
                      >
                        {LEAD_FIELDS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block text-xs font-semibold">
                        Changes from
                        <input
                          list="ld-stage-list"
                          value={changeFrom}
                          onChange={(e) => setChangeFrom(e.target.value)}
                          placeholder="Any Stage"
                          className="mt-1 w-full rounded-md border px-2 py-2 text-sm outline-none focus:border-emerald-400"
                        />
                      </label>
                      <label className="block text-xs font-semibold">
                        to — Start stage
                        <input
                          list="ld-stage-list"
                          value={changeTo}
                          onChange={(e) => setChangeTo(e.target.value)}
                          placeholder="Photos Received"
                          className="mt-1 w-full rounded-md border px-2 py-2 text-sm outline-none focus:border-emerald-400"
                        />
                      </label>
                    </div>
                    <datalist id="ld-stage-list">
                      {["Any Stage", ...lsqStages].map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </>
                ) : null}

                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-semibold">
                    Run once per Lead
                    <select
                      value={runOnce ? "Yes" : "No"}
                      onChange={(e) => setRunOnce(e.target.value === "Yes")}
                      className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm outline-none focus:border-emerald-400"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </label>
                  <label className="block text-xs font-semibold">
                    Scope
                    <select
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm outline-none focus:border-emerald-400"
                    >
                      <option>Global</option>
                      <option>Restricted</option>
                    </select>
                  </label>
                </div>

                <label className="block text-xs font-semibold">
                  Exit stage <span className="font-normal text-muted-foreground">(lead is stage par aaye to automation se nikal jaaye)</span>
                  <select
                    value={exitStage}
                    onChange={(e) => setExitStage(e.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm outline-none focus:border-emerald-400"
                  >
                    <option value="">— none —</option>
                    {lsqStages.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs font-semibold">
                  Exit condition <span className="font-normal text-muted-foreground">(optional, advanced)</span>
                  <input
                    value={exitCondition}
                    onChange={(e) => setExitCondition(e.target.value)}
                    placeholder="e.g. Lead Source is Junk"
                    className="mt-1 w-full rounded-md border px-2 py-2 text-sm outline-none focus:border-emerald-400"
                  />
                </label>

                {/* Conditions builder (field / operator / value, AND-OR) */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-semibold">Conditions</span>
                    <button
                      type="button"
                      onClick={() =>
                        setConditions((c) => [
                          ...c,
                          { connector: c.length === 0 ? "and" : "or", field: "Lead Stage", operator: "is", value: "" },
                        ])
                      }
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold hover:bg-secondary"
                    >
                      <Plus className="h-3 w-3" /> Add
                    </button>
                  </div>
                  {conditions.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No conditions — trigger fires for every matching lead.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {conditions.map((c, i) => (
                        <div key={i} className="flex items-center gap-1">
                          {i === 0 ? (
                            <span className="w-9 shrink-0 text-center text-[10px] font-bold uppercase text-muted-foreground">When</span>
                          ) : (
                            <select
                              value={c.connector}
                              onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, connector: e.target.value as "and" | "or" } : x)))}
                              className="w-9 shrink-0 rounded border bg-background px-0.5 py-1 text-center text-[10px] font-bold uppercase outline-none"
                            >
                              <option value="and">and</option>
                              <option value="or">or</option>
                            </select>
                          )}
                          <select
                            value={c.field}
                            onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                            className="min-w-0 flex-1 rounded border bg-background px-1 py-1 text-[11px] outline-none"
                          >
                            {COND_FIELDS.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
                          <select
                            value={c.operator}
                            onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}
                            className="shrink-0 rounded border bg-background px-1 py-1 text-[11px] outline-none"
                          >
                            {COND_OPERATORS.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                          <input
                            value={c.value}
                            list={c.field === "Lead Stage" ? "ld-stage-list" : undefined}
                            onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                            placeholder="value"
                            className="min-w-0 flex-1 rounded border px-1 py-1 text-[11px] outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {err ? <p className="text-xs text-destructive">{err}</p> : null}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setCreating(false)} className="rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-secondary">
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || !name.trim()}
                    onClick={save}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save trigger"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Full-screen flow editor for the clicked automation */}
      {openRow ? (
        <LeadAutomationFlow
          automation={{
            id: openRow.id,
            name: openRow.name,
            trigger_type: openRow.trigger_type,
            config: openRow.config as Record<string, unknown> | null,
          }}
          lsqStages={lsqStages}
          onClose={() => setOpenRow(null)}
          onSaved={load}
        />
      ) : null}

      {/* Rename automation — centered modal (replaces the browser prompt). */}
      {renameTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRenameTarget(null)}>
          <div className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold">Rename automation</h3>
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") setRenameTarget(null);
              }}
              className="mt-3 w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              placeholder="Automation name"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRenameTarget(null)} className="rounded-md border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary">
                Cancel
              </button>
              <button type="button" onClick={saveRename} className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Run report — Sent / Failed / Queue + per-number search history. */}
      {reportRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setReportRow(null)}>
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Activity className="h-4 w-4 text-emerald-600" />
              <h3 className="text-sm font-bold">{reportRow.name} — report</h3>
              <button type="button" onClick={() => setReportRow(null)} className="ml-auto rounded p-1 text-muted-foreground hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>
            {report === null ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              (() => {
                const q = reportSearch.trim().toLowerCase();
                const filter = (rows: ReportRow[]) =>
                  !q ? rows : rows.filter((r) => `${r.mobile} ${r.lead_number} ${r.name}`.toLowerCase().includes(q));
                const active =
                  reportTab === "failed" ? report.failed
                  : reportTab === "queue" ? report.queue
                  : reportTab === "scheduled" ? report.scheduled
                  : report.sent;
                const shown = filter(active);
                const progress = report.recipients ? Math.round((report.completed / report.recipients) * 100) : 0;
                return (
                  <>
                    {/* Stats + progress */}
                    <div className="border-b px-4 py-3">
                      <div className="grid grid-cols-4 gap-2">
                        {([
                          ["sent", "Sent", report.sent.length, "border-emerald-400 bg-emerald-50", "text-emerald-700"],
                          ["scheduled", "Scheduled", report.scheduled.length, "border-sky-400 bg-sky-50", "text-sky-700"],
                          ["failed", "Failed", report.failed.length, "border-rose-400 bg-rose-50", "text-rose-700"],
                          ["queue", "Queue", report.queue.length, "border-amber-400 bg-amber-50", "text-amber-700"],
                        ] as const).map(([key, label, n, activeCls, textCls]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setReportTab(key)}
                            className={cn(
                              "rounded-lg border p-2.5 text-center transition",
                              reportTab === key ? activeCls : "border-input hover:bg-secondary/40",
                            )}
                          >
                            <div className={cn("text-xl font-bold", textCls)}>{n}</div>
                            <div className="text-[11px] text-muted-foreground">{label}</div>
                          </button>
                        ))}
                      </div>
                      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="whitespace-nowrap font-semibold text-foreground">{report.completed}/{report.recipients} complete</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="whitespace-nowrap">{report.in_progress} in progress · {report.steps} steps</span>
                      </div>
                    </div>
                    {/* Search */}
                    <div className="border-b px-4 py-2">
                      <input
                        value={reportSearch}
                        onChange={(e) => setReportSearch(e.target.value)}
                        placeholder="Number / lead # / name se search karo…"
                        className="w-full rounded-md border bg-secondary/30 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400"
                      />
                    </div>
                    {/* List */}
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {shown.length === 0 ? (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                          {q ? "Is number/naam ka koi record nahi." : reportTab === "queue" ? "Queue khali hai." : reportTab === "scheduled" ? "Koi scheduled send nahi (send-time wale)." : reportTab === "failed" ? "Koi failed nahi." : "Abhi tak koi message nahi gaya."}
                        </div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <thead className="sticky top-0 bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <tr>
                              <th className="px-4 py-2 font-semibold">Number</th>
                              <th className="px-3 py-2 font-semibold">Lead #</th>
                              <th className="px-3 py-2 font-semibold">Name</th>
                              <th className="px-3 py-2 font-semibold">Template</th>
                              <th className="px-3 py-2 font-semibold">{reportTab === "queue" || reportTab === "scheduled" ? "Scheduled" : "When"}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((r, i) => (
                              <tr key={i} className="border-t hover:bg-secondary/20">
                                <td className="px-4 py-2 font-mono">{r.mobile || "—"}</td>
                                <td className="px-3 py-2 text-muted-foreground">{r.lead_number || "—"}</td>
                                <td className="px-3 py-2">{r.name || "—"}</td>
                                <td className="px-3 py-2 font-medium text-emerald-700">{r.template}</td>
                                <td className="px-3 py-2 text-muted-foreground">{istDateTime(r.at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                );
              })()
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExecutionsPanel({ lsqStages }: { lsqStages: string[] }) {
  interface Ev {
    id: string;
    created_at: string;
    mobile: string | null;
    region: string | null;
    status: string;
    assigned_agent: string | null;
    name: string | null;
    stage: string | null;
    lead_number: string | null;
    owner_email: string | null;
    owner_name: string | null;
    prospect_id?: string | null;
    brand?: string | null;
    fields?: Record<string, string>;
  }
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>("");
  const [brandFilter, setBrandFilter] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  // LSQ-fetched full field sets, keyed by prospect_id (authoritative — the
  // webhook payload omits mx_utm_source / mx_NDR_Reason).
  const [lsqFields, setLsqFields] = useState<Record<string, Record<string, string>>>({});

  // Friendly labels mapped to the correct LSQ schema names.
  const HIGHLIGHT: [string, string][] = [
    ["FirstName", "Name"],
    ["ProspectStage", "Stage"],
    ["Source", "Lead source"],
    ["mx_utm_source", "Sub source"],
    ["mx_NDR_Reason", "Latest source"],
    ["SourceMedium", "Source medium"],
    ["mx_Brand", "Brand"],
    ["OwnerIdEmailAddress", "Owner"],
    ["mx_Total_Outbound_Calls", "Call attempts"],
    ["ProspectID", "ProspectID"],
  ];

  async function expand(e: Ev) {
    if (open === e.id) {
      setOpen(null);
      return;
    }
    setOpen(e.id);
    const pid = e.prospect_id;
    if (pid && !lsqFields[pid]) {
      try {
        const r = await fetch(`/api/lead-distribution/lead-detail?prospectId=${encodeURIComponent(pid)}`, { cache: "no-store" });
        const j = (await r.json()) as { fields?: Record<string, string> };
        if (j.fields) setLsqFields((m) => ({ ...m, [pid]: j.fields! }));
      } catch {
        /* ignore — fall back to webhook fields */
      }
    }
  }

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/lead-distribution/events", { cache: "no-store" });
      const j = (await r.json()) as { events?: Ev[] };
      setEvents(j.events ?? []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const tint: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 ring-amber-200",
    assigned: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    skipped: "bg-slate-100 text-slate-500 ring-slate-200",
  };

  // Stage counts across the loaded events (for the dropdown labels).
  const evStageCounts = new Map<string, number>();
  for (const e of events ?? []) if (e.stage) evStageCounts.set(e.stage, (evStageCounts.get(e.stage) ?? 0) + 1);
  const stageOptions = Array.from(new Set([...lsqStages, ...evStageCounts.keys()])).sort((a, b) => {
    const ca = evStageCounts.get(a) ?? 0;
    const cb = evStageCounts.get(b) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.localeCompare(b);
  });
  const q = query.trim().toLowerCase();
  const brandOf = (e: Ev) => (e.brand ?? e.fields?.mx_Brand ?? e.fields?.Brand ?? "").trim();
  const shown = (events ?? []).filter((e) => {
    if (stageFilter && e.stage !== stageFilter) return false;
    if (brandFilter && brandOf(e).toLowerCase() !== brandFilter.toLowerCase()) return false;
    if (q) {
      const hay = `${e.mobile ?? ""} ${e.lead_number ?? ""} ${e.name ?? ""} ${e.owner_email ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // Brand options — known brands + any seen in the loaded events.
  const brandOptions = Array.from(
    new Set(["American Hairline", "Alchemane", ...(events ?? []).map(brandOf).filter(Boolean)]),
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">Webhook events</span>
        <span className="text-[11px] text-muted-foreground">{shown.length} · latest first · auto 8s</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Lead # / phone / name…"
          className="ml-auto w-48 rounded-md border bg-background px-2 py-1 text-xs"
        />
        <select
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="">All brands</option>
          {brandOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="">All stages</option>
          {stageOptions.map((s) => (
            <option key={s} value={s}>{s} ({evStageCounts.get(s) ?? 0})</option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>
      {events === null ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center text-xs text-muted-foreground">
          {brandFilter && (events?.length ?? 0) > 0
            ? `"${brandFilter}" brand ki koi lead nahi mili. Brand tabhi match hoga jab CRM webhook ke payload me mx_Brand field bheja ho — abhi zyadatar leads me brand aa hi nahi raha.`
            : "Abhi koi webhook event nahi. CRM se lead aate hi yahan date/time wise dikhega."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <ul className="divide-y text-xs">
            {shown.map((e) => {
              const expanded = open === e.id;
              // CRM fields are authoritative; webhook payload fills any gaps.
              const fields = { ...(e.fields ?? {}), ...(e.prospect_id ? lsqFields[e.prospect_id] ?? {} : {}) };
              const highlightKeys = new Set(HIGHLIGHT.map(([k]) => k));
              const rest = Object.entries(fields).filter(([k]) => !highlightKeys.has(k));
              return (
              <li key={e.id}>
                <button type="button" onClick={() => expand(e)} className="w-full px-3 py-2.5 text-left hover:bg-secondary/40">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{expanded ? "▾ " : "▸ "}{e.name || e.mobile || "Lead"}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                        tint[e.status] ?? "bg-slate-100 text-slate-500 ring-slate-200",
                      )}
                    >
                      {e.status}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>{fmt(e.created_at)}</span>
                    {e.mobile ? <span className="font-mono">{e.mobile}</span> : null}
                    {e.stage ? <span>Stage: {e.stage}</span> : null}
                    {e.region ? <span className="capitalize">{e.region}</span> : null}
                    {e.lead_number ? <span>#{e.lead_number}</span> : null}
                    {e.assigned_agent ? <span>→ {e.assigned_agent}</span> : null}
                  </div>
                  {e.owner_email || e.owner_name ? (
                    <div className="mt-0.5 text-[11px]">
                      <span className="text-muted-foreground">Assigned to: </span>
                      <span className="font-medium text-emerald-700">{e.owner_name || e.owner_email}</span>
                      {e.owner_name && e.owner_email ? (
                        <span className="text-muted-foreground"> · {e.owner_email}</span>
                      ) : null}
                    </div>
                  ) : null}
                </button>
                {expanded ? (
                  <div className="border-t bg-secondary/20 px-3 py-2.5">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                      {HIGHLIGHT.map(([k, label]) => (
                        <div key={k} className="flex flex-col">
                          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                          <dd className={cn("font-medium", !fields[k] && "text-muted-foreground")}>{fields[k] || "—"}</dd>
                        </div>
                      ))}
                    </dl>
                    {e.prospect_id && !lsqFields[e.prospect_id] ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">CRM se latest values load ho rahi…</p>
                    ) : null}
                    {rest.length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          All fields ({rest.length})
                        </summary>
                        <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                          {rest.map(([k, v]) => (
                            <div key={k} className="flex flex-col">
                              <dt className="truncate text-[10px] text-muted-foreground">{k}</dt>
                              <dd className="truncate">{v}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReportPanel({ allAgents }: { allAgents: Agent[] }) {
  interface AgentRow {
    agent: string;
    total: number;
    byStage: Record<string, number>;
    byRegion?: Record<string, number>;
  }
  interface Report {
    stages: string[];
    agents: AgentRow[];
    grandTotal: number;
    pending: number;
    byRegion?: Record<string, number>;
  }
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState<"American Hairline" | "Alchemane">("American Hairline");

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/lead-distribution/report?brand=${encodeURIComponent(brand)}`, { cache: "no-store" });
      const j = (await r.json()) as Report;
      setData(j);
    } catch {
      setData({ stages: [], agents: [], grandTotal: 0, pending: 0 });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand]);

  // Always show every agent — merge the report (assigned counts) with the full
  // agent list so agents with 0 still render as a row instead of a blank table.
  const reportByEmail = new Map((data?.agents ?? []).map((a) => [a.agent.trim().toLowerCase(), a]));
  const rows: AgentRow[] = allAgents
    .map((a) => {
      const email = (a.agent_email ?? "").trim().toLowerCase();
      return reportByEmail.get(email) ?? { agent: a.agent_email || a.agent_name || email, total: 0, byStage: {}, byRegion: {} };
    })
    .sort((a, b) => b.total - a.total);
  const stages = data?.stages ?? [];

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">{brand} Report · agent × stage</span>
        <div className="flex items-center gap-1">
          {(["American Hairline", "Alchemane"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBrand(b)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold",
                brand === b ? "bg-emerald-600 text-white" : "border bg-background hover:bg-secondary",
              )}
            >
              {b}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {data ? `${data.grandTotal} assigned · ${data.pending} pending` : ""} · auto 15s
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>
      {data?.byRegion ? (
        <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full bg-secondary px-2 py-0.5">National: <b>{data.byRegion["National"] ?? 0}</b></span>
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">Hindi International: <b>{data.byRegion["Hindi International"] ?? 0}</b></span>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">English International: <b>{data.byRegion["English International"] ?? 0}</b></span>
        </div>
      ) : null}
      {data === null ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5">Agent</th>
                <th className="px-3 py-2.5 text-right">Total</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">National</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap text-violet-600">Hindi Intl</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap text-sky-600">English Intl</th>
                {stages.map((s) => (
                  <th key={s} className="px-3 py-2.5 text-right whitespace-nowrap">{s}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((a) => (
                <tr key={a.agent}>
                  <td className="px-4 py-2.5 font-medium">{a.agent}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{a.total}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{a.byRegion?.["National"] ?? 0}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-violet-700">{a.byRegion?.["Hindi International"] ?? 0}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-sky-700">{a.byRegion?.["English International"] ?? 0}</td>
                  {stages.map((s) => (
                    <td key={s} className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {a.byStage[s] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-secondary/40 font-semibold">
              <tr>
                <td className="px-4 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{data.grandTotal}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{data.byRegion?.["National"] ?? 0}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-violet-700">{data.byRegion?.["Hindi International"] ?? 0}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-sky-700">{data.byRegion?.["English International"] ?? 0}</td>
                {stages.map((s) => (
                  <td key={s} className="px-3 py-2.5 text-right tabular-nums">
                    {rows.reduce((sum, a) => sum + (a.byStage[s] ?? 0), 0)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function LsqAssignmentPanel({ lsqStages }: { lsqStages: string[] }) {
  interface LeadLite {
    name: string | null;
    stage: string | null;
    lead_number: string | null;
    mobile: string | null;
  }
  interface Owner {
    email: string;
    name: string;
    count: number;
    in_pool: boolean;
    byStage: Record<string, number>;
    leads: LeadLite[];
  }
  interface Data {
    owners: Owner[];
    total: number;
    no_owner: number;
    distinct_owners: number;
    in_pool_count: number;
  }
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>("");
  const [poolFilter, setPoolFilter] = useState<"all" | "in" | "out">("all");
  const [gran, setGran] = useState<"all" | "day" | "month" | "year">("all");
  const [period, setPeriod] = useState<string>(""); // YYYY-MM-DD | YYYY-MM | YYYY
  const [query, setQuery] = useState<string>("");
  // Lead lookup (by phone / lead #) → which owner it's assigned to.
  const [leadQuery, setLeadQuery] = useState<string>("");
  const [leadResults, setLeadResults] = useState<
    { name: string | null; mobile: string | null; lead_number: string | null; stage: string | null; owner_email: string | null; owner_name: string | null }[] | null
  >(null);
  useEffect(() => {
    const q = leadQuery.trim();
    if (q.length < 3) {
      setLeadResults(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/lead-distribution/find-lead?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const j = await r.json();
        setLeadResults(j.leads ?? []);
      } catch {
        setLeadResults([]);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [leadQuery]);

  // [from, to) on contacts.created_at (IST) for the selected period.
  const range = (() => {
    const z = "+05:30";
    if (gran === "all" || !period) return { from: "", to: "" };
    if (gran === "year") {
      const y = parseInt(period, 10);
      return y ? { from: `${y}-01-01T00:00:00${z}`, to: `${y + 1}-01-01T00:00:00${z}` } : { from: "", to: "" };
    }
    if (gran === "month") {
      const [y, m] = period.split("-").map(Number);
      if (!y || !m) return { from: "", to: "" };
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      const pad = (n: number) => String(n).padStart(2, "0");
      return { from: `${y}-${pad(m)}-01T00:00:00${z}`, to: `${ny}-${pad(nm)}-01T00:00:00${z}` };
    }
    const f = new Date(`${period}T00:00:00${z}`);
    if (isNaN(f.getTime())) return { from: "", to: "" };
    return { from: f.toISOString(), to: new Date(f.getTime() + 86400000).toISOString() };
  })();

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (range.from) qs.set("from", range.from);
      if (range.to) qs.set("to", range.to);
      const r = await fetch(`/api/lead-distribution/lsq-assignment?${qs.toString()}`, { cache: "no-store" });
      const j = (await r.json()) as Data;
      setData(j);
    } catch {
      setData({ owners: [], total: 0, no_owner: 0, distinct_owners: 0, in_pool_count: 0 });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  function expandOwner(email: string) {
    setOpen(open === email ? null : email);
  }

  // Lead count per stage across all owners (drives the dropdown labels so an
  // operator can see which stages actually have leads).
  const stageCounts = new Map<string, number>();
  for (const o of data?.owners ?? []) {
    for (const [st, n] of Object.entries(o.byStage)) stageCounts.set(st, (stageCounts.get(st) ?? 0) + n);
  }
  // Full CRM stage list merged with data stages. Stages WITH leads first
  // (by count desc), then the rest alphabetically.
  const allStages = Array.from(new Set([...lsqStages, ...stageCounts.keys()])).sort((a, b) => {
    const ca = stageCounts.get(a) ?? 0;
    const cb = stageCounts.get(b) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.localeCompare(b);
  });

  // Apply the stage filter (client-side — data already carries per-stage
  // counts + the stage on each lead).
  const q = query.trim().toLowerCase();
  const owners = (data?.owners ?? [])
    .map((o) => (stageFilter ? { ...o, count: o.byStage[stageFilter] ?? 0 } : o))
    .filter((o) => o.count > 0)
    .filter((o) => (poolFilter === "all" ? true : poolFilter === "in" ? o.in_pool : !o.in_pool))
    .filter((o) => (q ? `${o.name} ${o.email}`.toLowerCase().includes(q) : true))
    .sort((a, b) => b.count - a.count);
  const maxCount = owners[0]?.count ?? 1;
  const filteredTotal = owners.reduce((s, o) => s + o.count, 0);
  const outPoolCount = (data?.owners ?? []).filter((o) => !o.in_pool).length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">CRM live assignment · per owner</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Agent / email…"
            className="w-40 rounded-md border bg-background px-2 py-1 text-xs"
          />
          <input
            type="search"
            value={leadQuery}
            onChange={(e) => setLeadQuery(e.target.value)}
            placeholder="Phone / Lead # / name…"
            className="w-48 rounded-md border bg-background px-2 py-1 text-xs"
          />
          {/* Date filter on lead-added (contacts.created_at) */}
          {(["all", "day", "month", "year"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                setGran(g);
                setPeriod("");
              }}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-semibold capitalize",
                gran === g ? "bg-emerald-600 text-white" : "border bg-background hover:bg-secondary",
              )}
            >
              {g === "all" ? "All time" : g}
            </button>
          ))}
          {gran === "day" ? (
            <input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
          ) : gran === "month" ? (
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
          ) : gran === "year" ? (
            <input type="number" placeholder="YYYY" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-20 rounded-md border bg-background px-2 py-1 text-xs" />
          ) : null}
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">All stages</option>
            {allStages.map((s) => (
              <option key={s} value={s}>{s} ({stageCounts.get(s) ?? 0})</option>
            ))}
          </select>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Ye dikhata hai LSQ abhi (apne flow se) kis-kis ko leads de raha hai — webhook se aaye har lead ka current owner. Humare
        structure se compare karne ke liye.
      </p>
      {leadResults !== null ? (
        <div className="mb-3 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="border-b bg-secondary/40 px-3 py-1.5 text-[11px] font-semibold">
            Lead search — {leadResults.length} result{leadResults.length === 1 ? "" : "s"}
          </div>
          {leadResults.length === 0 ? (
            <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">Koi lead nahi mila.</p>
          ) : (
            <ul className="divide-y text-xs">
              {leadResults.map((l, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="font-medium">{l.name || "—"}</span>
                  {l.mobile ? <span className="font-mono text-muted-foreground">{l.mobile}</span> : null}
                  {l.lead_number ? <span className="text-muted-foreground">#{l.lead_number}</span> : null}
                  {l.stage ? <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px]">{l.stage}</span> : null}
                  <span className="ml-auto text-[11px]">
                    <span className="text-muted-foreground">Assigned to: </span>
                    <span className="font-medium text-emerald-700">{l.owner_name || l.owner_email || "—"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {data ? (
        <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => setPoolFilter("all")}
            className={cn("rounded-full px-2 py-0.5", poolFilter === "all" ? "bg-foreground text-background" : "bg-secondary hover:bg-secondary/70")}
          >
            {stageFilter ? `${stageFilter}: ${filteredTotal}` : `All: ${data.total}`}
          </button>
          <button
            type="button"
            onClick={() => setPoolFilter("in")}
            className={cn(
              "rounded-full px-2 py-0.5 ring-1 ring-inset",
              poolFilter === "in" ? "bg-emerald-600 text-white ring-emerald-600" : "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100",
            )}
          >
            In our pool: {data.in_pool_count}
          </button>
          <button
            type="button"
            onClick={() => setPoolFilter("out")}
            className={cn(
              "rounded-full px-2 py-0.5 ring-1 ring-inset",
              poolFilter === "out" ? "bg-slate-600 text-white ring-slate-600" : "bg-slate-100 text-slate-600 ring-slate-200 hover:bg-slate-200",
            )}
          >
            Not in pool: {outPoolCount}
          </button>
          <span className="rounded-full bg-secondary px-2 py-0.5">Owners: {owners.length}</span>
          {!stageFilter && data.no_owner ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">No owner: {data.no_owner}</span> : null}
        </div>
      ) : null}
      {data === null ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : owners.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center text-xs text-muted-foreground">
          {stageFilter ? `"${stageFilter}" stage ki koi assigned lead nahi.` : "Abhi koi webhook lead nahi aaya. CRM se lead aate hi yahan owner-wise count dikhega."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <ul className="divide-y text-xs">
            {owners.map((o) => {
              const expanded = open === o.email;
              return (
              <li key={o.email}>
                <button
                  type="button"
                  onClick={() => expandOwner(o.email)}
                  className="w-full px-3 py-2.5 text-left hover:bg-secondary/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{expanded ? "▾" : "▸"}</span>
                    <span className="font-medium">{o.name}</span>
                    {o.in_pool ? (
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        in pool
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200">
                        not in pool
                      </span>
                    )}
                    <span className="ml-auto font-semibold tabular-nums">{o.count} leads</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((o.count / maxCount) * 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{o.email}</span>
                  </div>
                  {/* Stage breakdown chips — hidden when a single stage is filtered */}
                  <div className={cn("mt-1.5 flex-wrap gap-1 pl-5", stageFilter ? "hidden" : "flex")}>
                    {Object.entries(o.byStage)
                      .sort((a, b) => b[1] - a[1])
                      .map(([st, n]) => (
                        <span key={st} className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {st}: <span className="font-semibold text-foreground">{n}</span>
                        </span>
                      ))}
                  </div>
                </button>
                {expanded ? (
                  (() => {
                    const leads = stageFilter ? o.leads.filter((l) => l.stage === stageFilter) : o.leads;
                    return (
                      <div className="border-t bg-secondary/20 px-3 py-2">
                        {leads.length === 0 ? (
                          <p className="py-2 text-center text-[11px] text-muted-foreground">Koi lead nahi.</p>
                        ) : (
                          <table className="w-full text-left text-[11px]">
                            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              <tr>
                                <th className="py-1 pr-2">Lead</th>
                                <th className="px-2">Stage</th>
                                <th className="px-2">Number</th>
                                <th className="px-2">#</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/50">
                              {leads.map((l, i) => (
                                <tr key={i}>
                                  <td className="py-1 pr-2 font-medium">{l.name || "—"}</td>
                                  <td className="px-2">{l.stage || "—"}</td>
                                  <td className="px-2 font-mono">{l.mobile || "—"}</td>
                                  <td className="px-2">{l.lead_number ? `#${l.lead_number}` : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {leads.length >= 300 ? (
                          <p className="pt-1 text-[10px] text-muted-foreground">Pehli 300 dikha rahe.</p>
                        ) : null}
                      </div>
                    );
                  })()
                ) : null}
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function GroupsSection({
  groups,
  agents,
  stages,
  brandValues,
  onChanged,
}: {
  groups: StageGroup[];
  agents: Agent[];
  stages: string[];
  brandValues: string[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function addGroup() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/lead-distribution/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stage group", stages: [], agent_ids: [] }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Split className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-bold">Stage groups ({groups.length})</h2>
        <span className="text-[11px] text-muted-foreground">Har stage ki leads sirf chune gaye agents ko.</span>
        <button
          type="button"
          onClick={addGroup}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add stage group
        </button>
      </div>

      {err ? <p className="mt-2 text-[11px] text-rose-600">{err}</p> : null}

      {groups.length === 0 ? (
        <p className="mt-3 py-6 text-center text-xs text-muted-foreground">
          Koi stage group nahi. "Add stage group" se banao — e.g. "Photos Received" → kuch hi agents.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} stages={stages} agents={agents} brandValues={brandValues} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

function GroupCard({
  group,
  stages,
  agents,
  brandValues,
  onChanged,
}: {
  group: StageGroup;
  stages: string[];
  agents: Agent[];
  brandValues: string[];
  onChanged: () => void;
}) {
  // Local draft — edits stay here until "Save". Re-sync when the upstream
  // group changes (e.g. after a save reload).
  const [draft, setDraft] = useState(group);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDraft(group);
  }, [group]);

  // Show agents in the same sequential PRIO order the engine assigns in.
  const sortedAgents = [...agents].sort(
    (a, b) => (parseInt(String(a.priority ?? "999"), 10) || 999) - (parseInt(String(b.priority ?? "999"), 10) || 999),
  );

  const dirty =
    draft.name !== group.name ||
    draft.enabled !== group.enabled ||
    draft.priority !== group.priority ||
    JSON.stringify(draft.stages) !== JSON.stringify(group.stages) ||
    JSON.stringify(draft.agent_ids) !== JSON.stringify(group.agent_ids) ||
    JSON.stringify(draft.brands ?? []) !== JSON.stringify(group.brands ?? []) ||
    draft.working_start !== group.working_start ||
    draft.working_end !== group.working_end;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/lead-distribution/groups?id=${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim() || "Stage group",
          stages: draft.stages,
          agent_ids: draft.agent_ids,
          brands: draft.brands ?? [],
          working_start: draft.working_start || "10:00",
          working_end: draft.working_end || "18:30",
          enabled: draft.enabled,
          priority: draft.priority,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm("Ye stage group delete?")) return;
    setBusy(true);
    try {
      await fetch(`/api/lead-distribution/groups?id=${group.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("rounded-xl border bg-background p-3", busy && "opacity-50")}>
      <div className="flex items-center gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="rounded-md border bg-background px-2 py-1 text-sm font-semibold"
        />
        <button
          type="button"
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
            draft.enabled ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200",
          )}
        >
          {draft.enabled ? "On" : "Off"}
        </button>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          Prio
          <input
            type="number"
            min={0}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            className="w-14 rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
        <button type="button" onClick={remove} className="text-rose-600 hover:text-rose-700">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3">
        <SearchableMultiSelect
          label="Brand (optional)"
          hint="Khaali = sabhi brands. Sirf in brand ki leads is group me."
          items={brandValues.map((b) => ({ key: b, label: b }))}
          selected={draft.brands ?? []}
          onChange={(v) => setDraft({ ...draft, brands: v })}
          allowCustom
          emptyHint="No brands."
          accent="violet"
          showCounts={false}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Working from (IST)</label>
          <input
            type="time"
            value={draft.working_start || "10:00"}
            onChange={(e) => setDraft({ ...draft, working_start: e.target.value })}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Working to (IST)</label>
          <input
            type="time"
            value={draft.working_end || "18:30"}
            onChange={(e) => setDraft({ ...draft, working_end: e.target.value })}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <SearchableMultiSelect
          label="Stages"
          hint="In stages ki leads."
          items={stages.map((s) => ({ key: s, label: s }))}
          selected={draft.stages}
          onChange={(v) => setDraft({ ...draft, stages: v })}
          allowCustom
          emptyHint="No stages."
          accent="violet"
          showCounts={false}
        />
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Agents</label>
            <span className="text-[10px] text-muted-foreground">Priority order · {draft.agent_ids.length} selected</span>
          </div>
          <div className="max-h-56 space-y-0.5 overflow-auto rounded-md border bg-card p-1.5">
            {sortedAgents.map((a) => {
              const checked = draft.agent_ids.includes(a.lsq_id);
              return (
                <label
                  key={a.lsq_id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-secondary/60",
                    checked && "bg-emerald-50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        agent_ids: checked
                          ? draft.agent_ids.filter((x) => x !== a.lsq_id)
                          : [...draft.agent_ids, a.lsq_id],
                      })
                    }
                    className="accent-emerald-600"
                  />
                  <span className="w-6 shrink-0 text-center font-semibold tabular-nums text-emerald-700">{a.priority ?? "—"}</span>
                  <span className="truncate">{a.agent_name || a.agent_email}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{a.international_lead || "National"}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty ? <span className="text-[11px] text-amber-600">Unsaved changes</span> : null}
        {err ? <span className="text-[11px] text-rose-600">{err}</span> : null}
      </div>
    </div>
  );
}

function AgentsSection({
  agents,
  days,
  lsqStages,
  onChanged,
}: {
  agents: Agent[];
  days: string[];
  lsqStages: string[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    agent_name: "",
    agent_email: "",
    international_lead: "",
    daily_cap: 20,
    priority: "1",
    week_off: "",
    lsq_id: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // CRM agents (Users.Get) so the operator picks instead of typing email/id.
  const [lsqUsers, setLsqUsers] = useState<{ id: string; name: string; email: string | null; active: boolean }[] | null>(null);
  const [lsqUsersErr, setLsqUsersErr] = useState<string | null>(null);
  useEffect(() => {
    if (!adding || lsqUsers !== null) return;
    fetch("/api/lead-distribution/lsq-users?active=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { users?: { id: string; name: string; email: string | null; active: boolean }[]; error?: string }) => {
        if (j.error) setLsqUsersErr(j.error);
        setLsqUsers(j.users ?? []);
      })
      .catch(() => setLsqUsers([]));
  }, [adding, lsqUsers]);

  // Date + stage filter — per-agent counts bucketed by IST day & stage;
  // client sums the matching days (and stage) for the chosen granularity.
  const [counts, setCounts] = useState<Record<string, Record<string, Record<string, number>>>>({});
  const [countStages, setCountStages] = useState<string[]>([]);
  const [gran, setGran] = useState<"all" | "day" | "month" | "year">("all");
  const [period, setPeriod] = useState<string>(""); // "YYYY-MM-DD" | "YYYY-MM" | "YYYY"
  const [stageFilter, setStageFilter] = useState<string>("Photos Received");
  useEffect(() => {
    fetch("/api/lead-distribution/agent-counts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { counts: {} }))
      .then((j: { counts?: Record<string, Record<string, Record<string, number>>>; stages?: string[] }) => {
        setCounts(j.counts ?? {});
        setCountStages(Array.isArray(j.stages) ? j.stages : []);
      })
      .catch(() => {});
  }, []);

  // Count for one agent within the selected period + stage (all when blank).
  const periodCount = (email: string | null): number => {
    const byDay = counts[(email ?? "").trim().toLowerCase()];
    if (!byDay) return 0;
    let sum = 0;
    for (const [day, byStage] of Object.entries(byDay)) {
      if (gran !== "all" && period && !day.startsWith(period)) continue;
      if (stageFilter) sum += byStage[stageFilter] ?? 0;
      else sum += Object.values(byStage).reduce((s, n) => s + n, 0);
    }
    return sum;
  };
  const periodLabel = gran === "all" ? "All" : gran === "day" ? "Day" : gran === "month" ? "Month" : "Year";

  // Today's count (IST) from the same webhook data — keeps TODAY consistent
  // with the All/period column (the stored leads_today is stale n8n import).
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const todayCount = (email: string | null): number => {
    const byStage = counts[(email ?? "").trim().toLowerCase()]?.[todayIST];
    if (!byStage) return 0;
    return stageFilter ? byStage[stageFilter] ?? 0 : Object.values(byStage).reduce((s, n) => s + n, 0);
  };

  async function add() {
    setBusy("add");
    setErr(null);
    try {
      const res = await fetch("/api/lead-distribution/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          week_off: form.week_off || null,
          international_lead: form.international_lead || null,
          lsq_id: form.lsq_id || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setForm({ agent_name: "", agent_email: "", international_lead: "", daily_cap: 20, priority: "1", week_off: "", lsq_id: "" });
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(null);
    }
  }
  async function patch(id: string, body: Partial<Agent>) {
    setBusy(id);
    try {
      await fetch(`/api/lead-distribution/agents?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string) {
    if (!confirm("Agent delete?")) return;
    setBusy(id);
    try {
      await fetch(`/api/lead-distribution/agents?id=${id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-bold">Sales agents ({agents.length})</h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" /> Add agent
        </button>
      </div>

      {/* Date filter for the "All" count column */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-[11px] text-muted-foreground">Leads:</span>
        {(["all", "day", "month", "year"] as const).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => {
              setGran(g);
              setPeriod("");
            }}
            className={cn(
              "rounded-md px-2 py-1 font-semibold capitalize",
              gran === g ? "bg-emerald-600 text-white" : "border bg-background hover:bg-secondary",
            )}
          >
            {g === "all" ? "All time" : g}
          </button>
        ))}
        {gran === "day" ? (
          <input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
        ) : gran === "month" ? (
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
        ) : gran === "year" ? (
          <input
            type="number"
            placeholder="YYYY"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="w-20 rounded-md border bg-background px-2 py-1 text-xs"
          />
        ) : null}
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs">
          <option value="">All stages</option>
          {Array.from(new Set([...lsqStages, ...countStages])).sort().map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {err ? <p className="mt-2 text-[11px] text-rose-600">{err}</p> : null}

      {adding ? (
        <div className="mt-3 grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold">Pick CRM agent <span className="font-normal text-muted-foreground">(email + name + id auto-fill — manually add karne ki zaroorat nahi)</span></label>
            <select
              value={form.lsq_id}
              onChange={(e) => {
                const u = (lsqUsers ?? []).find((x) => x.id === e.target.value);
                if (u) setForm({ ...form, lsq_id: u.id, agent_email: u.email ?? "", agent_name: u.name });
                else setForm({ ...form, lsq_id: e.target.value });
              }}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">{lsqUsers === null ? "Loading CRM agents…" : `— select CRM agent (${lsqUsers.length} active) —`}</option>
              {(lsqUsers ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}{u.email ? ` · ${u.email}` : ""}</option>
              ))}
            </select>
            {lsqUsersErr ? <p className="mt-0.5 text-[10px] text-destructive">LSQ users load nahi hue: {lsqUsersErr}. Neeche manually bhar sakte ho.</p> : null}
          </div>
          <input placeholder="Name" value={form.agent_name} onChange={(e) => setForm({ ...form, agent_name: e.target.value })} className="rounded-md border bg-background px-2 py-1.5 text-sm" />
          <input placeholder="CRM email" value={form.agent_email} onChange={(e) => setForm({ ...form, agent_email: e.target.value })} className="rounded-md border bg-background px-2 py-1.5 text-sm" />
          <input placeholder="CRM user id (optional)" value={form.lsq_id} onChange={(e) => setForm({ ...form, lsq_id: e.target.value })} className="rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
          <select value={form.international_lead} onChange={(e) => setForm({ ...form, international_lead: e.target.value })} className="rounded-md border bg-background px-2 py-1.5 text-sm">
            {INTL_TAGS.map((t) => <option key={t} value={t}>{t || "National"}</option>)}
          </select>
          <select value={form.week_off} onChange={(e) => setForm({ ...form, week_off: e.target.value })} className="rounded-md border bg-background px-2 py-1.5 text-sm">
            <option value="">No week off</option>
            {days.map((d) => <option key={d} value={d}>{d} off</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs">Daily cap
            <input type="number" min={0} value={form.daily_cap} onChange={(e) => setForm({ ...form, daily_cap: Number(e.target.value) })} className="w-20 rounded-md border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-xs">Priority
            <input type="number" min={0} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="w-20 rounded-md border bg-background px-2 py-1 text-sm" />
          </label>
          <div className="sm:col-span-2">
            <button type="button" onClick={add} disabled={busy === "add"} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
              {busy === "add" ? "Adding…" : "Save agent"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 overflow-x-auto">
        {agents.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Koi agent nahi. Apna data import karo ya "Add agent" se shuru karo.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-2">Agent</th>
                <th className="px-2">Intl tag</th>
                <th className="px-2">Cap</th>
                <th className="px-2">Prio</th>
                <th className="px-2">Week off</th>
                <th className="px-2">Today</th>
                <th className="px-2">{periodLabel}</th>
                <th className="px-2">On</th>
                <th className="px-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {agents.map((a) => (
                <tr key={a.lsq_id} className={cn(busy === a.lsq_id && "opacity-50")}>
                  <td className="py-2 pr-2">
                    <div className="font-medium">{a.agent_name}</div>
                    <div className="text-[10px] text-muted-foreground">{a.agent_email}</div>
                  </td>
                  <td className="px-2">
                    <select
                      value={a.international_lead ?? ""}
                      onChange={(e) => patch(a.lsq_id, { international_lead: e.target.value || null })}
                      className="rounded-md border bg-background px-1.5 py-1 text-xs"
                    >
                      <option value="">National</option>
                      <option value="Hindi International">Hindi International</option>
                      <option value="English International">English International</option>
                    </select>
                  </td>
                  <td className="px-2">
                    <input
                      type="number"
                      min={0}
                      defaultValue={a.daily_cap}
                      onBlur={(e) => {
                        const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                        if (v !== a.daily_cap) patch(a.lsq_id, { daily_cap: v });
                      }}
                      className="w-14 rounded-md border bg-background px-1.5 py-1 text-xs tabular-nums"
                    />
                  </td>
                  <td className="px-2">
                    <input
                      type="number"
                      min={0}
                      defaultValue={a.priority ?? ""}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== String(a.priority ?? "")) patch(a.lsq_id, { priority: v });
                      }}
                      className="w-12 rounded-md border bg-background px-1.5 py-1 text-xs tabular-nums"
                    />
                  </td>
                  <td className="px-2">
                    <select
                      value={a.week_off ?? ""}
                      onChange={(e) => patch(a.lsq_id, { week_off: e.target.value || null })}
                      className="rounded-md border bg-background px-1.5 py-1 text-xs"
                    >
                      <option value="">No off</option>
                      {days.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 tabular-nums">{todayCount(a.agent_email)}</td>
                  <td className="px-2 tabular-nums font-semibold">{periodCount(a.agent_email)}</td>
                  <td className="px-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={a.is_active}
                      onClick={() => patch(a.lsq_id, { is_active: !a.is_active })}
                      title={a.is_active ? "Active — click to turn off" : "Off — click to turn on"}
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        a.is_active ? "bg-emerald-500" : "bg-slate-300",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                          a.is_active ? "translate-x-4" : "translate-x-0.5",
                        )}
                      />
                    </button>
                  </td>
                  <td className="px-2 text-right">
                    <button type="button" onClick={() => remove(a.lsq_id)} className="text-rose-600 hover:text-rose-700">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
