"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageLoader } from "@/components/PageLoader";
import {
  Bell,
  Building2,
  ChevronDown,
  Loader2,
  LogOut,
  Radio,
  Search,
  Settings as SettingsIcon,
  User as UserIcon,
} from "lucide-react";
import { signOutAction } from "@/app/(auth)/login/actions";
import { cn } from "@/lib/utils";
import { ROLE_LABEL, type Role } from "@/lib/team-types";
import { usePermissions } from "@/components/PermissionsContext";
import { NotificationControls } from "@/components/NotificationsMenu";

interface Props {
  email: string;
  fullName?: string | null;
  role?: Role | null;
  isDemo?: boolean;
}

interface NumberRow {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  memo: string | null;
  is_active: boolean;
  provider?: "meta" | "evolution" | null;
  portfolio: { key: string; name: string } | null;
}

const EVOLUTION_KEY = "__evolution__";

const ROLE_PILL_CLASS: Record<Role, string> = {
  owner:      "bg-amber-100 text-amber-900 ring-amber-200",
  superadmin: "bg-purple-100 text-purple-900 ring-purple-200",
  admin:      "bg-brand-50 text-brand-700 ring-brand-100",
  teammate:   "bg-secondary text-muted-foreground ring-border",
};

// Stable hashed gradient per initials so the same user always gets the
// same avatar colour across pages — same approach used in Home/Inbox.
const AVATAR_GRADIENTS = [
  "from-emerald-500 to-teal-600",
  "from-violet-500 to-purple-600",
  "from-sky-500 to-blue-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-teal-500 to-cyan-600",
];

function avatarGradient(seed: string): string {
  const sum = seed.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[Math.abs(sum) % AVATAR_GRADIENTS.length];
}

function initialsOf(emailOrName: string): string {
  const parts = emailOrName.replace(/@.*$/, "").replace(/[._]/g, " ").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return emailOrName.slice(0, 2).toUpperCase();
}

export function UserMenu({ email, fullName, role, isDemo }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const canSeeSettings = role === "owner" || role === "superadmin" || role === "admin";

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const display = fullName?.trim() || email;
  const initials = initialsOf(display);
  const gradient = avatarGradient(display);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex items-center gap-2 rounded-full pl-1 pr-2.5 py-1 transition ring-1 ring-inset",
          open
            ? "bg-emerald-50 ring-emerald-200"
            : "bg-card ring-border hover:bg-secondary hover:ring-emerald-200",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="relative inline-flex">
          <span
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-md ring-2 ring-white",
              gradient,
            )}
          >
            {initials}
          </span>
          {/* Online dot */}
          <span className="absolute -bottom-0.5 -right-0.5 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-card" />
        </span>
        {role ? (
          <span
            className={cn(
              "hidden md:inline rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset",
              ROLE_PILL_CLASS[role],
            )}
          >
            {ROLE_LABEL[role]}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full z-[60] mt-2 flex h-[calc(100vh-4.5rem)] w-80 flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-emerald-900/10 ring-1 ring-emerald-100/60",
            "animate-in fade-in-0 zoom-in-95",
          )}
        >
          {/* Profile header — emerald wash + gradient avatar. */}
          <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-emerald-50 via-card to-card p-4">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-emerald-200/40 blur-2xl"
            />
            <div className="relative flex items-center gap-3">
              <span
                className={cn(
                  "inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br text-base font-bold text-white shadow-lg shadow-emerald-900/20 ring-2 ring-white",
                  gradient,
                )}
              >
                {initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold leading-tight">
                  {display}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="relative inline-flex">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="absolute inset-0 inline-block h-1.5 w-1.5 animate-ping rounded-full bg-emerald-500/60" />
                  </span>
                  <span className="text-[11px] font-medium text-emerald-700">
                    Online
                  </span>
                  {role ? (
                    <span
                      className={cn(
                        "ml-1 inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset",
                        ROLE_PILL_CLASS[role],
                      )}
                    >
                      {ROLE_LABEL[role]}
                    </span>
                  ) : null}
                </div>
                {fullName ? (
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">
                    {email}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Connected numbers — fills the dropdown so as many numbers
              as possible are visible. Personal per-operator toggle. */}
          <NumbersBlock canToggle open={open} />

          {/* Actions */}
          <div className="shrink-0 border-t p-2">
            <NotificationsRow />

            {canSeeSettings ? (
              <Link
                href="/settings/team"
                onClick={() => setOpen(false)}
                className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition hover:bg-emerald-50 hover:text-emerald-800"
              >
                <SettingsIcon className="h-4 w-4 text-muted-foreground group-hover:text-emerald-700" />
                Workspace settings
              </Link>
            ) : null}
            {!isDemo ? (
              <Link
                href="/profile"
                onClick={() => setOpen(false)}
                className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition hover:bg-emerald-50 hover:text-emerald-800"
              >
                <UserIcon className="h-4 w-4 text-muted-foreground group-hover:text-emerald-700" />
                Profile settings
              </Link>
            ) : null}
            {isDemo ? (
              <button
                type="button"
                disabled
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-muted-foreground cursor-not-allowed"
                title="Disabled in demo mode"
              >
                <LogOut className="h-4 w-4" />
                Logout
                <span className="ml-auto text-[10px] uppercase text-muted-foreground">demo</span>
              </button>
            ) : (
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-rose-600 transition hover:bg-rose-50"
                >
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumbersBlock({ canToggle, open }: { canToggle: boolean; open: boolean }) {
  const router = useRouter();
  const perms = usePermissions();
  const [numbers, setNumbers] = useState<NumberRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Page-level loader. Stays visible from the PUT going out until the
  // contact list has refetched (it listens for `business-numbers-changed`).
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/business-numbers", { cache: "no-store" });
      const json = (await res.json()) as { numbers?: NumberRow[] };
      // Permission gate — only surface numbers this user may access.
      const all = json.numbers ?? [];
      const allowed = perms.allowed_number_ids;
      setNumbers(
        allowed === null
          ? all
          : all.filter((n) => allowed.includes(n.phone_number_id)),
      );
    } catch {
      setNumbers([]);
    }
  }

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Flip a set of numbers to `target` in one atomic request. The bulk
  // endpoint does a single read-modify-write of hidden_number_ids — the
  // old per-row parallel PUTs clobbered each other (the "Enable all
  // doesn't work" bug).
  async function setActive(ids: string[], target: boolean) {
    if (!canToggle || busy || !numbers) return;
    const affected = ids.filter((id) => {
      const n = numbers.find((x) => x.phone_number_id === id);
      return n && n.is_active !== target;
    });
    if (affected.length === 0) return;
    const affectedSet = new Set(affected);
    setBusy(true);
    setRefreshing(true);
    // Hard 1.5 s ceiling on the overlay. The loader exists to mask the
    // brief window between PUT-success and the contact list refetching;
    // we don't need to babysit the fetch beyond that. If the PUT hangs
    // the optimistic UI rollback below (or the next reload) handles it
    // — keeping the loader stuck just made the dashboard feel broken.
    const ceiling = setTimeout(() => setRefreshing(false), 1_500);
    setNumbers((prev) =>
      prev?.map((x) =>
        affectedSet.has(x.phone_number_id) ? { ...x, is_active: target } : x,
      ) ?? prev,
    );
    try {
      const res = await fetch("/api/business-numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_ids: affected, is_active: target }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
      window.dispatchEvent(new CustomEvent("business-numbers-changed"));
    } catch {
      setNumbers((prev) =>
        prev?.map((x) =>
          affectedSet.has(x.phone_number_id)
            ? { ...x, is_active: !target }
            : x,
        ) ?? prev,
      );
    } finally {
      setBusy(false);
      // Whether the PUT succeeded, failed, or is still pending — clear
      // the overlay state now. The ceiling above is the belt-and-braces
      // fallback if React hasn't run the effect yet.
      clearTimeout(ceiling);
      setRefreshing(false);
    }
  }

  // Search across nickname / verified name / number / memo.
  const filtered = useMemo(() => {
    const list = numbers ?? [];
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter((n) =>
      `${n.nickname ?? ""} ${n.verified_name ?? ""} ${
        n.display_phone_number ?? ""
      } ${n.phone_number_id} ${n.memo ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  }, [numbers, q]);

  // Group by portfolio; every Evolution (Baileys) number collapses
  // into one group regardless of portfolio. Evolution group sorts last.
  const grouped = useMemo(() => {
    const groups = new Map<string, { name: string; rows: NumberRow[] }>();
    for (const n of filtered) {
      const isEvo = n.provider === "evolution";
      const key = isEvo ? EVOLUTION_KEY : n.portfolio?.key ?? "__unassigned__";
      const name = isEvo
        ? "Evolution (Baileys)"
        : n.portfolio?.name ?? "Unassigned";
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key)!.rows.push(n);
    }
    return Array.from(groups.entries()).sort(([a], [b]) =>
      a === EVOLUTION_KEY ? 1 : b === EVOLUTION_KEY ? -1 : 0,
    );
  }, [filtered]);

  const total = filtered.length;
  const onCount = filtered.filter((n) => n.is_active).length;
  const allOn = total > 0 && onCount === total;
  const allOff = onCount === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b">
      {refreshing ? <PageLoader label="Updating inbox" /> : null}

      {/* Section header + master toggle */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connected numbers
        </div>
        {canToggle && total > 0 ? (
          <button
            type="button"
            onClick={() =>
              setActive(
                filtered.map((n) => n.phone_number_id),
                !allOn,
              )
            }
            disabled={busy}
            title={allOn ? "Turn off every number" : "Turn on every number"}
            className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold transition hover:bg-secondary disabled:opacity-50"
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                allOn ? "bg-emerald-500" : allOff ? "bg-rose-500" : "bg-amber-500",
              )}
            />
            {allOn ? "All on" : allOff ? "All off" : `${onCount}/${total} on`}
            <span className="text-muted-foreground">·</span>
            <span className="text-emerald-700">
              {allOn ? "Disable all" : "Enable all"}
            </span>
          </button>
        ) : null}
      </div>

      {/* Search */}
      {numbers && numbers.length > 0 ? (
        <div className="relative shrink-0 px-4 pt-2">
          <Search className="pointer-events-none absolute left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, nickname or number"
            className="w-full rounded-lg border bg-background py-1.5 pl-7 pr-2 text-[12px] outline-none focus:ring-2 focus:ring-emerald-200"
          />
        </div>
      ) : null}

      {/* List */}
      {numbers === null ? (
        <div className="grid h-16 place-items-center text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </div>
      ) : numbers.length === 0 ? (
        <div className="mx-4 mt-2 rounded-md border border-dashed bg-secondary/40 px-2.5 py-2 text-[11px] text-muted-foreground">
          No numbers connected yet.
        </div>
      ) : total === 0 ? (
        <div className="mx-4 mt-2 rounded-md border border-dashed bg-secondary/40 px-2.5 py-2 text-[11px] text-muted-foreground">
          No numbers match “{q.trim()}”.
        </div>
      ) : (
        <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-3">
          {grouped.map(([key, group]) => {
            const groupOn = group.rows.every((r) => r.is_active);
            const groupOnCount = group.rows.filter((r) => r.is_active).length;
            const isEvo = key === EVOLUTION_KEY;
            return (
              <div key={key}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {isEvo ? (
                      <Radio className="h-3 w-3 text-violet-500" />
                    ) : (
                      <Building2 className="h-3 w-3" />
                    )}
                    <span className="truncate">{group.name}</span>
                    <span className="text-muted-foreground/60">
                      {groupOnCount}/{group.rows.length}
                    </span>
                  </div>
                  {canToggle ? (
                    <Toggle
                      on={groupOn}
                      disabled={busy}
                      onClick={() =>
                        setActive(
                          group.rows.map((r) => r.phone_number_id),
                          !groupOn,
                        )
                      }
                    />
                  ) : null}
                </div>
                <div className="space-y-1">
                  {group.rows.map((n) => {
                    const label =
                      n.nickname?.trim() ||
                      n.verified_name?.trim() ||
                      n.display_phone_number ||
                      n.phone_number_id;
                    return (
                      <div
                        key={n.phone_number_id}
                        className={cn(
                          "flex items-center justify-between rounded-md bg-secondary/60 px-2.5 py-1.5",
                          !n.is_active && "opacity-60",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium">
                            {label}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {n.display_phone_number ?? "—"}
                          </div>
                          {n.memo?.trim() ? (
                            <div className="mt-0.5 truncate text-[10px] italic text-amber-700">
                              {n.memo}
                            </div>
                          ) : null}
                        </div>
                        <Toggle
                          on={n.is_active}
                          disabled={!canToggle || busy}
                          onClick={() =>
                            setActive([n.phone_number_id], !n.is_active)
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Toggle({
  on,
  disabled,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition",
        on ? "bg-emerald-500" : "bg-muted-foreground/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cn(
          "inline-block h-3 w-3 transform rounded-full bg-white shadow transition",
          on ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// Collapsible Notifications row — matches the look of Workspace settings /
// Profile settings. Closed by default; click to expand the controls
// (sound toggle + desktop notifications) inline.
function NotificationsRow() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition hover:bg-emerald-50 hover:text-emerald-800"
        aria-expanded={open}
      >
        <Bell className="h-4 w-4 text-muted-foreground group-hover:text-emerald-700" />
        <span className="flex-1">Notifications</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="px-1.5 pb-2">
          <NotificationControls />
        </div>
      ) : null}
    </div>
  );
}
