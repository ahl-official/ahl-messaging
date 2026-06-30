"use client";

// Settings → Teams. Manage operator-defined groups (HT Done / Welcome /
// Sales / Date Align / ...). Members are assigned a team on the Team tab
// or via the invite flow. This view focuses on CRUD + visual identity:
//   • List existing teams (member count badge per team)
//   • Create a new team with a colour swatch
//   • Rename / recolor / delete

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { TeamPermissionSheet } from "@/components/settings/TeamPermissionSheet";

interface Team {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  member_count: number;
}

const COLORS: Array<{ key: string; label: string; ring: string; bg: string; dot: string }> = [
  { key: "emerald", label: "Emerald", ring: "ring-emerald-200", bg: "bg-emerald-50", dot: "bg-emerald-500" },
  { key: "sky",     label: "Sky",     ring: "ring-sky-200",     bg: "bg-sky-50",     dot: "bg-sky-500" },
  { key: "violet",  label: "Violet",  ring: "ring-violet-200",  bg: "bg-violet-50",  dot: "bg-violet-500" },
  { key: "amber",   label: "Amber",   ring: "ring-amber-200",   bg: "bg-amber-50",   dot: "bg-amber-500" },
  { key: "rose",    label: "Rose",    ring: "ring-rose-200",    bg: "bg-rose-50",    dot: "bg-rose-500" },
  { key: "teal",    label: "Teal",    ring: "ring-teal-200",    bg: "bg-teal-50",    dot: "bg-teal-500" },
  { key: "slate",   label: "Slate",   ring: "ring-slate-200",   bg: "bg-slate-100",  dot: "bg-slate-500" },
];

function colorOf(c: string | null) {
  return COLORS.find((x) => x.key === c) ?? COLORS[6];
}

export function TeamsView() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("emerald");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Team whose permission sheet is currently open. null = closed.
  const [permTeam, setPermTeam] = useState<Team | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/teams", { cache: "no-store" });
      const json = (await res.json()) as { teams?: Team[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTeams(json.teams ?? []);
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
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNewName("");
      setNewColor("emerald");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string, memberCount: number) {
    const ok = confirm(
      memberCount > 0
        ? `Delete this team? ${memberCount} member(s) will become unassigned (their data stays — only the team label is removed).`
        : "Delete this team?",
    );
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/teams?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Layers}
        title="Teams"
        subtitle="Group your agents into squads (HT Done, Welcome, Sales, Date Align...). Assign members from the Team tab or at invite time."
        tone="emerald"
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50/60 px-4 py-2.5 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          {/* New team form */}
          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <header className="flex items-center gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100">
                <Plus className="h-3.5 w-3.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">Create a team</h2>
                <p className="text-[10px] text-muted-foreground">
                  Pick a name + colour. Saved teams appear in the invite +
                  member-edit forms immediately.
                </p>
              </div>
            </header>
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto]">
              <input
                type="text"
                placeholder="Team name (e.g. HT Done)"
                maxLength={60}
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
                Create team
              </button>
            </div>
          </section>

          {/* Existing teams */}
          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <header className="flex items-center justify-between gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100">
                  <Layers className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">Existing teams</h2>
                  <p className="text-[10px] text-muted-foreground">
                    Click a row to rename or recolor.
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {(teams ?? []).length} team{(teams ?? []).length === 1 ? "" : "s"}
              </span>
            </header>
            {teams === null ? (
              <div className="grid h-32 place-items-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : teams.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                No teams yet — create your first one above.
              </div>
            ) : (
              <ul className="divide-y">
                {teams.map((t) => (
                  <TeamRow
                    key={t.id}
                    team={t}
                    editing={editingId === t.id}
                    onEdit={() => setEditingId(t.id)}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => {
                      setEditingId(null);
                      void load();
                    }}
                    onDelete={() => remove(t.id, t.member_count)}
                    onEditPermissions={() => setPermTeam(t)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <TeamPermissionSheet
        open={permTeam !== null}
        team={permTeam}
        onClose={() => setPermTeam(null)}
      />
    </div>
  );
}

function TeamRow({
  team,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
  onEditPermissions,
}: {
  team: Team;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDelete: () => void;
  onEditPermissions: () => void;
}) {
  const c = colorOf(team.color);
  const [name, setName] = useState(team.name);
  const [color, setColor] = useState(team.color ?? "slate");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/teams", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: team.id, name: name.trim(), color }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
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
          maxLength={60}
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
        {err ? (
          <div className="col-span-full text-xs text-rose-700">{err}</div>
        ) : null}
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-secondary/30">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
            c.bg,
            c.ring,
          )}
        >
          <span className={cn("h-2.5 w-2.5 rounded-full", c.dot)} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{team.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {team.member_count} member{team.member_count === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEditPermissions}
          className="inline-flex h-7 items-center justify-center gap-1 rounded-md bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100"
          title="Permissions for everyone in this team"
        >
          <KeyRound className="h-3 w-3" />
          Permissions
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Rename / recolor"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-700"
          title="Delete team"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
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
      {COLORS.map((c) => (
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
