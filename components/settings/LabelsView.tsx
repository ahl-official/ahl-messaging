"use client";

// Settings → Labels. Manage the workspace-wide label set assigned to
// contacts (max 3 per contact). Pattern matches the Teams tab — create
// form on top, list with inline rename/recolor/delete below.

import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { invalidateLabelsCache } from "@/components/LabelChips";
import { usePermissions } from "@/components/PermissionsContext";

interface Label {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export const LABEL_COLORS: Array<{ key: string; label: string; chip: string; dot: string }> = [
  { key: "emerald", label: "Emerald", chip: "bg-emerald-50 text-emerald-800 ring-emerald-200", dot: "bg-emerald-500" },
  { key: "sky",     label: "Sky",     chip: "bg-sky-50 text-sky-800 ring-sky-200",             dot: "bg-sky-500" },
  { key: "violet",  label: "Violet",  chip: "bg-violet-50 text-violet-800 ring-violet-200",    dot: "bg-violet-500" },
  { key: "amber",   label: "Amber",   chip: "bg-amber-50 text-amber-800 ring-amber-200",       dot: "bg-amber-500" },
  { key: "rose",    label: "Rose",    chip: "bg-rose-50 text-rose-800 ring-rose-200",          dot: "bg-rose-500" },
  { key: "teal",    label: "Teal",    chip: "bg-teal-50 text-teal-800 ring-teal-200",          dot: "bg-teal-500" },
  { key: "slate",   label: "Slate",   chip: "bg-slate-100 text-slate-700 ring-slate-200",      dot: "bg-slate-500" },
];

export function colorOf(key: string | null): (typeof LABEL_COLORS)[number] {
  return LABEL_COLORS.find((c) => c.key === key) ?? LABEL_COLORS[6];
}

export function LabelsView() {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("emerald");
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/labels", { cache: "no-store" });
      const json = (await res.json()) as { labels?: Label[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setLabels(json.labels ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNewName("");
      setNewColor("emerald");
      invalidateLabelsCache();
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete label "${name}"? It will be removed from every contact too.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/labels?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      invalidateLabelsCache();
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Tag}
        title="Labels"
        subtitle="Workspace-wide labels assigned to contacts (max 3 per contact). Color-coded; show up on the inbox row + contact panel header."
        tone="violet"
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50/60 px-4 py-2.5 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <header className="flex items-center gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100">
                <Plus className="h-3.5 w-3.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">Create a label</h2>
                <p className="text-[10px] text-muted-foreground">
                  Name + colour. Available to assign on every contact immediately.
                </p>
              </div>
            </header>
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto]">
              <input
                type="text"
                placeholder="Label name (e.g. VIP, Hot lead)"
                maxLength={40}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <ColorSelect value={newColor} onChange={setNewColor} />
              <button
                type="button"
                onClick={create}
                disabled={creating || !newName.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Create label
              </button>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <header className="flex items-center justify-between gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100">
                  <Tag className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">Existing labels</h2>
                  <p className="text-[10px] text-muted-foreground">
                    Click a row to rename or recolor.
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {(labels ?? []).length} label{(labels ?? []).length === 1 ? "" : "s"}
              </span>
            </header>
            {labels === null ? (
              <div className="grid h-32 place-items-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : labels.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                No labels yet — create your first one above.
              </div>
            ) : (
              <ul className="divide-y">
                {labels.map((l) => (
                  <LabelRow
                    key={l.id}
                    label={l}
                    editing={editingId === l.id}
                    onEdit={() => setEditingId(l.id)}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => {
                      setEditingId(null);
                      void load();
                    }}
                    onDelete={() => remove(l.id, l.name)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function LabelRow({
  label,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
}: {
  label: Label;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const perms = usePermissions();
  const canDelete = perms.can_delete_labels;
  const c = colorOf(label.color);
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color ?? "slate");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: label.id, name: name.trim(), color }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      invalidateLabelsCache();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <li className="grid gap-2 px-5 py-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input
          type="text"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <ColorSelect value={color} onChange={setColor} />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        {err ? <div className="col-span-full text-xs text-rose-700">{err}</div> : null}
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-secondary/30">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
          c.chip,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", c.dot)} />
        {label.name}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Rename / recolor"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {canDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-700"
            title="Delete label"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ColorSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.key)}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded transition",
            value === c.key
              ? "ring-2 ring-foreground/30"
              : "ring-1 ring-transparent hover:ring-border",
          )}
          title={c.label}
          aria-label={c.label}
        >
          <span className={cn("h-3 w-3 rounded-full", c.dot)} />
        </button>
      ))}
    </div>
  );
}
