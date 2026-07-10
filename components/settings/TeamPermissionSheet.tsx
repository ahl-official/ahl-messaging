"use client";

// Settings → Team → Groups → Permissions drawer.
// Edits the team_permissions row for one team. Same layered semantics
// as MemberAccessSheet: each field can either inherit (NULL in the DB
// → "use role default") or be explicitly set. Every member in this
// team picks up the override automatically (unless they have their
// own per-member override, which still wins).

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  Layers,
  Loader2,
  Phone,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_DESCRIPTION,
  CAPABILITY_LABEL,
  type PanelKey,
  type SettingsTabKey,
  type TeamPermissionOverride,
} from "@/lib/permission-types";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  NumbersGrid,
  PanelGrid,
  PermissionsCard,
  Section,
  SettingsTabsGrid,
  Switch,
  type BusinessNumberLite,
} from "@/components/permissions/Pieces";

interface Team {
  id: string;
  name: string;
  color: string | null;
}

interface Props {
  open: boolean;
  team: Team | null;
  onClose: () => void;
}

type DraftField<T> = { mode: "inherit" } | { mode: "custom"; value: T };

interface Draft {
  allowed_number_ids: DraftField<string[] | null>;
  allowed_panels: DraftField<PanelKey[] | null>;
  allowed_settings_tabs: DraftField<SettingsTabKey[] | null>;
  mask_phone_numbers: DraftField<boolean>;
  mask_emails: DraftField<boolean>;
  mask_source_subsource: DraftField<boolean>;
  can_send_messages: DraftField<boolean>;
  can_use_magic_message: DraftField<boolean>;
  can_export_data: DraftField<boolean>;
  can_assign_contacts: DraftField<boolean>;
  can_manage_templates: DraftField<boolean>;
  can_manage_automation: DraftField<boolean>;
  can_make_calls: DraftField<boolean>;
  can_view_call_history: DraftField<boolean>;
  can_manage_team: DraftField<boolean>;
  can_manage_numbers: DraftField<boolean>;
  can_delete_labels: DraftField<boolean>;
  lsq_assigned_visibility_only: DraftField<boolean>;
  can_sync_lsq_owner: DraftField<boolean>;
}

function fromOverride(o: TeamPermissionOverride | null): Draft {
  const f = <T,>(v: T | null | undefined): DraftField<T> =>
    v === null || v === undefined ? { mode: "inherit" } : { mode: "custom", value: v };
  return {
    allowed_number_ids: f(o?.allowed_number_ids ?? null),
    allowed_panels: f((o?.allowed_panels as PanelKey[] | null | undefined) ?? null),
    allowed_settings_tabs: f(
      (o?.allowed_settings_tabs as SettingsTabKey[] | null | undefined) ?? null,
    ),
    mask_phone_numbers: f(o?.mask_phone_numbers ?? null),
    mask_emails: f(o?.mask_emails ?? null),
    mask_source_subsource: f(o?.mask_source_subsource ?? null),
    can_send_messages: f(o?.can_send_messages ?? null),
    can_use_magic_message: f(o?.can_use_magic_message ?? null),
    can_export_data: f(o?.can_export_data ?? null),
    can_assign_contacts: f(o?.can_assign_contacts ?? null),
    can_manage_templates: f(o?.can_manage_templates ?? null),
    can_manage_automation: f(o?.can_manage_automation ?? null),
    can_make_calls: f(o?.can_make_calls ?? null),
    can_view_call_history: f(o?.can_view_call_history ?? null),
    can_manage_team: f(o?.can_manage_team ?? null),
    can_manage_numbers: f(o?.can_manage_numbers ?? null),
    can_delete_labels: f(o?.can_delete_labels ?? null),
    lsq_assigned_visibility_only: f(o?.lsq_assigned_visibility_only ?? null),
    can_sync_lsq_owner: f(o?.can_sync_lsq_owner ?? null),
  };
}

function toBody(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(d) as [keyof Draft, DraftField<unknown>][]) {
    out[key] = field.mode === "inherit" ? null : field.value;
  }
  return out;
}

function customCount(d: Draft): number {
  let n = 0;
  for (const f of Object.values(d) as DraftField<unknown>[]) {
    if (f.mode === "custom") n++;
  }
  return n;
}

export function TeamPermissionSheet({ open, team, onClose }: Props) {
  const [draft, setDraft] = useState<Draft>(() => fromOverride(null));
  const [initial, setInitial] = useState<Draft>(() => fromOverride(null));
  const [numbers, setNumbers] = useState<BusinessNumberLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Fetch the team override + numbers list whenever the sheet opens
  // for a different team. Closing zeroes the state so the next open
  // starts clean.
  useEffect(() => {
    if (!open || !team) {
      setDraft(fromOverride(null));
      setInitial(fromOverride(null));
      setSavedAt(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [permRes, permsBundle] = await Promise.all([
          fetch(`/api/teams/${team.id}/permissions`, { cache: "no-store" }),
          fetch(`/api/team/permissions`, { cache: "no-store" }),
        ]);
        const permJson = (await permRes.json()) as {
          override?: TeamPermissionOverride | null;
          error?: string;
        };
        if (!permRes.ok) throw new Error(permJson.error ?? `HTTP ${permRes.status}`);
        const bundle = permsBundle.ok
          ? ((await permsBundle.json()) as { numbers?: BusinessNumberLite[] })
          : { numbers: [] };
        if (cancelled) return;
        const next = fromOverride(permJson.override ?? null);
        setDraft(next);
        setInitial(next);
        setNumbers(bundle.numbers ?? []);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, team?.id]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );
  const overridesCount = customCount(draft);

  if (!open || !team) return null;

  async function save() {
    if (!team) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${team.id}/permissions`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toBody(draft)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setInitial(draft);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!team) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${team.id}/permissions`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const empty = fromOverride(null);
      setDraft(empty);
      setInitial(empty);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-foreground/40 backdrop-blur-sm transition"
      />
      <motion.div
        className="flex h-full w-full max-w-2xl flex-col bg-background shadow-2xl"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
      >
        <div className="flex items-start justify-between gap-3 border-b bg-card px-6 py-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Layers className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold leading-tight">
                {team.name} — team permissions
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Applies to every member of this team. Per-member overrides
                still win.{" "}
                {overridesCount === 0
                  ? "All fields inheriting from role default."
                  : `${overridesCount} custom ${overridesCount === 1 ? "field" : "fields"}.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-secondary/30 px-6 py-5">
          {loading ? (
            <div className="grid h-40 place-items-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </span>
            </div>
          ) : (
            <div className="space-y-5">
              <PermissionsCard title="WhatsApp numbers">
                <FieldShell
                  mode={draft.allowed_number_ids.mode}
                  defaultLabel="Role default (varies per role)"
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_number_ids: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_number_ids: { mode: "custom", value: null },
                    }))
                  }
                >
                  {draft.allowed_number_ids.mode === "custom" ? (
                    <Section
                      icon={Phone}
                      title="Allowed numbers"
                      description="Limit which business numbers anyone in this team can see in the inbox."
                    >
                      <NumbersGrid
                        numbers={numbers}
                        value={draft.allowed_number_ids.value}
                        onChange={(next) =>
                          setDraft((d) => ({
                            ...d,
                            allowed_number_ids: { mode: "custom", value: next },
                          }))
                        }
                      />
                    </Section>
                  ) : null}
                </FieldShell>
              </PermissionsCard>

              <PermissionsCard title="Sidebar panels">
                <FieldShell
                  mode={draft.allowed_panels.mode}
                  defaultLabel="Role default"
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_panels: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_panels: { mode: "custom", value: null },
                    }))
                  }
                >
                  {draft.allowed_panels.mode === "custom" ? (
                    <Section
                      icon={KeyRound}
                      title="Allowed panels"
                      description="Sidebar items members of this team can see."
                    >
                      <PanelGrid
                        value={draft.allowed_panels.value}
                        onChange={(next) =>
                          setDraft((d) => ({
                            ...d,
                            allowed_panels: { mode: "custom", value: next },
                          }))
                        }
                      />
                    </Section>
                  ) : null}
                </FieldShell>
              </PermissionsCard>

              <PermissionsCard title="Settings tabs">
                <FieldShell
                  mode={draft.allowed_settings_tabs.mode}
                  defaultLabel="Role default"
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_settings_tabs: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_settings_tabs: { mode: "custom", value: null },
                    }))
                  }
                >
                  {draft.allowed_settings_tabs.mode === "custom" ? (
                    <Section
                      icon={KeyRound}
                      title="Allowed settings tabs"
                      description="Sub-tabs inside Settings these members can see."
                    >
                      <SettingsTabsGrid
                        value={draft.allowed_settings_tabs.value}
                        onChange={(next) =>
                          setDraft((d) => ({
                            ...d,
                            allowed_settings_tabs: { mode: "custom", value: next },
                          }))
                        }
                      />
                    </Section>
                  ) : null}
                </FieldShell>
              </PermissionsCard>

              <PermissionsCard title="Privacy">
                <BoolFieldRow
                  label="Mask phone numbers"
                  description="Show contact phones as +91 ••••• 12."
                  field={draft.mask_phone_numbers}
                  onChange={(field) =>
                    setDraft((d) => ({ ...d, mask_phone_numbers: field }))
                  }
                />
                <BoolFieldRow
                  label="Mask emails"
                  description="Show emails as a••••@domain.com."
                  field={draft.mask_emails}
                  onChange={(field) => setDraft((d) => ({ ...d, mask_emails: field }))}
                />
                <BoolFieldRow
                  label="Mask source & sub-source"
                  description="Hide the lead's Source / Sub-source pills."
                  field={draft.mask_source_subsource}
                  onChange={(field) =>
                    setDraft((d) => ({ ...d, mask_source_subsource: field }))
                  }
                />
              </PermissionsCard>

              {/* Capabilities grouped same way as MemberAccessSheet —
                  Messaging / Inbox / Content / Admin / LSQ. */}
              {CAPABILITY_GROUPS.map((group) => (
                <PermissionsCard
                  key={group.key}
                  title={group.label}
                  subtitle={group.description}
                >
                  {group.keys.map((key) => (
                    <BoolFieldRow
                      key={key}
                      label={CAPABILITY_LABEL[key]}
                      description={CAPABILITY_DESCRIPTION[key]}
                      field={draft[key as keyof Draft] as DraftField<boolean>}
                      onChange={(field) =>
                        setDraft((d) => ({ ...d, [key]: field } as Draft))
                      }
                    />
                  ))}
                </PermissionsCard>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-card px-6 py-3">
          <div className="text-xs text-muted-foreground">
            {err ? (
              <span className="inline-flex items-center gap-1.5 text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> {err}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1.5 text-primary">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            ) : dirty ? (
              "Unsaved changes"
            ) : overridesCount === 0 ? (
              "Inheriting all settings from role"
            ) : (
              "All saved"
            )}
          </div>
          <div className="flex gap-2">
            {overridesCount > 0 ? (
              <button
                type="button"
                disabled={saving}
                onClick={clearAll}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-secondary disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset to role
              </button>
            ) : null}
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
      </motion.div>
    </motion.div>
  );
}

// ---- Local helpers — minor copies of MemberAccessSheet's primitives.
function FieldShell({
  mode,
  defaultLabel,
  onInherit,
  onCustomize,
  children,
}: {
  mode: "inherit" | "custom";
  defaultLabel: string;
  onInherit: () => void;
  onCustomize: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-md border bg-secondary/40 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">
          {mode === "inherit" ? defaultLabel : "Custom override active"}
        </span>
        {mode === "inherit" ? (
          <button
            type="button"
            onClick={onCustomize}
            className="inline-flex h-7 items-center justify-center rounded-md border bg-background px-2.5 text-xs font-medium transition hover:bg-secondary"
          >
            Customize
          </button>
        ) : (
          <button
            type="button"
            onClick={onInherit}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary"
          >
            <RotateCcw className="h-3 w-3" /> Use role default
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function BoolFieldRow({
  label,
  description,
  field,
  onChange,
}: {
  label: string;
  description?: string;
  field: DraftField<boolean>;
  onChange: (next: DraftField<boolean>) => void;
}) {
  // Without a per-team "role default" to compare against (role is
  // member-scoped, not team-scoped), inherit mode shows the toggle in
  // a neutral position. Explicit choice shows the picked state.
  const checked = field.mode === "custom" ? field.value : false;
  const isInherit = field.mode === "inherit";
  return (
    <div className="flex items-start gap-3 border-b py-2.5 last:border-b-0">
      <Switch
        checked={checked}
        onChange={(v) => onChange({ mode: "custom", value: v })}
      />
      <div className="flex-1 leading-tight">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {isInherit ? (
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Inherits
            </span>
          ) : (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              Custom
            </span>
          )}
        </div>
        {description ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {!isInherit ? (
        <button
          type="button"
          onClick={() => onChange({ mode: "inherit" })}
          className="text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}

// Tree-shakable barrel — keeps unused-import lints quiet for icons we
// re-import for clarity / future use.
void Sparkles;
void ShieldCheck;
