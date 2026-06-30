"use client";

// Per-member access drawer. Opens from TeamView when an admin clicks
// "Customize" on a row. Shows resolved (effective) permissions with the
// ability to override individual fields, or reset to role default.
//
// Field model: each form field can be in one of two modes:
//   - "Inherit role" (override is null) — shown as a small badge on the row
//   - "Custom"       (override has a value) — user explicitly set it
// Toggling between modes is via a small ⟳/× button next to each field.

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  Loader2,
  Phone,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { ROLE_LABEL, type Role, type TeamMember, memberDisplayName } from "@/lib/team-types";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_KEYS,
  CAPABILITY_DESCRIPTION,
  CAPABILITY_LABEL,
  resolveEffective,
  type MemberPermissionOverride,
  type PanelKey,
  type RolePermissions,
  type SettingsTabKey,
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
import { SessionsCard } from "@/components/SessionsCard";

interface SheetProps {
  open: boolean;
  member: TeamMember | null;
  rolePerms: RolePermissions | null;
  override: MemberPermissionOverride | null;
  /** Per-bpid visibility overrides for this member, loaded from the
   *  member_number_access table. Empty object = "fall back to the
   *  global lsq_assigned_visibility_only flag for every number". */
  numberAccessModes: Record<string, "full" | "assigned_only">;
  numbers: BusinessNumberLite[];
  onClose: () => void;
  onSaved: () => void;
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
  can_align_dates: DraftField<boolean>;
}

function fromOverride(o: MemberPermissionOverride | null): Draft {
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
    can_align_dates: f(o?.can_align_dates ?? null),
  };
}

// Partial patch: emit ONLY the fields that actually changed vs the loaded
// baseline. A full snapshot (every key, every save) was the root cause of
// number access vanishing — toggling any unrelated capability re-sent
// allowed_number_ids:null (whenever that field read "inherit") and the
// PATCH NULLed the stored allow-list. The route gates each field on
// `"x" in body`, so omitting an unchanged key leaves the stored value
// untouched.
function buildDelta(d: Draft, base: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(d) as [keyof Draft, DraftField<unknown>][]) {
    if (JSON.stringify(field) !== JSON.stringify(base[key])) {
      out[key] = field.mode === "inherit" ? null : field.value;
    }
  }
  return out;
}

// Helper: how many fields have an explicit override?
function customCount(d: Draft): number {
  let n = 0;
  for (const f of Object.values(d) as DraftField<unknown>[]) {
    if (f.mode === "custom") n++;
  }
  return n;
}

export function MemberAccessSheet(props: SheetProps) {
  const {
    open,
    member,
    rolePerms,
    override,
    numberAccessModes,
    numbers,
    onClose,
    onSaved,
  } = props;

  const [draft, setDraft] = useState<Draft>(() => fromOverride(override));
  // Per-number visibility draft — modes the operator has chosen but
  // not yet saved. Initialised from the prop on member switch.
  const [numberModesDraft, setNumberModesDraft] = useState<
    Record<string, "full" | "assigned_only">
  >(numberAccessModes);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed ONLY when the sheet opens for a member — NOT on every parent
  // refetch. TeamView derives `override` / `numberAccessModes` inline, so
  // each load() (e.g. save → onSaved → load, or any other row action) hands
  // fresh references; resetting on those clobbered an in-progress edit and
  // re-seeded allowed_number_ids to "inherit", which the next save then
  // persisted as null. Pinning to (member id, open) keeps the draft stable
  // across background refetches.
  useEffect(() => {
    if (!open) return;
    setDraft(fromOverride(override));
    setNumberModesDraft(numberAccessModes);
    setSavedAt(null);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member?.id, open]);

  const initial = useMemo(() => fromOverride(override), [override]);
  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !== JSON.stringify(initial) ||
      JSON.stringify(numberModesDraft) !== JSON.stringify(numberAccessModes),
    [draft, initial, numberModesDraft, numberAccessModes],
  );
  const overridesCount = customCount(draft);

  const effective = useMemo(() => {
    if (!member || !rolePerms) return null;
    // Build a "virtual" override row from the draft to preview effective perms.
    const virt: MemberPermissionOverride = {
      member_id: member.id,
      allowed_number_ids: draft.allowed_number_ids.mode === "custom" ? draft.allowed_number_ids.value : null,
      allowed_panels: (draft.allowed_panels.mode === "custom" ? draft.allowed_panels.value : null) as PanelKey[] | null,
      allowed_settings_tabs: (draft.allowed_settings_tabs.mode === "custom"
        ? draft.allowed_settings_tabs.value
        : null) as SettingsTabKey[] | null,
      mask_phone_numbers: draft.mask_phone_numbers.mode === "custom" ? draft.mask_phone_numbers.value : null,
      mask_emails: draft.mask_emails.mode === "custom" ? draft.mask_emails.value : null,
      mask_source_subsource:
        draft.mask_source_subsource.mode === "custom" ? draft.mask_source_subsource.value : null,
      can_send_messages: draft.can_send_messages.mode === "custom" ? draft.can_send_messages.value : null,
      can_use_magic_message: draft.can_use_magic_message.mode === "custom" ? draft.can_use_magic_message.value : null,
      can_export_data: draft.can_export_data.mode === "custom" ? draft.can_export_data.value : null,
      can_assign_contacts: draft.can_assign_contacts.mode === "custom" ? draft.can_assign_contacts.value : null,
      can_manage_templates: draft.can_manage_templates.mode === "custom" ? draft.can_manage_templates.value : null,
      can_manage_automation: draft.can_manage_automation.mode === "custom" ? draft.can_manage_automation.value : null,
      can_make_calls: draft.can_make_calls.mode === "custom" ? draft.can_make_calls.value : null,
      can_view_call_history: draft.can_view_call_history.mode === "custom" ? draft.can_view_call_history.value : null,
      can_manage_team: draft.can_manage_team.mode === "custom" ? draft.can_manage_team.value : null,
      can_manage_numbers: draft.can_manage_numbers.mode === "custom" ? draft.can_manage_numbers.value : null,
      can_delete_labels: draft.can_delete_labels.mode === "custom" ? draft.can_delete_labels.value : null,
      lsq_assigned_visibility_only:
        draft.lsq_assigned_visibility_only.mode === "custom"
          ? draft.lsq_assigned_visibility_only.value
          : null,
      can_sync_lsq_owner:
        draft.can_sync_lsq_owner.mode === "custom"
          ? draft.can_sync_lsq_owner.value
          : null,
      can_align_dates:
        draft.can_align_dates.mode === "custom" ? draft.can_align_dates.value : null,
    };
    return resolveEffective(member.role as Role, rolePerms, virt);
  }, [draft, member, rolePerms]);

  if (!open || !member) return null;

  async function save() {
    if (!member) return;
    setSaving(true);
    setErr(null);
    try {
      // Only the fields the operator actually changed — never re-send an
      // untouched allowed_number_ids / number_access_modes, which is what
      // wiped granted access on unrelated saves.
      const payload: Record<string, unknown> = buildDelta(draft, initial);
      if (
        JSON.stringify(numberModesDraft) !== JSON.stringify(numberAccessModes)
      ) {
        payload.number_access_modes = numberModesDraft;
      }
      const res = await fetch(`/api/team/permissions/member/${member.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!member) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/team/permissions/member/${member.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDraft(fromOverride(null));
      setNumberModesDraft({});
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  const displayName = memberDisplayName(member) ?? member.email;
  const isOwner = member.role === "owner";

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
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b bg-card px-6 py-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold leading-tight">Customize access</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {displayName} · <span className="font-medium">{ROLE_LABEL[member.role]}</span> ·
                {" "}
                {overridesCount === 0
                  ? "All settings inherited from role."
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

        {/* Body */}
        <div className="flex-1 overflow-auto bg-secondary/30 px-6 py-5">
          {isOwner ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Owners always have unrestricted access. Customizing the owner role is disabled.
            </div>
          ) : !rolePerms || !effective ? (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : (
            <div className="space-y-5">
              <PermissionsCard title="WhatsApp numbers">
                <FieldShell
                  mode={draft.allowed_number_ids.mode}
                  defaultLabel={
                    rolePerms.allowed_number_ids === null
                      ? "All numbers (role default)"
                      : `${rolePerms.allowed_number_ids.length} numbers (role default)`
                  }
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_number_ids: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_number_ids: {
                        mode: "custom",
                        value: rolePerms.allowed_number_ids,
                      },
                    }))
                  }
                >
                  {draft.allowed_number_ids.mode === "custom" ? (
                    <Section
                      icon={Phone}
                      title="Allowed numbers"
                      description="Override the role default for this member only."
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
                  defaultLabel={
                    rolePerms.allowed_panels === null
                      ? "All panels (role default)"
                      : `${rolePerms.allowed_panels.length} panels (role default)`
                  }
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_panels: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_panels: {
                        mode: "custom",
                        value: (rolePerms.allowed_panels ?? null) as PanelKey[] | null,
                      },
                    }))
                  }
                >
                  {draft.allowed_panels.mode === "custom" ? (
                    <Section
                      icon={KeyRound}
                      title="Allowed panels"
                      description="Sidebar items this member can see."
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
                  defaultLabel={
                    !rolePerms.allowed_settings_tabs
                      ? "All tabs (role default)"
                      : `${rolePerms.allowed_settings_tabs.length} tabs (role default)`
                  }
                  onInherit={() =>
                    setDraft((d) => ({ ...d, allowed_settings_tabs: { mode: "inherit" } }))
                  }
                  onCustomize={() =>
                    setDraft((d) => ({
                      ...d,
                      allowed_settings_tabs: {
                        mode: "custom",
                        value: (rolePerms.allowed_settings_tabs ?? null) as SettingsTabKey[] | null,
                      },
                    }))
                  }
                >
                  {draft.allowed_settings_tabs.mode === "custom" ? (
                    <Section
                      icon={KeyRound}
                      title="Allowed settings tabs"
                      description="Sub-tabs inside Settings this member can see."
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
                  defaultValue={rolePerms.mask_phone_numbers}
                  onChange={(field) =>
                    setDraft((d) => ({ ...d, mask_phone_numbers: field }))
                  }
                />
                <BoolFieldRow
                  label="Mask emails"
                  description="Show emails as a••••@domain.com."
                  field={draft.mask_emails}
                  defaultValue={rolePerms.mask_emails}
                  onChange={(field) => setDraft((d) => ({ ...d, mask_emails: field }))}
                />
                <BoolFieldRow
                  label="Mask source & sub-source"
                  description="Hide the lead's Source / Sub-source pills."
                  field={draft.mask_source_subsource}
                  defaultValue={rolePerms.mask_source_subsource}
                  onChange={(field) =>
                    setDraft((d) => ({ ...d, mask_source_subsource: field }))
                  }
                />
              </PermissionsCard>

              {/* Capabilities — grouped into Messaging / Inbox /
                  Content / Admin / LSQ so 13 toggles don't feel like a
                  wall. Each group is its own card so the operator can
                  collapse mentally + spot what they're changing. */}
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
                      defaultValue={Boolean(
                        rolePerms[key as keyof RolePermissions] as unknown as boolean,
                      )}
                      onChange={(field) =>
                        setDraft((d) => ({ ...d, [key]: field } as Draft))
                      }
                    />
                  ))}
                </PermissionsCard>
              ))}

              {/* Live effective preview */}
              {/* Per-number inbox visibility — finer than the LSQ
                  capability toggle. For each number this member can
                  access, pick whether they get every chat (Full) or
                  only the ones whose LSQ owner email is theirs (Only
                  assigned). Default falls back to the LSQ capability
                  above. */}
              <PermissionsCard
                title="Inbox visibility per number"
                subtitle={`Default (${
                  effective.lsq_assigned_visibility_only
                    ? "Only assigned"
                    : "Full access"
                }) comes from the LSQ capability above. Override here for specific numbers.`}
              >
                {(() => {
                  const allowed = effective.allowed_number_ids;
                  const visible =
                    allowed === null
                      ? numbers
                      : numbers.filter((n) =>
                          allowed.includes(n.phone_number_id),
                        );
                  if (visible.length === 0) {
                    return (
                      <div className="rounded-md border border-dashed bg-secondary/30 px-3 py-4 text-center text-xs text-muted-foreground">
                        This member has access to no numbers yet — set them above first.
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-1.5">
                      {visible.map((n) => {
                        const explicit = numberModesDraft[n.phone_number_id];
                        const effectiveMode: "full" | "assigned_only" =
                          explicit ??
                          (effective.lsq_assigned_visibility_only
                            ? "assigned_only"
                            : "full");
                        return (
                          <div
                            key={n.phone_number_id}
                            className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                          >
                            <div className="min-w-0 leading-tight">
                              <div className="truncate text-sm font-medium">
                                {n.verified_name ??
                                  n.display_phone_number ??
                                  n.phone_number_id}
                              </div>
                              {n.verified_name && n.display_phone_number ? (
                                <div className="text-[11px] text-muted-foreground">
                                  {n.display_phone_number}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-1">
                              <NumberModePill
                                active={effectiveMode === "full"}
                                explicit={explicit === "full"}
                                onClick={() =>
                                  setNumberModesDraft((m) => ({
                                    ...m,
                                    [n.phone_number_id]: "full",
                                  }))
                                }
                              >
                                Full
                              </NumberModePill>
                              <NumberModePill
                                active={effectiveMode === "assigned_only"}
                                explicit={explicit === "assigned_only"}
                                onClick={() =>
                                  setNumberModesDraft((m) => ({
                                    ...m,
                                    [n.phone_number_id]: "assigned_only",
                                  }))
                                }
                              >
                                Only assigned
                              </NumberModePill>
                              {explicit ? (
                                <button
                                  type="button"
                                  title="Use default (the LSQ capability above)"
                                  onClick={() =>
                                    setNumberModesDraft((m) => {
                                      const next = { ...m };
                                      delete next[n.phone_number_id];
                                      return next;
                                    })
                                  }
                                  className="ml-1 text-[10px] font-medium text-muted-foreground transition hover:text-foreground"
                                >
                                  reset
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </PermissionsCard>

              <PermissionsCard title="Effective access (preview)">
                <div className="grid gap-2 text-xs">
                  <Stat
                    icon={Phone}
                    label="WhatsApp numbers"
                    value={
                      effective.allowed_number_ids === null
                        ? "All numbers"
                        : effective.allowed_number_ids.length === 0
                          ? "None"
                          : `${effective.allowed_number_ids.length} numbers`
                    }
                  />
                  <Stat
                    icon={KeyRound}
                    label="Sidebar panels"
                    value={
                      effective.allowed_panels === null
                        ? "All panels"
                        : effective.allowed_panels.length === 0
                          ? "None"
                          : `${effective.allowed_panels.length} panels`
                    }
                  />
                  <Stat
                    icon={ShieldCheck}
                    label="Privacy"
                    value={[
                      effective.mask_phone_numbers ? "phones masked" : null,
                      effective.mask_emails ? "emails masked" : null,
                      effective.mask_source_subsource ? "source masked" : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "no masking"}
                  />
                  <Stat
                    icon={Sparkles}
                    label="Capabilities"
                    value={`${
                      CAPABILITY_KEYS.filter(
                        (k) => Boolean(effective[k as keyof typeof effective]),
                      ).length
                    } / ${CAPABILITY_KEYS.length} enabled`}
                  />
                </div>
              </PermissionsCard>

              {/* Login tracking — where this member is signed in, last
                  location, and a "Logout from all" action. Admin-only
                  view of someone else's sessions. */}
              {member ? (
                <SessionsCard scope="member" memberId={member.id} />
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        {!isOwner ? (
          <div className="flex items-center justify-between gap-2 border-t bg-card px-6 py-3">
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
        ) : null}
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// FieldShell — header for an "array" override (numbers / panels). Shows the
// inherit/customize toggle + helper text. The parent renders the editor body
// when mode === "custom".
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// BoolFieldRow — single toggle that can also sit in "inherit" mode.
// ---------------------------------------------------------------------------
function BoolFieldRow({
  label,
  description,
  field,
  defaultValue,
  onChange,
}: {
  label: string;
  description?: string;
  field: DraftField<boolean>;
  defaultValue: boolean;
  onChange: (next: DraftField<boolean>) => void;
}) {
  const effective = field.mode === "custom" ? field.value : defaultValue;
  const isInherit = field.mode === "inherit";
  return (
    <div className="flex items-start gap-3 border-b py-2.5 last:border-b-0">
      <Switch
        checked={effective}
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

// Two-segment pill for the per-number visibility row.
//   active   — reflects the EFFECTIVE mode (after fallback)
//   explicit — true when the operator has explicitly chosen this
//              value (so we differentiate "I picked Full" from
//              "Full because LSQ capability is off")
function NumberModePill({
  active,
  explicit,
  onClick,
  children,
}: {
  active: boolean;
  explicit: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold transition",
        active
          ? explicit
            ? "bg-primary text-primary-foreground shadow-sm"
            : "bg-primary/10 text-primary ring-1 ring-primary/20"
          : "bg-secondary text-muted-foreground hover:bg-secondary/80",
      )}
    >
      {children}
    </button>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className={cn("font-medium")}>{value}</span>
    </div>
  );
}
