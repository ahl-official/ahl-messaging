"use client";

// CRM-style lead detail panel. Opens when a lead is clicked in the
// CRM table. Mirrors the CRM lead page: a summary card on the left and tabs
// (Leads Details, Activity History, Notes, Call, Tasks, Documents, Audit
// Trail). Details + Activity come live from LSQ; Notes and Call are derived
// from the same activity feed. Tasks / Documents / Audit need their own LSQ
// APIs and are flagged until wired.

import { useEffect, useMemo, useState } from "react";
import { X, RefreshCcw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Activity {
  id: string;
  event_code: number;
  event_name: string;
  note: string | null;
  created_on: string | null;
  data: Array<{ key: string; value: string }>;
}
interface DetailResp {
  prospect_id: string;
  fields: Record<string, string>;
  fields_error: string | null;
  activities: Activity[];
  activities_error: string | null;
  /** Client's preferred reply language — from OUR DB (set by the bot), not LSQ. */
  preferred_language: string | null;
}

type Tab = "details" | "activity" | "notes" | "call" | "tasks" | "documents" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "details", label: "Leads Details" },
  { key: "activity", label: "Activity History" },
  { key: "notes", label: "Notes" },
  { key: "call", label: "Call" },
  { key: "tasks", label: "Tasks" },
  { key: "documents", label: "Documents" },
  { key: "audit", label: "Audit Trail" },
];

// CRM field keys → readable labels; internal/ID keys are hidden.
const HIDE_KEYS = new Set([
  "ProspectID", "OwnerId", "CreatedBy", "ModifiedBy", "StatusCode", "StatusReason",
  "DeletionStatusCode", "IsLead", "ProspectActivityId_Max", "ProspectActivityId_Min",
  "ProspectActivityName_Max", "ProspectActivityDate_Max", "ProspectActivityDate_Min",
  "EngagementScore", "NotableEvent", "NotableEventdate", "LastVisitDate",
]);
function humanize(key: string): string {
  return key
    .replace(/^mx_/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bId\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function fmt(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(d);
}

export function LeadDetailPanel({
  leadNumber,
  name,
  onClose,
}: {
  leadNumber: string;
  name?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/lsq/lead-detail?lead=${encodeURIComponent(leadNumber)}`, { cache: "no-store" });
      const json = (await res.json()) as DetailResp & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadNumber]);

  const fields = data?.fields ?? {};
  const detailRows = useMemo(
    () => Object.entries(fields).filter(([k, v]) => !HIDE_KEYS.has(k) && v != null && String(v).trim()),
    [fields],
  );
  const activities = data?.activities ?? [];
  const notes = useMemo(() => activities.filter((a) => /note/i.test(a.event_name)), [activities]);
  const calls = useMemo(() => activities.filter((a) => /call/i.test(a.event_name)), [activities]);

  const owner = fields.OwnerIdName || fields.CreatedByName || "";
  const stage = fields.ProspectStage || "";
  const phone = fields.Phone || fields.Mobile || "";
  const score = fields.Score || "";

  function ActivityList({ items, empty }: { items: Activity[]; empty: string }) {
    if (loading) return <div className="grid h-40 place-items-center text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
    if (items.length === 0) return <div className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</div>;
    return (
      <div className="space-y-2 p-3">
        {items.map((a) => {
          const d: Record<string, string> = Object.fromEntries(a.data.map((x) => [x.key, x.value]));
          const isCall = /call/i.test(a.event_name);
          const isAssign = /assign/i.test(a.event_name);
          const isWa = /whatsapp/i.test(a.event_name);
          const time = fmt(a.created_on);

          // Owner change → one line: from → to.
          if (isAssign) {
            return (
              <div key={a.id} className="rounded-lg border bg-white px-3 py-2 text-sm shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span><b className="text-emerald-700">Lead owner changed</b> — {d.PreviousOwner || "—"} <span className="text-muted-foreground">→</span> <b>{d.CurrentOwner || "—"}</b></span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
                </div>
              </div>
            );
          }

          // Call → audio player + duration, no raw URL.
          if (isCall) {
            return (
              <div key={a.id} className="rounded-lg border bg-white px-3 py-2 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-emerald-700">{a.event_name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-600">
                  {[d.Caller ? `By ${d.Caller}` : "", d.CallType, d.Duration ? `${d.Duration}s` : ""].filter(Boolean).join(" · ")}
                </div>
                {d.ResourceUrl ? (
                  <audio controls preload="none" src={d.ResourceUrl} className="mt-1.5 h-8 w-full max-w-md" />
                ) : (
                  <div className="mt-1 text-[11px] text-muted-foreground">No recording available</div>
                )}
              </div>
            );
          }

          // WhatsApp → message text on top, created-by + time below. No expand.
          if (isWa) {
            const text = d.NotableEventDescription || a.note || "";
            return (
              <div key={a.id} className="rounded-lg border bg-white px-3 py-2 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-emerald-700">WhatsApp Message</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
                </div>
                {text ? <div className="mt-0.5 text-sm text-slate-800">{text}</div> : null}
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {d.CreatedByName ? `Created by ${d.CreatedByName}` : "Created"} · {time}
                </div>
              </div>
            );
          }

          // Generic → compact, expandable.
          const open = expanded.has(a.id);
          return (
            <div key={a.id} className="rounded-lg border bg-white px-3 py-2 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-emerald-700">{a.event_name}</div>
                  {a.note ? <div className="mt-0.5 text-xs text-slate-600">{a.note}</div> : null}
                </div>
                <div className="shrink-0 text-[11px] text-muted-foreground">{time}</div>
              </div>
              {a.data.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                    className="mt-1 text-[11px] font-semibold text-emerald-700 hover:underline"
                  >
                    {open ? "Hide details" : `Show details (${a.data.length})`}
                  </button>
                  {open ? (
                    <table className="mt-1.5 w-full text-[11px]">
                      <tbody>
                        {a.data.map((row, i) => (
                          <tr key={i} className="border-t">
                            <td className="py-1 pr-3 align-top font-medium text-muted-foreground">{row.key}</td>
                            <td className="py-1 align-top">{row.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex bg-black/40 p-3 sm:p-5">
      <div className="flex min-h-0 w-full overflow-hidden rounded-2xl border bg-white shadow-2xl">
        {/* Summary card */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r bg-slate-50 p-4">
          <div className="rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 p-4 text-white">
            <div className="text-lg font-bold leading-tight">{name || fields.FirstName || "Lead"}</div>
            {stage ? <span className="mt-1 inline-block rounded-full bg-white/20 px-2 py-0.5 text-xs">{stage}</span> : null}
          </div>
          <div className="mt-3 space-y-2 text-sm">
            {phone ? <div><span className="text-muted-foreground">Phone:</span> {phone}</div> : null}
            <div className="flex gap-4">
              <div><div className="text-base font-bold">{leadNumber}</div><div className="text-[11px] text-muted-foreground">Lead Number</div></div>
              {score ? <div><div className="text-base font-bold">{score}</div><div className="text-[11px] text-muted-foreground">Lead Score</div></div> : null}
            </div>
            <div className="border-t pt-2">
              <div className="text-[11px] font-bold uppercase text-muted-foreground">Owner</div>
              <div>{owner || "—"}</div>
            </div>
            <div className="border-t pt-2">
              <div className="text-[11px] font-bold uppercase text-muted-foreground">Preferred Language</div>
              {data?.preferred_language ? (
                <span className="mt-0.5 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">
                  {data.preferred_language}
                </span>
              ) : (
                <div className="text-muted-foreground">Not set yet</div>
              )}
            </div>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-semibold transition",
                  tab === t.key ? "bg-emerald-50 text-emerald-700" : "text-muted-foreground hover:bg-secondary",
                )}
              >
                {t.label}
              </button>
            ))}
            <button type="button" onClick={load} className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-secondary" title="Refresh">
              <RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
            </button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary" title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {err ? <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div> : null}

            {tab === "details" ? (
              loading && !data ? (
                <div className="grid h-40 place-items-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : (
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 p-4 md:grid-cols-2">
                  {detailRows.map(([k, v]) => (
                    <div key={k} className="border-b pb-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{humanize(k)}</div>
                      <div className="text-sm">{/date|on$/i.test(k) ? fmt(v) : v}</div>
                    </div>
                  ))}
                </div>
              )
            ) : tab === "activity" ? (
              <ActivityList items={activities} empty="No activity in LSQ." />
            ) : tab === "notes" ? (
              <ActivityList items={notes} empty="No notes in LSQ." />
            ) : tab === "call" ? (
              <ActivityList items={calls} empty="No call activity in LSQ." />
            ) : (
              <div className="grid h-40 place-items-center px-6 text-center text-sm text-muted-foreground">
                {tab === "tasks" ? "Tasks" : tab === "documents" ? "Documents" : "Audit Trail"} — LSQ {tab} API wiring pending.
                Activity-derived data shows under Activity History.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
