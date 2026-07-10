"use client";

// Renders the colored chip strip for a contact's assigned labels.
// Used in the inbox list row + the contact detail panel header.
//
// Owns a small in-memory cache of the workspace label set so we don't
// re-fetch /api/labels on every row. The cache is invalidated by a
// `labels-changed` window event that LabelsView dispatches when the
// operator creates/renames/deletes a label.

import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/PermissionsContext";

export interface LabelDef {
  id: string;
  name: string;
  color: string | null;
}

// Module-level cache + in-flight fetch dedupe so 30 inbox rows do ONE
// HTTP call instead of 30. Cache lifetime is the page lifetime —
// invalidated via `labels-changed` event.
let cache: LabelDef[] | null = null;
let inFlight: Promise<LabelDef[]> | null = null;

function fetchLabels(): Promise<LabelDef[]> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/labels", { cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { labels?: LabelDef[] };
      cache = j.labels ?? [];
      return cache;
    })
    .catch(() => {
      cache = [];
      return cache;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidateLabelsCache() {
  cache = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("labels-changed"));
  }
}

export function useLabels(): LabelDef[] | null {
  const [labels, setLabels] = useState<LabelDef[] | null>(cache);
  useEffect(() => {
    let cancelled = false;
    void fetchLabels().then((l) => {
      if (!cancelled) setLabels(l);
    });
    function onChanged() {
      cache = null;
      void fetchLabels().then((l) => {
        if (!cancelled) setLabels(l);
      });
    }
    window.addEventListener("labels-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("labels-changed", onChanged);
    };
  }, []);
  return labels;
}

const TONE: Record<string, string> = {
  emerald: "bg-primary/10 text-primary ring-primary/25",
  sky:     "bg-sky-50 text-sky-800 ring-sky-200",
  violet:  "bg-violet-50 text-violet-800 ring-violet-200",
  amber:   "bg-amber-50 text-amber-800 ring-amber-200",
  rose:    "bg-rose-50 text-rose-800 ring-rose-200",
  teal:    "bg-teal-50 text-teal-800 ring-teal-200",
  slate:   "bg-slate-100 text-slate-700 ring-slate-200",
};

const DOT: Record<string, string> = {
  emerald: "bg-primary",
  sky:     "bg-sky-500",
  violet:  "bg-violet-500",
  amber:   "bg-amber-500",
  rose:    "bg-rose-500",
  teal:    "bg-teal-500",
  slate:   "bg-slate-500",
};

// Tag-icon stroke colours so the icon picks up the chip's accent.
const ICON: Record<string, string> = {
  emerald: "text-primary",
  sky:     "text-sky-600",
  violet:  "text-violet-600",
  amber:   "text-amber-600",
  rose:    "text-rose-600",
  teal:    "text-teal-600",
  slate:   "text-slate-500",
};

export function LabelChips({
  labelIds,
  size = "sm",
  className,
}: {
  labelIds: string[] | null | undefined;
  size?: "xs" | "sm";
  className?: string;
}) {
  const labels = useLabels();
  if (!labelIds || labelIds.length === 0) return null;
  if (!labels) return null;
  const byId = new Map(labels.map((l) => [l.id, l]));
  const resolved = labelIds
    .map((id) => byId.get(id))
    .filter((l): l is LabelDef => l !== undefined);
  if (resolved.length === 0) return null;
  const isXs = size === "xs";
  const sizeCls = isXs
    ? "px-1.5 py-0 text-[9px] gap-1"
    : "px-2 py-0.5 text-[10px] gap-1.5";
  const iconCls = isXs ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {resolved.map((l) => {
        const c = l.color ?? "slate";
        return (
          <span
            key={l.id}
            className={cn(
              // Subtle inset shadow + tighter ring gives the chip the
              // "pressed pill" look — premium SaaS feel without flat
              // backgrounds.
              "inline-flex items-center rounded-full font-semibold ring-1 ring-inset shadow-[inset_0_-1px_0_rgba(0,0,0,0.04)]",
              sizeCls,
              TONE[c] ?? TONE.slate,
            )}
            title={`Label: ${l.name}`}
          >
            <Tag className={cn("shrink-0", iconCls, ICON[c] ?? ICON.slate)} />
            <span className="whitespace-nowrap">{l.name}</span>
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LabelPicker — popover for assigning / unassigning labels on a contact.
// Enforces the max-3 cap (the API also enforces it server-side).
// ---------------------------------------------------------------------------

const MAX_LABELS = 3;

export function LabelPicker({
  contactId,
  current,
  onChanged,
  trigger,
}: {
  contactId: string;
  current: string[];
  onChanged: (next: string[]) => void;
  /** Render-prop for the trigger button. Receives an `onClick` to toggle. */
  trigger: (props: { onClick: () => void; open: boolean }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The same popover hosts two screens: "assign" (default — pick which
  // labels apply to this contact) and "manage" (CRUD the workspace
  // label set inline, no redirect). Switching is just a state flip so
  // the popover never closes mid-edit.
  const [mode, setMode] = useState<"assign" | "manage">("assign");
  const [saving, setSaving] = useState<string | null>(null);
  const labels = useLabels();
  const selected = new Set(current);

  async function toggle(id: string) {
    let next: string[];
    if (selected.has(id)) {
      next = current.filter((x) => x !== id);
    } else {
      if (current.length >= MAX_LABELS) return;
      next = [...current, id];
    }
    setSaving(id);
    try {
      const res = await fetch(
        `/api/contacts/${encodeURIComponent(contactId)}/labels`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_ids: next }),
        },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onChanged(next);
    } catch {
      /* swallow — selected state will reconcile on next render */
    } finally {
      setSaving(null);
    }
  }

  return (
    <span className="relative inline-block">
      {trigger({
        onClick: () => {
          setOpen((v) => !v);
          setMode("assign"); // always reset to assign view on open
        },
        open,
      })}
      {open ? (
        <>
          <span
            className="fixed inset-0 z-40"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95">
            {mode === "assign" ? (
              <>
                <header className="flex items-center justify-between border-b bg-secondary/40 px-3 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    Labels · {current.length}/{MAX_LABELS}
                  </span>
                </header>
                <ul className="max-h-64 overflow-auto">
                  {(labels ?? []).length === 0 ? (
                    <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                      No labels yet — click <strong>Manage labels</strong> below
                      to create some.
                    </li>
                  ) : (
                    (labels ?? []).map((l) => {
                      const c = l.color ?? "slate";
                      const isOn = selected.has(l.id);
                      const isCapped = !isOn && current.length >= MAX_LABELS;
                      return (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() => toggle(l.id)}
                            disabled={saving !== null || isCapped}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition",
                              isOn
                                ? "bg-primary/10 font-semibold text-foreground"
                                : "hover:bg-secondary",
                              isCapped && "cursor-not-allowed opacity-50",
                            )}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <span className={cn("h-2 w-2 rounded-full", DOT[c] ?? DOT.slate)} />
                              {l.name}
                            </span>
                            {isOn ? (
                              <span className="text-[10px] font-bold text-primary">✓</span>
                            ) : isCapped ? (
                              <span className="text-[10px] text-muted-foreground">max 3</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
                <footer className="border-t bg-secondary/30 px-3 py-1.5 text-[10px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setMode("manage")}
                    className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                  >
                    <Tag className="h-2.5 w-2.5" />
                    Manage labels
                  </button>
                </footer>
              </>
            ) : (
              <ManageLabelsPanel
                labels={labels ?? []}
                onClose={() => setMode("assign")}
              />
            )}
          </div>
        </>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline label manager. Lives inside the LabelPicker popover so any team
// member can create / rename / delete the workspace label set without
// being sent into Settings → Labels (where teammates often don't have
// access). Uses the same /api/labels endpoints — those treat labels as
// a workflow tag, not a permission gate, so any signed-in member can
// write.
// ---------------------------------------------------------------------------
function ManageLabelsPanel({
  labels,
  onClose,
}: {
  labels: LabelDef[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("emerald");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const COLORS = ["emerald", "sky", "violet", "amber", "rose", "teal", "slate"];

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setName("");
      setColor("emerald");
      invalidateLabelsCache();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <header className="flex items-center justify-between border-b bg-secondary/40 px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Manage labels
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Back to assign"
        >
          <X className="h-3 w-3" />
          Back
        </button>
      </header>

      {/* Create */}
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="New label"
            maxLength={40}
            disabled={creating}
            className="flex-1 rounded-md border bg-background px-2 py-1 text-xs shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating || !name.trim()}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Add
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-0.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded transition",
                color === c
                  ? "ring-2 ring-foreground/30"
                  : "ring-1 ring-transparent hover:ring-border",
              )}
              title={c}
            >
              <span className={cn("h-2.5 w-2.5 rounded-full", DOT[c])} />
            </button>
          ))}
        </div>
        {err ? (
          <div className="mt-1 text-[10px] text-rose-700">{err}</div>
        ) : null}
      </div>

      {/* Existing list */}
      <ul className="max-h-56 divide-y overflow-auto">
        {labels.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">
            No labels yet.
          </li>
        ) : (
          labels.map((l) => (
            <ManageLabelRow
              key={l.id}
              label={l}
              editing={editingId === l.id}
              onEdit={() => setEditingId(l.id)}
              onCancel={() => setEditingId(null)}
              onSaved={() => {
                setEditingId(null);
                invalidateLabelsCache();
              }}
              onDeleted={() => invalidateLabelsCache()}
            />
          ))
        )}
      </ul>
    </>
  );
}

function ManageLabelRow({
  label,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onDeleted,
}: {
  label: LabelDef;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const perms = usePermissions();
  const canDelete = perms.can_delete_labels;
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState<string>(label.color ?? "slate");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const COLORS = ["emerald", "sky", "violet", "amber", "rose", "teal", "slate"];

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: label.id, name: name.trim(), color }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete label "${label.name}"? Removed from every contact too.`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/labels?id=${encodeURIComponent(label.id)}`, {
        method: "DELETE",
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            className="flex-1 rounded-md border bg-background px-2 py-1 text-xs shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-6 items-center rounded-md px-1.5 text-[10px] text-muted-foreground hover:bg-secondary"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-0.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded transition",
                color === c
                  ? "ring-2 ring-foreground/30"
                  : "ring-1 ring-transparent hover:ring-border",
              )}
              title={c}
            >
              <span className={cn("h-2.5 w-2.5 rounded-full", DOT[c])} />
            </button>
          ))}
        </div>
        {err ? <div className="mt-1 text-[10px] text-rose-700">{err}</div> : null}
      </li>
    );
  }

  const c = label.color ?? "slate";
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-1.5 transition hover:bg-secondary/40">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
          TONE[c] ?? TONE.slate,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", DOT[c] ?? DOT.slate)} />
        {label.name}
      </span>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          title="Rename / recolor"
        >
          <Pencil className="h-3 w-3" />
        </button>
        {canDelete ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </span>
    </li>
  );
}
