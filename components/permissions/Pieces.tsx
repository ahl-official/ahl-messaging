"use client";

// Shared UI primitives for the Permissions screens — kept lightweight (no
// new ui/ shadcn dependencies). Reused by both the role defaults editor
// and the per-member access sheet.

import { useState } from "react";
import { Check, Globe, Search, type LucideIcon } from "lucide-react";
import {
  PANEL_KEYS,
  PANEL_LABEL,
  SETTINGS_TAB_KEYS,
  SETTINGS_TAB_LABEL,
  type PanelKey,
  type SettingsTabKey,
} from "@/lib/permission-types";
import { cn } from "@/lib/utils";

export interface BusinessNumberLite {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname?: string | null;
  provider?: string | null;
  // Portfolio (Meta tenant) this number belongs to, resolved server-side
  // from the env PHONE_IDS mapping in /api/team/permissions. This is the
  // accurate grouping key — the name-based fallback below mis-buckets a
  // number whose WhatsApp display name differs from its portfolio.
  portfolio?: string | null;
  // Joined from whatsapp_portfolios via the portfolio_id FK. Field name
  // matches the PostgREST nested-select key from /api/team/permissions.
  whatsapp_portfolios?: { name: string | null } | null;
}

// ---------------------------------------------------------------------------
// PermissionsCard — shell with header / body / sticky footer.
// ---------------------------------------------------------------------------
export function PermissionsCard({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b px-5 py-4">
        <h3 className="text-sm font-semibold leading-tight">{title}</h3>
        {subtitle ? (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      <div className="flex-1 px-5 py-5">{children}</div>
      {footer ? <div className="border-t bg-secondary/40 px-5 py-3">{footer}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section — labeled block inside a card.
// ---------------------------------------------------------------------------
export function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/8 text-primary ring-1 ring-primary/15">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div>
          <h4 className="text-sm font-medium leading-tight">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="ml-9">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ToggleRow — labeled switch row.
// ---------------------------------------------------------------------------
export function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-2.5 transition hover:bg-secondary/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Switch checked={value} onChange={onChange} disabled={disabled} />
      <span className="flex-1 leading-tight">
        <span className="block text-sm font-medium">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Switch — small accessible toggle.
// ---------------------------------------------------------------------------
export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
        checked ? "bg-primary" : "bg-muted",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-background shadow ring-1 ring-border transition",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// PanelGrid — checkbox grid for sidebar panels with "Allow all" toggle.
// value === null → unrestricted (all panels visible).
// ---------------------------------------------------------------------------
export function PanelGrid({
  value,
  onChange,
}: {
  value: PanelKey[] | null;
  onChange: (next: PanelKey[] | null) => void;
}) {
  const allowAll = value === null;
  const set = new Set(value ?? []);

  return (
    <div className="space-y-3">
      <AllowAllRow
        label="Allow access to all panels"
        helper="When off, only the panels you tick below are visible."
        value={allowAll}
        onChange={(v) => onChange(v ? null : (PANEL_KEYS as readonly PanelKey[]).slice())}
      />
      <div
        className={cn(
          "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 transition",
          allowAll && "pointer-events-none opacity-50",
        )}
      >
        {PANEL_KEYS.map((p) => {
          const on = set.has(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => {
                const next = new Set(set);
                if (on) next.delete(p);
                else next.add(p);
                onChange(Array.from(next) as PanelKey[]);
              }}
              className={cn(
                "flex items-center justify-between rounded-md border px-3 py-2 text-sm transition",
                on
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {PANEL_LABEL[p]}
              {on ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <span className="h-3.5 w-3.5" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsTabsGrid — same shape as PanelGrid but for Settings sub-tabs.
// ---------------------------------------------------------------------------
export function SettingsTabsGrid({
  value,
  onChange,
}: {
  value: SettingsTabKey[] | null;
  onChange: (next: SettingsTabKey[] | null) => void;
}) {
  const allowAll = value === null;
  const set = new Set(value ?? []);
  // "teams" is vestigial — team groups now live inside the "team" tab as
  // a sub-tab, and there's no standalone Teams nav entry. Hide it so the
  // grid only shows real, reachable settings tabs.
  const visibleTabs = (SETTINGS_TAB_KEYS as readonly SettingsTabKey[]).filter(
    (t) => t !== "teams",
  );

  return (
    <div className="space-y-3">
      <AllowAllRow
        label="Allow access to all settings tabs"
        helper="When off, only the tabs you tick below show under Settings."
        value={allowAll}
        onChange={(v) => onChange(v ? null : visibleTabs.slice())}
      />
      <div
        className={cn(
          "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 transition",
          allowAll && "pointer-events-none opacity-50",
        )}
      >
        {visibleTabs.map((t) => {
          const on = set.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => {
                const next = new Set(set);
                if (on) next.delete(t);
                else next.add(t);
                onChange(Array.from(next) as SettingsTabKey[]);
              }}
              className={cn(
                "flex items-center justify-between rounded-md border px-3 py-2 text-sm transition",
                on
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {SETTINGS_TAB_LABEL[t]}
              {on ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <span className="h-3.5 w-3.5" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NumbersGrid — same UX for WhatsApp business numbers.
// ---------------------------------------------------------------------------
export function NumbersGrid({
  numbers,
  value,
  onChange,
}: {
  numbers: BusinessNumberLite[];
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const allowAll = value === null;
  const set = new Set(value ?? []);
  const [numberQuery, setNumberQuery] = useState("");

  if (numbers.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-secondary/30 px-3 py-4 text-center text-xs text-muted-foreground">
        No WhatsApp numbers connected yet. Connect one in Settings → Numbers.
      </div>
    );
  }

  // Group numbers by their portfolio name so the admin sees Meta
  // tenants side-by-side instead of one long flat list. Numbers
  // without a portfolio (Evolution / legacy) bucket into a sensible
  // fallback group.
  function groupOf(n: BusinessNumberLite): string {
    // Accurate: the portfolio this number actually belongs to (env mapping).
    if (n.portfolio?.trim()) return n.portfolio.trim();
    if (n.whatsapp_portfolios?.name?.trim()) return n.whatsapp_portfolios.name.trim();
    if (n.provider === "evolution") return "Evolution";
    // Fallback — derive a group from the first word of the nickname or
    // verified_name (e.g. "QHT", "Sahil", "URoots") so Meta numbers
    // bucket sensibly even when portfolios aren't linked.
    const label = (n.nickname?.trim() || n.verified_name?.trim() || "").trim();
    if (label) {
      const first = label.split(/\s+/)[0];
      if (first) return first;
    }
    return "Other";
  }
  const groupOrder: string[] = [];
  const groupMap = new Map<string, BusinessNumberLite[]>();
  for (const n of numbers) {
    const g = groupOf(n);
    if (!groupMap.has(g)) {
      groupMap.set(g, []);
      groupOrder.push(g);
    }
    groupMap.get(g)!.push(n);
  }

  // Search across name / nickname / phone / id. Case-insensitive,
  // digits-only also matches phone numbers regardless of spaces/dashes
  // the operator may have typed.
  const q = numberQuery.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  function matches(n: BusinessNumberLite): boolean {
    if (!q) return true;
    const hay = [
      n.verified_name ?? "",
      n.nickname ?? "",
      n.display_phone_number ?? "",
      n.phone_number_id ?? "",
      n.whatsapp_portfolios?.name ?? "",
    ]
      .join(" ")
      .toLowerCase();
    if (hay.includes(q)) return true;
    if (qDigits.length >= 3) {
      const digits =
        (n.display_phone_number ?? "").replace(/\D/g, "") +
        " " +
        (n.phone_number_id ?? "").replace(/\D/g, "");
      if (digits.includes(qDigits)) return true;
    }
    return false;
  }

  return (
    <div className="space-y-3">
      <AllowAllRow
        label="Allow access to all WhatsApp numbers"
        helper="When off, only the numbers you tick below are visible."
        value={allowAll}
        onChange={(v) =>
          onChange(v ? null : numbers.map((n) => n.phone_number_id))
        }
      />
      <div
        className={cn(
          "space-y-3",
          allowAll && "pointer-events-none opacity-50",
        )}
      >
        {/* Search across name / nickname / phone */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={numberQuery}
            onChange={(e) => setNumberQuery(e.target.value)}
            placeholder="Search by name, nickname, or phone…"
            className="w-full rounded-md border bg-background pl-7 pr-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
        </div>

        {groupOrder.map((g) => {
          const all = groupMap.get(g)!;
          const visible = all.filter(matches);
          if (visible.length === 0) return null;
          const groupOn = visible.filter((n) => set.has(n.phone_number_id)).length;
          const allOn = groupOn === visible.length && visible.length > 0;
          return (
            <div key={g} className="rounded-md border bg-card">
              <div className="flex items-center justify-between gap-2 border-b bg-secondary/40 px-3 py-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  {g}{" "}
                  <span className="font-semibold normal-case text-foreground/70">
                    · {groupOn}/{visible.length} on
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(set);
                    if (allOn) {
                      // Toggle off — only the currently-visible (filtered) ones.
                      for (const n of visible) next.delete(n.phone_number_id);
                    } else {
                      for (const n of visible) next.add(n.phone_number_id);
                    }
                    onChange(Array.from(next));
                  }}
                  className="rounded-md border bg-background px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  {allOn ? "Untick all" : "Tick all"}
                </button>
              </div>
              <div className="grid gap-2 p-2 sm:grid-cols-2">
                {visible.map((n) => {
                  const on = set.has(n.phone_number_id);
                  return (
                    <button
                      key={n.phone_number_id}
                      type="button"
                      onClick={() => {
                        const next = new Set(set);
                        if (on) next.delete(n.phone_number_id);
                        else next.add(n.phone_number_id);
                        onChange(Array.from(next));
                      }}
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm transition",
                        on
                          ? "border-primary bg-primary/5"
                          : "border-border bg-background hover:bg-secondary",
                      )}
                    >
                      <span className="leading-tight">
                        <span className="block font-medium">
                          {n.nickname?.trim() ||
                            n.verified_name ||
                            n.display_phone_number ||
                            n.phone_number_id}
                        </span>
                        {n.display_phone_number ? (
                          <span className="block text-[11px] text-muted-foreground">
                            {n.display_phone_number}
                          </span>
                        ) : null}
                      </span>
                      {on ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : (
                        <span className="h-4 w-4" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {q && groupOrder.every((g) => groupMap.get(g)!.filter(matches).length === 0) ? (
          <div className="rounded-md border border-dashed bg-secondary/30 px-3 py-4 text-center text-xs text-muted-foreground">
            No numbers match &ldquo;{numberQuery}&rdquo;.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AllowAllRow({
  label,
  helper,
  value,
  onChange,
}: {
  label: string;
  helper?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-md border bg-secondary/30 px-3 py-2.5">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1 leading-tight">
        <span className="block text-sm font-medium">{label}</span>
        {helper ? (
          <span className="block text-[11px] text-muted-foreground">{helper}</span>
        ) : null}
      </span>
      <Switch checked={value} onChange={onChange} />
    </label>
  );
}
