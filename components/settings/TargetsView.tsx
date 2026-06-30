"use client";

// Settings → Targets. Two cards:
//   1. Role defaults — one row per role (owner/superadmin/admin/teammate).
//      Owner edits magic_messages / calls / replies / templates per day,
//      plus min login + max idle hours. Saved → applies to everyone in
//      that role unless overridden in card 2.
//   2. Per-member overrides — pick a teammate, override any of the six
//      metrics with a number, or leave blank to inherit. Toggle whether
//      this member can view OTHERS' scores (default off).

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  KeyRound,
  Loader2,
  Phone,
  RotateCcw,
  Save,
  Target,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { ROLE_LABEL, type Role } from "@/lib/team-types";

interface RoleRow {
  role: Role;
  magic_messages_per_day: number;
  calls_per_day: number;
  text_replies_per_day: number;
  template_sends_per_day: number;
  max_idle_hours_per_day: number;
  min_login_hours_per_day: number;
}

interface MemberOverride {
  member_id: string;
  magic_messages_per_day: number | null;
  calls_per_day: number | null;
  text_replies_per_day: number | null;
  template_sends_per_day: number | null;
  max_idle_hours_per_day: number | null;
  min_login_hours_per_day: number | null;
  can_view_team_scores: boolean;
}

interface TeamMemberLite {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  team_id?: string | null;
}

const METRICS: Array<{
  key: keyof Omit<RoleRow, "role">;
  label: string;
  unit: string;
  hint: string;
}> = [
  { key: "magic_messages_per_day", label: "Magic messages", unit: "/ day", hint: "Outbound magic-message template sends" },
  { key: "calls_per_day",          label: "Calls handled", unit: "/ day", hint: "WhatsApp calls accepted" },
  { key: "text_replies_per_day",   label: "Text replies",  unit: "/ day", hint: "Outbound free-form text replies" },
  { key: "template_sends_per_day", label: "Template sends", unit: "/ day", hint: "Any template (incl. magic message)" },
  { key: "min_login_hours_per_day", label: "Min login hours", unit: "h",   hint: "Daily working window minimum" },
  { key: "max_idle_hours_per_day",  label: "Max idle hours",  unit: "h",   hint: "Penalises anything above this" },
];

export function TargetsView({
  isOwner = true,
  leadTeamId = null,
}: {
  /** Owner edits role defaults + everyone's overrides. A Team Lead (isOwner
   *  false, leadTeamId set) only edits their own team's member overrides. */
  isOwner?: boolean;
  leadTeamId?: string | null;
}) {
  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Target}
        title="Targets"
        subtitle={
          isOwner
            ? "KRA / KPA baselines per role + per-member overrides. Drives the score badge + Reports."
            : "Set your team members' KRA targets. Drives their score badge + Reports."
        }
        tone="violet"
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {isOwner ? <RoleTargetsCard /> : null}
          <MemberOverridesCard isOwner={isOwner} leadTeamId={leadTeamId} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role defaults card
// ---------------------------------------------------------------------------
function RoleTargetsCard() {
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [savingRole, setSavingRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedRole, setSavedRole] = useState<Role | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/targets/role", { cache: "no-store" });
      const json = (await res.json()) as { rows?: RoleRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function update(role: Role, key: keyof Omit<RoleRow, "role">, value: number) {
    setRows((prev) =>
      prev?.map((r) => (r.role === role ? { ...r, [key]: value } : r)) ?? prev,
    );
  }

  async function save(row: RoleRow) {
    setSavingRole(row.role);
    setError(null);
    setSavedRole(null);
    try {
      const res = await fetch("/api/targets/role", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      const json = (await res.json()) as { row?: RoleRow; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedRole(row.role);
      setTimeout(() => setSavedRole(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingRole(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100">
          <KeyRound className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Role defaults</h2>
          <p className="text-[10px] text-muted-foreground">
            Everyone in this role uses these targets unless overridden below.
          </p>
        </div>
      </header>
      {error ? (
        <div className="border-b border-rose-200 bg-rose-50/60 px-5 py-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}
      {rows === null ? (
        <div className="grid h-32 place-items-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <div className="divide-y">
          {rows.map((row) => (
            <div key={row.role} className="px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold">{ROLE_LABEL[row.role]}</div>
                <button
                  type="button"
                  onClick={() => save(row)}
                  disabled={savingRole === row.role}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
                >
                  {savingRole === row.role ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : savedRole === row.role ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {savedRole === row.role ? "Saved" : "Save"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {METRICS.map((m) => (
                  <NumberField
                    key={m.key}
                    label={m.label}
                    unit={m.unit}
                    hint={m.hint}
                    value={row[m.key]}
                    onChange={(v) => update(row.role, m.key, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-member overrides card
// ---------------------------------------------------------------------------
function MemberOverridesCard({
  isOwner,
  leadTeamId,
}: {
  isOwner: boolean;
  leadTeamId: string | null;
}) {
  const [members, setMembers] = useState<TeamMemberLite[] | null>(null);
  const [overrides, setOverrides] = useState<MemberOverride[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function loadMembers() {
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      const json = (await res.json()) as { members?: TeamMemberLite[] };
      // A Team Lead only manages their own team's members.
      const all = json.members ?? [];
      const scoped = leadTeamId ? all.filter((m) => m.team_id === leadTeamId) : all;
      setMembers(scoped);
      if (!activeId && scoped.length) {
        setActiveId(scoped[0].id);
      }
    } catch {
      setMembers([]);
    }
  }
  async function loadOverrides() {
    try {
      const res = await fetch("/api/targets/member", { cache: "no-store" });
      const json = (await res.json()) as { rows?: MemberOverride[] };
      setOverrides(json.rows ?? []);
    } catch {
      setOverrides([]);
    }
  }
  useEffect(() => {
    void loadMembers();
    void loadOverrides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeMember = useMemo(
    () => members?.find((m) => m.id === activeId) ?? null,
    [members, activeId],
  );
  const activeOverride = useMemo(
    () => overrides?.find((o) => o.member_id === activeId) ?? null,
    [overrides, activeId],
  );

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100">
          <Users className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Per-member overrides</h2>
          <p className="text-[10px] text-muted-foreground">
            Leave a field blank to inherit the role default. Toggle &quot;view team
            scores&quot; to let this member see everyone else&apos;s numbers.
          </p>
        </div>
      </header>
      {members === null || overrides === null ? (
        <div className="grid h-32 place-items-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : members.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          No team members yet.
        </div>
      ) : (
        <div className="grid gap-0 md:grid-cols-[220px_1fr]">
          <nav className="max-h-[420px] overflow-auto border-b bg-secondary/30 p-2 md:border-b-0 md:border-r">
            {members.map((m) => {
              const isActive = m.id === activeId;
              const hasOverride = overrides.some((o) => o.member_id === m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setActiveId(m.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition",
                    isActive
                      ? "bg-card font-semibold ring-1 ring-emerald-200"
                      : "text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <span className="truncate">
                    {m.full_name?.trim() || m.email}
                    <div className="truncate text-[10px] text-muted-foreground">
                      {ROLE_LABEL[m.role]}
                    </div>
                  </span>
                  {hasOverride ? (
                    <span className="rounded-full bg-violet-100 px-1.5 py-0 text-[9px] font-bold text-violet-700">
                      OV
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="min-w-0">
            {activeMember ? (
              <MemberEditor
                key={activeMember.id}
                member={activeMember}
                override={activeOverride}
                showCanViewTeam={isOwner}
                onSaved={() => loadOverrides()}
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function MemberEditor({
  member,
  override,
  showCanViewTeam,
  onSaved,
}: {
  member: TeamMemberLite;
  override: MemberOverride | null;
  /** The "view team scores" grant is owner-only — hidden for Team Leads. */
  showCanViewTeam: boolean;
  onSaved: () => void;
}) {
  // Each metric value held as a string so empty = inherit (vs 0).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const m of METRICS) {
      const v = override?.[m.key] as number | null | undefined;
      out[m.key] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  });
  const [canViewTeam, setCanViewTeam] = useState<boolean>(
    override?.can_view_team_scores ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // When the active member changes, refresh state from the new override.
  useEffect(() => {
    const out: Record<string, string> = {};
    for (const m of METRICS) {
      const v = override?.[m.key] as number | null | undefined;
      out[m.key] = v === null || v === undefined ? "" : String(v);
    }
    setValues(out);
    setCanViewTeam(override?.can_view_team_scores ?? false);
    setSavedAt(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override?.member_id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { member_id: member.id };
      if (showCanViewTeam) body.can_view_team_scores = canViewTeam;
      for (const m of METRICS) {
        const s = values[m.key].trim();
        body[m.key] = s === "" ? null : Number(s);
      }
      const res = await fetch("/api/targets/member", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm("Remove all overrides for this member?")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/targets/member?member_id=${encodeURIComponent(member.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const cleared: Record<string, string> = {};
      for (const m of METRICS) cleared[m.key] = "";
      setValues(cleared);
      setCanViewTeam(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="border-b bg-secondary/20 px-5 py-2.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Phone className="h-3 w-3" />
          {member.full_name?.trim() || member.email}
          <span className="font-mono">· {member.email}</span>
        </span>
      </div>

      <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
        {METRICS.map((m) => (
          <div key={m.key}>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {m.label}
            </label>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={values[m.key]}
                onChange={(e) =>
                  setValues({ ...values, [m.key]: e.target.value })
                }
                placeholder="inherit"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm font-mono shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="text-[10px] text-muted-foreground">{m.unit}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{m.hint}</div>
          </div>
        ))}
      </div>

      {showCanViewTeam ? (
        <div className="border-t bg-amber-50/30 px-5 py-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-amber-400"
              checked={canViewTeam}
              onChange={(e) => setCanViewTeam(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium">
                Allow this member to view team scores
              </span>
              <span className="block text-[11px] text-muted-foreground">
                When ON, this member sees the full Reports page (everyone&apos;s
                numbers). Owner always can.
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <footer className="flex items-center justify-between gap-2 border-t bg-secondary/30 px-5 py-3">
        <div className="text-xs">
          {error ? (
            <span className="text-rose-700">{error}</span>
          ) : savedAt ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : (
            <span className="text-muted-foreground">
              Blank = inherit role default.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to role
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save override
          </button>
        </div>
      </footer>
    </div>
  );
}

function NumberField({
  label,
  unit,
  hint,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm font-mono shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}
