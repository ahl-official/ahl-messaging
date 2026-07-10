"use client";

// CRM-style lead table view for the inbox. A full-screen grid of contacts
// with CRM fields (stage, owner, source, sub-source, campaign, medium…) and a
// column picker so the operator chooses which columns show. Mirrors the
// CRM "Manage Lead" list. Data comes from /api/contacts (same scope
// the inbox uses) — no extra LSQ calls; we render the cached lead fields.

import { useEffect, useMemo, useState } from "react";
import { X, Columns3, Search, RefreshCcw } from "lucide-react";
import type { Contact } from "@/lib/types";
import { contactDisplayName } from "@/lib/types";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { cn } from "@/lib/utils";

function utm(c: Contact, key: string): string {
  const p = (c.utm_params ?? {}) as Record<string, unknown>;
  const v = p[`utm_${key}`] ?? p[key] ?? p[key.charAt(0).toUpperCase() + key.slice(1)];
  return v != null ? String(v) : "";
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(d).replace(",", " |");
}

interface Column {
  key: string;
  label: string;
  get: (c: Contact) => string;
  width?: string;
  defaultOn?: boolean;
}

const COLUMNS: Column[] = [
  { key: "leadno", label: "Lead ID", get: (c) => c.lsq_lead_number ?? "", width: "w-[90px]", defaultOn: true },
  { key: "name", label: "Lead Name", get: (c) => contactDisplayName(c) || c.wa_id || "—", width: "w-[150px]", defaultOn: true },
  { key: "stage", label: "Lead Stage", get: (c) => c.lsq_stage ?? "", width: "w-[150px]", defaultOn: true },
  { key: "owner", label: "Lead Owner", get: (c) => c.lsq_owner_name ?? "", width: "w-[170px]", defaultOn: true },
  { key: "modified", label: "Modified On", get: (c) => fmtDate(c.lsq_synced_at || c.last_message_at), width: "w-[150px]", defaultOn: true },
  { key: "campaign", label: "Source Campaign", get: (c) => utm(c, "campaign"), width: "w-[200px]", defaultOn: true },
  { key: "source", label: "Lead Source", get: (c) => c.lsq_source ?? "", width: "w-[140px]", defaultOn: true },
  { key: "subsource", label: "Sub source", get: (c) => c.lsq_sub_source ?? "", width: "w-[130px]", defaultOn: true },
  { key: "medium", label: "Source Medium", get: (c) => c.utm_source || utm(c, "medium"), width: "w-[150px]", defaultOn: true },
  { key: "latest", label: "Latest Source", get: (c) => c.lsq_source ?? utm(c, "source"), width: "w-[140px]", defaultOn: true },
  { key: "phone", label: "Phone", get: (c) => c.wa_id ?? "", width: "w-[130px]", defaultOn: false },
  { key: "owneremail", label: "Owner Email", get: (c) => c.lsq_owner_email ?? "", width: "w-[180px]", defaultOn: false },
];

const STORAGE_KEY = "qht.leadTable.columns.v1";

export function LeadTableView({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detail, setDetail] = useState<{ lead: string; name: string } | null>(null);
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.defaultOn).map((c) => c.key)),
  );

  // Restore saved column choice.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length) {
          const allowed = new Set(COLUMNS.map((c) => c.key));
          setVisible(new Set(arr.filter((k) => allowed.has(k))));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  function toggleCol(key: string) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function load() {
    setLoading(true);
    try {
      const all: Contact[] = [];
      for (let off = 0; off < 2000; off += 200) {
        const res = await fetch(`/api/contacts?offset=${off}`, { cache: "no-store" });
        if (!res.ok) break;
        const json = (await res.json()) as { contacts?: Contact[]; hasMore?: boolean };
        const batch = json.contacts ?? [];
        all.push(...batch);
        setRows([...all]);
        if (!json.hasMore || batch.length === 0) break;
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cols = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible]);
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows ?? [];
    return (rows ?? []).filter((c) =>
      cols.some((col) => col.get(c).toLowerCase().includes(query)) ||
      (contactDisplayName(c) || "").toLowerCase().includes(query) ||
      (c.wa_id ?? "").includes(query),
    );
  }, [rows, q, cols]);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40 p-3 sm:p-5">
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <h2 className="text-lg font-bold">Manage Leads</h2>
        <button type="button" onClick={load} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary" title="Refresh">
          <RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
        <div className="relative ml-2 w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, number, stage, source…"
            className="w-full rounded-md border bg-secondary/30 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {loading ? "Loading…" : `${filtered.length} of ${rows?.length ?? 0} leads`}
          </span>
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold hover:bg-secondary",
              pickerOpen && "bg-secondary",
            )}
          >
            <Columns3 className="h-3.5 w-3.5" /> Columns
          </button>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Table */}
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm">
              <tr>
                {cols.map((col) => (
                  <th key={col.key} className={cn("whitespace-nowrap border-b px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground", col.width)}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows === null ? (
                <tr><td colSpan={cols.length} className="px-3 py-10 text-center text-muted-foreground">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={cols.length} className="px-3 py-10 text-center text-muted-foreground">No leads.</td></tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id} className="border-b hover:bg-primary/10">
                    {cols.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "px-3 py-2.5",
                          col.width,
                          col.key === "name"
                            ? "max-w-[150px] truncate font-semibold text-primary"
                            : "whitespace-nowrap",
                        )}
                        title={col.key === "name" ? col.get(c) : undefined}
                      >
                        {col.key === "name" ? (
                          c.lsq_lead_number ? (
                            <button
                              type="button"
                              onClick={() => setDetail({ lead: c.lsq_lead_number as string, name: col.get(c) })}
                              className="hover:underline"
                            >
                              {col.get(c)}
                            </button>
                          ) : (
                            col.get(c)
                          )
                        ) : col.key === "stage" && col.get(c) ? (
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">{col.get(c)}</span>
                        ) : (
                          col.get(c) || <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Column picker */}
        {pickerOpen ? (
          <aside className="w-56 shrink-0 overflow-y-auto border-l bg-card p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Columns</div>
            <div className="space-y-1.5">
              {COLUMNS.map((col) => (
                <label key={col.key} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-secondary">
                  <input
                    type="checkbox"
                    checked={visible.has(col.key)}
                    onChange={() => toggleCol(col.key)}
                    className="accent-primary"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
      </div>

      {detail ? (
        <LeadDetailPanel leadNumber={detail.lead} name={detail.name} onClose={() => setDetail(null)} />
      ) : null}
    </div>
  );
}
