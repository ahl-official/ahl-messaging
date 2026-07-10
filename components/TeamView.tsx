"use client";

// Settings → Team. Invite by email, change roles, deactivate, delete.
// Role-based gates mirror the API: admins manage teammates, super-admins
// manage admins+teammates, owner manages all.

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Crown,
  Eye,
  KeyRound,
  Layers,
  Loader2,
  Mail,
  Plus,
  Search,
  Power,
  PowerOff,
  Shield,
  ShieldCheck,
  Trash2,
  User,
  UserPlus,
  X,
} from "lucide-react";
import {
  ROLE_LABEL,
  ROLES,
  ROLE_RANK,
  canManageRole,
  type Role,
  type TeamMember,
} from "@/lib/team-types";
import type {
  MemberPermissionOverride,
  RolePermissions,
} from "@/lib/permission-types";
import { cn } from "@/lib/utils";
import { MemberAccessSheet } from "@/components/MemberAccessSheet";
import type { BusinessNumberLite } from "@/components/permissions/Pieces";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

interface ApiResp {
  members?: TeamMember[];
  me?: TeamMember;
  error?: string;
}

interface PermsResp {
  role_permissions?: Record<Role, RolePermissions>;
  member_overrides?: Record<string, MemberPermissionOverride>;
  number_access_modes?: Record<string, Record<string, "full" | "assigned_only">>;
  numbers?: BusinessNumberLite[];
  error?: string;
}

const ROLE_TONE: Record<Role, string> = {
  owner: "bg-amber-50 text-amber-800 ring-amber-200",
  superadmin: "bg-purple-50 text-purple-800 ring-purple-200",
  admin: "bg-primary/10 text-primary ring-primary/25",
  teammate: "bg-secondary text-foreground/70 ring-border",
};

const ROLE_ICON: Record<Role, typeof Crown> = {
  owner: Crown,
  superadmin: ShieldCheck,
  admin: Shield,
  teammate: User,
};

interface TeamChipData {
  id: string;
  name: string;
  color: string | null;
}

export function TeamView() {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [me, setMe] = useState<TeamMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [perms, setPerms] = useState<PermsResp | null>(null);
  const [accessFor, setAccessFor] = useState<TeamMember | null>(null);
  const [teams, setTeams] = useState<TeamChipData[]>([]);
  /** Free-text search across member name + email. */
  const [query, setQuery] = useState("");

  async function load() {
    setError(null);
    try {
      const [teamRes, permsRes, teamsRes] = await Promise.all([
        fetch("/api/team", { cache: "no-store" }),
        fetch("/api/team/permissions", { cache: "no-store" }),
        fetch("/api/teams", { cache: "no-store" }),
      ]);
      const json = (await teamRes.json()) as ApiResp;
      if (!teamRes.ok) throw new Error(json.error ?? `HTTP ${teamRes.status}`);
      setMembers(json.members ?? []);
      setMe(json.me ?? null);
      if (permsRes.ok) {
        const p = (await permsRes.json()) as PermsResp;
        setPerms(p);
      }
      if (teamsRes.ok) {
        const t = (await teamsRes.json()) as { teams?: TeamChipData[] };
        setTeams(t.teams ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Pending self-signups float to a dedicated section at the top so the
  // owner / admin can approve them before they get lost in the list.
  // Approved members render in the regular sorted list below.
  const pending = useMemo(() => {
    if (!members) return null;
    return members.filter((m) => m.pending_approval === true);
  }, [members]);

  const sorted = useMemo(() => {
    if (!members) return null;
    const base = [...members]
      .filter((m) => m.pending_approval !== true)
      .sort(
        (a, b) =>
          ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
          a.email.localeCompare(b.email),
      );
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) => {
      const name = [m.first_name, m.last_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return name.includes(q) || m.email.toLowerCase().includes(q);
    });
  }, [members, query]);

  const stats = useMemo(() => {
    if (!members) return null;
    const active = members.filter((m) => m.is_active);
    return {
      total: members.length,
      active: active.length,
      owner: active.filter((m) => m.role === "owner").length,
    };
  }, [members]);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={UserPlus}
        tone="emerald"
        title="Team"
        subtitle="Invite agents, change roles, and deactivate access. Members sign in with Google."
        right={
          me && ROLE_RANK[me.role] >= ROLE_RANK["admin"] ? (
            <button
              type="button"
              onClick={() => setInviting(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              Invite member
            </button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-3">
          {stats ? (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Total" value={stats.total} />
              <Stat label="Active" value={stats.active} tone="emerald" />
              <Stat label="Owners" value={stats.owner} tone="amber" />
            </div>
          ) : null}

          {members && members.length > 0 ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search team by name or email…"
                className="h-9 w-full rounded-lg border bg-card pl-9 pr-3 text-sm shadow-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {pending && pending.length > 0 && me && ROLE_RANK[me.role] >= ROLE_RANK["admin"] ? (
            <PendingApprovals members={pending} onChanged={load} />
          ) : null}

          {sorted === null ? (
            <SkeletonState />
          ) : sorted.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card px-6 py-8 text-center text-sm text-muted-foreground">
              {query.trim() ? `No members match "${query.trim()}".` : "No team members yet."}
            </div>
          ) : (
            <ul className="overflow-hidden rounded-xl border bg-card shadow-sm">
              {sorted.map((m) => {
                const hasOverride = perms?.member_overrides
                  ? Boolean(perms.member_overrides[m.id])
                  : false;
                return (
                  <li key={m.id} className="border-b last:border-b-0">
                    <MemberRow
                      member={m}
                      me={me}
                      hasOverride={hasOverride}
                      teams={teams}
                      onChanged={load}
                      onCustomize={() => setAccessFor(m)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {inviting && me ? (
        <InviteDialog me={me} onClose={() => setInviting(false)} onSaved={load} />
      ) : null}

      <MemberAccessSheet
        open={accessFor !== null}
        member={accessFor}
        rolePerms={
          accessFor && perms?.role_permissions
            ? perms.role_permissions[accessFor.role]
            : null
        }
        override={
          accessFor && perms?.member_overrides
            ? perms.member_overrides[accessFor.id] ?? null
            : null
        }
        numberAccessModes={
          accessFor && perms?.number_access_modes
            ? perms.number_access_modes[accessFor.id] ?? {}
            : {}
        }
        numbers={perms?.numbers ?? []}
        onClose={() => setAccessFor(null)}
        onSaved={load}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending approvals — self-signups waiting for an owner / admin to approve.
// Renders at the top of the Team page when there's at least one pending row.
// Approve → flips pending_approval=false, is_active=true (login unblocks).
// Reject  → deletes the team_members row + auth.users entry (clean slate).
// ---------------------------------------------------------------------------
function PendingApprovals({
  members,
  onChanged,
}: {
  members: TeamMember[];
  onChanged: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/40 shadow-sm">
      <header className="flex items-center gap-2 border-b border-amber-200 bg-amber-50/80 px-4 py-2.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-800">
          <UserPlus className="h-3.5 w-3.5" />
        </span>
        <div>
          <div className="text-sm font-semibold text-amber-900">
            Pending approvals · {members.length}
          </div>
          <div className="text-[11px] text-amber-800/80">
            New sign-ups waiting for you to approve. They can&apos;t access the inbox until you do.
          </div>
        </div>
      </header>
      <ul className="divide-y divide-amber-200/60">
        {members.map((m) => (
          <li key={m.id}>
            <PendingRow member={m} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PendingRow({
  member,
  onChanged,
}: {
  member: TeamMember;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      const res = await fetch("/api/team", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, approve: true }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!confirm(`Reject ${member.email}? Their account will be deleted.`)) return;
    setBusy("reject");
    setErr(null);
    try {
      const res = await fetch(`/api/team?id=${encodeURIComponent(member.id)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }

  const initials =
    [member.first_name?.[0], member.last_name?.[0]].filter(Boolean).join("") ||
    member.email[0]?.toUpperCase() ||
    "?";
  const displayName =
    [member.first_name, member.last_name].filter(Boolean).join(" ") ||
    member.full_name ||
    member.email.split("@")[0];

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
        {initials.toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{displayName}</div>
        <div className="truncate text-[11px] text-muted-foreground">{member.email}</div>
      </div>
      <button
        type="button"
        onClick={approve}
        disabled={busy !== null}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
      >
        {busy === "approve" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Check className="h-3 w-3" />
        )}
        Approve
      </button>
      <button
        type="button"
        onClick={reject}
        disabled={busy !== null}
        className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-background px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        {busy === "reject" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <X className="h-3 w-3" />
        )}
        Reject
      </button>
      {err ? (
        <div className="basis-full rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
}) {
  const ring = tone === "emerald"
    ? "ring-primary/20"
    : tone === "amber"
      ? "ring-amber-100"
      : "ring-border";
  const accent = tone === "emerald"
    ? "bg-primary/10 text-primary"
    : tone === "amber"
      ? "bg-amber-500/10 text-amber-700"
      : "bg-secondary text-foreground/70";
  return (
    <div className={cn("rounded-xl border bg-card px-4 py-3 ring-1", ring)}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className={cn("mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", accent)}>
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-row controls
// ---------------------------------------------------------------------------
function MemberRow({
  member,
  me,
  hasOverride,
  teams,
  onChanged,
  onCustomize,
}: {
  member: TeamMember;
  me: TeamMember | null;
  hasOverride: boolean;
  teams: TeamChipData[];
  onChanged: () => void;
  onCustomize: () => void;
}) {
  const isMe = me && me.id === member.id;
  const canEdit = me ? canManageRole(me.role, member.role) : false;
  const RoleIcon = ROLE_ICON[member.role];

  const initials =
    [member.first_name?.[0], member.last_name?.[0]].filter(Boolean).join("") ||
    member.email[0]?.toUpperCase() ||
    "?";

  const displayName =
    [member.first_name, member.last_name].filter(Boolean).join(" ") ||
    member.full_name ||
    member.email.split("@")[0];

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function update(body: Record<string, unknown>) {
    setBusy("update");
    setErr(null);
    try {
      const res = await fetch("/api/team", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, ...body }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ${member.email}? This action cannot be undone.`)) return;
    setBusy("delete");
    setErr(null);
    try {
      const res = await fetch(`/api/team?id=${encodeURIComponent(member.id)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  const assignableRoles = me
    ? (ROLES.filter((r) => canManageRole(me.role, r)) as Role[])
    : [];

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ring-1 ring-inset",
          member.is_active
            ? "bg-primary/15 text-primary ring-primary/25"
            : "bg-secondary text-muted-foreground ring-border opacity-60",
        )}
      >
        {initials.toUpperCase()}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={cn(
              "truncate text-sm font-semibold",
              !member.is_active && "text-muted-foreground line-through",
            )}
          >
            {displayName}
          </span>
          {isMe ? (
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              You
            </span>
          ) : null}
          {!member.user_id ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
              <Mail className="h-2.5 w-2.5" />
              Invited
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {member.email}
        </div>
      </div>

      {/* Role pill (becomes a select for editable rows) */}
      {canEdit && !isMe ? (
        <select
          value={member.role}
          onChange={(e) => update({ role: e.target.value as Role })}
          disabled={busy !== null}
          className={cn(
            "rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-primary/30",
            ROLE_TONE[member.role],
          )}
        >
          {assignableRoles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset",
            ROLE_TONE[member.role],
          )}
        >
          <RoleIcon className="h-3 w-3" />
          {ROLE_LABEL[member.role]}
        </span>
      )}

      {/* Team pill — editable when the operator can manage this row. */}
      {canEdit && !isMe ? (
        <select
          value={member.team_id ?? ""}
          onChange={(e) => update({ team_id: e.target.value || null })}
          disabled={busy !== null}
          className="rounded-full bg-secondary px-2 py-1 text-[11px] font-semibold text-foreground/80 ring-1 ring-inset ring-border focus:outline-none focus:ring-2 focus:ring-primary/30"
          title="Team"
        >
          <option value="">— No team —</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      ) : member.team_id ? (
        <TeamChip team={teams.find((t) => t.id === member.team_id) ?? null} />
      ) : null}

      {/* Team Lead toggle — only for a member assigned to a team. A TL can
          view their team's report + set their team members' KRA targets. */}
      {canEdit && !isMe && member.role !== "owner" && member.team_id ? (
        <button
          type="button"
          onClick={() => update({ is_team_lead: !member.is_team_lead })}
          disabled={busy !== null}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset transition disabled:opacity-50",
            member.is_team_lead
              ? "bg-violet-100 text-violet-700 ring-violet-200"
              : "bg-secondary text-foreground/50 ring-border hover:bg-secondary/70",
          )}
          title={
            member.is_team_lead
              ? "Team Lead — click to remove"
              : "Make Team Lead (sees this team's report + sets their KRA)"
          }
        >
          <Crown className="h-3 w-3" />
          TL
        </button>
      ) : null}

      {/* Monitor toggle — a watch-only user. Leads owned by a monitor
          count as "unassigned/available" in the inbox so a full-access
          agent can pick them up. */}
      {canEdit && !isMe && member.role !== "owner" ? (
        <button
          type="button"
          onClick={() => update({ is_monitor: !member.is_monitor })}
          disabled={busy !== null}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset transition disabled:opacity-50",
            member.is_monitor
              ? "bg-amber-100 text-amber-700 ring-amber-200"
              : "bg-secondary text-foreground/50 ring-border hover:bg-secondary/70",
          )}
          title={
            member.is_monitor
              ? "Monitor — their leads show as Unassigned. Click to make a working agent."
              : "Mark as Monitor (watch-only; their leads count as Unassigned/available)"
          }
        >
          <Eye className="h-3 w-3" />
          Monitor
        </button>
      ) : null}

      {/* Customize access (per-member overrides) */}
      {canEdit && !isMe && member.role !== "owner" ? (
        <button
          type="button"
          onClick={onCustomize}
          disabled={busy !== null}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium transition hover:bg-secondary disabled:opacity-50",
            hasOverride && "border-primary/40 bg-primary/5 text-primary",
          )}
          title={hasOverride ? "Custom access in effect" : "Customize access"}
        >
          <KeyRound className="h-3 w-3" />
          {hasOverride ? "Custom" : "Access"}
        </button>
      ) : null}

      {/* Active toggle */}
      {canEdit && !isMe ? (
        <button
          type="button"
          onClick={() => update({ is_active: !member.is_active })}
          disabled={busy !== null}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium hover:bg-secondary disabled:opacity-50",
            member.is_active ? "text-foreground" : "text-primary",
          )}
        >
          {member.is_active ? (
            <>
              <PowerOff className="h-3 w-3" /> Deactivate
            </>
          ) : (
            <>
              <Power className="h-3 w-3" /> Activate
            </>
          )}
        </button>
      ) : null}

      {/* Delete (owner only) */}
      {me?.role === "owner" && !isMe ? (
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy !== null}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          aria-label="Delete"
        >
          {busy === "delete" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      ) : null}

      {err ? (
        <div className="basis-full rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite dialog
// ---------------------------------------------------------------------------
function InviteDialog({
  me,
  onClose,
  onSaved,
}: {
  me: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<Role>("teammate");
  const [teamId, setTeamId] = useState<string>("");
  const [teams, setTeams] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/teams", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { teams?: Array<{ id: string; name: string; color: string | null }> }) =>
        setTeams(j.teams ?? []),
      )
      .catch(() => {});
  }, []);

  const assignableRoles = ROLES.filter((r) => canManageRole(me.role, r)) as Role[];

  const canSave = email.includes("@") && !saving;

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          role,
          first_name: firstName,
          last_name: lastName,
          team_id: teamId || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold">Invite team member</h3>
            <p className="text-[11px] text-muted-foreground">
              They&apos;ll get full access on first Google sign-in with this email.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="text-[11px] font-semibold text-muted-foreground">Work email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="agent@americanhairline.com"
              autoFocus
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground">First name</label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground">Last name</label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-muted-foreground">Team</label>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            >
              <option value="">— No team —</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-muted-foreground">Role</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {assignableRoles.map((r) => {
                const Icon = ROLE_ICON[r];
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={cn(
                      "flex items-center justify-between gap-1.5 rounded-lg border px-3 py-2 text-left text-xs transition",
                      role === r
                        ? "border-primary/30 bg-primary/10 shadow-sm"
                        : "hover:bg-secondary",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{ROLE_LABEL[r]}</span>
                    </span>
                    {role === r ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {err}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
            Send invite
          </button>
        </footer>
      </div>
    </div>
  );
}

function SkeletonState() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl border bg-card" />
      ))}
    </div>
  );
}

const TEAM_CHIP_COLORS: Record<string, string> = {
  emerald: "bg-primary/10 text-primary ring-primary/25",
  sky:     "bg-sky-50 text-sky-800 ring-sky-200",
  violet:  "bg-violet-50 text-violet-800 ring-violet-200",
  amber:   "bg-amber-50 text-amber-800 ring-amber-200",
  rose:    "bg-rose-50 text-rose-800 ring-rose-200",
  teal:    "bg-teal-50 text-teal-800 ring-teal-200",
  slate:   "bg-slate-100 text-slate-700 ring-slate-200",
};

function TeamChip({ team }: { team: { name: string; color: string | null } | null }) {
  if (!team) return null;
  const tone =
    TEAM_CHIP_COLORS[team.color ?? "slate"] ?? TEAM_CHIP_COLORS.slate;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-inset",
        tone,
      )}
      title={`Team: ${team.name}`}
    >
      <Layers className="h-3 w-3" />
      {team.name}
    </span>
  );
}
