"use client";

// Settings → Permissions. Shows defaults per role, editable for
// superadmin / owner. Owner row is locked to "full access".

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Crown,
  KeyRound,
  Loader2,
  Lock,
  Phone,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";
import { ROLE_LABEL, type Role } from "@/lib/team-types";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_LABEL,
  CAPABILITY_DESCRIPTION,
  type RolePermissions,
} from "@/lib/permission-types";
import { cn } from "@/lib/utils";
import {
  PermissionsCard,
  Section,
  ToggleRow,
  PanelGrid,
  SettingsTabsGrid,
  NumbersGrid,
  type BusinessNumberLite,
} from "@/components/permissions/Pieces";

interface ApiResp {
  me: { id: string; role: Role };
  role_permissions: Record<Role, RolePermissions>;
  numbers: BusinessNumberLite[];
  error?: string;
}

const ROLE_TONE: Record<Role, string> = {
  owner: "bg-amber-50 text-amber-800 ring-amber-200",
  superadmin: "bg-purple-50 text-purple-800 ring-purple-200",
  admin: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  teammate: "bg-secondary text-foreground/70 ring-border",
};

const ROLE_ICON = { owner: Crown, superadmin: ShieldCheck, admin: Shield, teammate: User } as const;

export function PermissionsView() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Role>("teammate");

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/team/permissions", { cache: "no-store" });
      const json = (await res.json()) as ApiResp;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const rolesInOrder = useMemo<Role[]>(
    () => ["owner", "superadmin", "admin", "teammate"],
    [],
  );

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading permissions…
      </div>
    );
  }

  const current = data.role_permissions[active];

  return (
    <div className="flex h-full flex-col">
      <SettingsPageHeader
        icon={KeyRound}
        tone="violet"
        title="Role defaults"
        subtitle="Baseline access per role. Individual member overrides (Team tab) take precedence."
        right={
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-200 sm:inline-flex">
            <Sparkles className="h-3 w-3" /> Per-role &amp; per-member overrides enabled
          </span>
        }
      />
      {/* Explainer banner — collapsible. Operators kept asking what
          this page actually controls vs the per-member sheet; this
          gives them a one-glance answer. */}
      <div className="mx-auto w-full max-w-6xl px-6 pt-4">
        <div className="rounded-xl border bg-gradient-to-br from-violet-50/60 via-card to-emerald-50/40 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-violet-700">
            How permissions resolve
          </p>
          <div className="mt-1.5 grid gap-2 text-[12px] text-foreground/85 md:grid-cols-3">
            <div>
              <span className="font-semibold text-foreground">1. Role default</span>
              <span className="block text-muted-foreground">
                Set here, applies to every member with that role.
              </span>
            </div>
            <div>
              <span className="font-semibold text-foreground">2. Member override</span>
              <span className="block text-muted-foreground">
                Set in Team → Customize. Wins over the role default for that one person.
              </span>
            </div>
            <div>
              <span className="font-semibold text-foreground">3. Owner</span>
              <span className="block text-muted-foreground">
                Always full access. Can&apos;t be edited from this page.
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[220px_1fr]">
        {/* Role picker rail */}
        <nav className="flex flex-col gap-1.5">
          {rolesInOrder.map((r) => {
            const Icon = ROLE_ICON[r];
            const isActive = r === active;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setActive(r)}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition",
                  isActive
                    ? "border-primary/40 bg-primary/5 shadow-sm"
                    : "border-transparent hover:bg-secondary",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 items-center justify-center rounded-md ring-1",
                      ROLE_TONE[r],
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium leading-tight">{ROLE_LABEL[r]}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {r === "owner" ? "Full access (locked)" : "Editable defaults"}
                    </span>
                  </span>
                </span>
                {r === "owner" ? (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </nav>

        <RoleEditor
          role={active}
          perms={current}
          numbers={data.numbers}
          onSaved={(updated) => {
            setData((d) =>
              d ? { ...d, role_permissions: { ...d.role_permissions, [active]: updated } } : d,
            );
          }}
        />
      </div>
    </div>
  );
}

function RoleEditor({
  role,
  perms,
  numbers,
  onSaved,
}: {
  role: Role;
  perms: RolePermissions;
  numbers: BusinessNumberLite[];
  onSaved: (next: RolePermissions) => void;
}) {
  const locked = role === "owner";
  const [draft, setDraft] = useState<RolePermissions>(perms);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(perms);
    setSavedAt(null);
    setErr(null);
  }, [role, perms]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(perms), [draft, perms]);

  async function save() {
    if (locked) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/team/permissions/role/${role}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowed_number_ids: draft.allowed_number_ids,
          allowed_panels: draft.allowed_panels,
          allowed_settings_tabs: draft.allowed_settings_tabs,
          mask_phone_numbers: draft.mask_phone_numbers,
          mask_emails: draft.mask_emails,
          mask_source_subsource: draft.mask_source_subsource,
          can_send_messages: draft.can_send_messages,
          can_use_magic_message: draft.can_use_magic_message,
          can_export_data: draft.can_export_data,
          can_assign_contacts: draft.can_assign_contacts,
          can_manage_templates: draft.can_manage_templates,
          can_manage_automation: draft.can_manage_automation,
          can_make_calls: draft.can_make_calls,
          can_view_call_history: draft.can_view_call_history,
          can_manage_team: draft.can_manage_team,
          can_manage_numbers: draft.can_manage_numbers,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved(json.role_permissions as RolePermissions);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PermissionsCard
      title={`${ROLE_LABEL[role]} defaults`}
      subtitle={
        locked
          ? "Owners always have unrestricted access. This role can't be edited."
          : "Defaults apply to every member with this role unless they have a custom override."
      }
      footer={
        locked ? null : (
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {err ? (
                <span className="inline-flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" /> {err}
                </span>
              ) : savedAt ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-600">
                  <Check className="h-3.5 w-3.5" /> Saved
                </span>
              ) : dirty ? (
                "Unsaved changes"
              ) : (
                "All changes saved"
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => setDraft(perms)}
                className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-secondary disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={save}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save changes
              </button>
            </div>
          </div>
        )
      }
    >
      <fieldset disabled={locked} className="space-y-6 disabled:opacity-60">
        <Section
          icon={Phone}
          title="WhatsApp numbers"
          description="Which business numbers this role can see in the inbox / contacts / send-from picker."
        >
          <NumbersGrid
            numbers={numbers}
            value={draft.allowed_number_ids}
            onChange={(next) => setDraft((d) => ({ ...d, allowed_number_ids: next }))}
          />
        </Section>

        <Section
          icon={KeyRound}
          title="Sidebar panels"
          description="Visible nav items. Hidden panels are also blocked at the route level."
        >
          <PanelGrid
            value={draft.allowed_panels}
            onChange={(next) => setDraft((d) => ({ ...d, allowed_panels: next }))}
          />
        </Section>

        <Section
          icon={KeyRound}
          title="Settings tabs"
          description="Which sub-tabs inside /settings this role can see (Team, Permissions, Numbers, etc.). Tabs are also blocked at the route level."
        >
          <SettingsTabsGrid
            value={draft.allowed_settings_tabs}
            onChange={(next) => setDraft((d) => ({ ...d, allowed_settings_tabs: next }))}
          />
        </Section>

        <Section
          icon={ShieldCheck}
          title="Privacy"
          description="Mask sensitive contact data when this role views chats and lists."
        >
          <div className="grid gap-2">
            <ToggleRow
              label="Mask phone numbers"
              description="Show contact phone numbers as +91 ••••• 12 across the app."
              value={draft.mask_phone_numbers}
              onChange={(v) => setDraft((d) => ({ ...d, mask_phone_numbers: v }))}
            />
            <ToggleRow
              label="Mask emails"
              description="Show email addresses as a••••@domain.com."
              value={draft.mask_emails}
              onChange={(v) => setDraft((d) => ({ ...d, mask_emails: v }))}
            />
            <ToggleRow
              label="Mask source & sub-source"
              description="Hide the lead's Source / Sub-source pills in Contact details."
              value={draft.mask_source_subsource}
              onChange={(v) => setDraft((d) => ({ ...d, mask_source_subsource: v }))}
            />
          </div>
        </Section>

        {/* Capabilities — bucketed into Messaging / Inbox / Content /
            Admin / LSQ so the operator can scan the relevant section
            instead of pattern-matching 13 toggles in one grid. */}
        {CAPABILITY_GROUPS.map((group) => (
          <Section
            key={group.key}
            icon={Sparkles}
            title={group.label}
            description={group.description}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {group.keys.map((key) => (
                <ToggleRow
                  key={key}
                  label={CAPABILITY_LABEL[key]}
                  description={CAPABILITY_DESCRIPTION[key]}
                  value={Boolean(draft[key as keyof RolePermissions])}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, [key]: v } as RolePermissions))
                  }
                />
              ))}
            </div>
          </Section>
        ))}
      </fieldset>
    </PermissionsCard>
  );
}

