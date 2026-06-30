"use client";

// Settings → Numbers. One row per WhatsApp business number with editable
// nickname (e.g. "URoots Support Care"), portfolio badge, and quick
// links to AI auto-reply config.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Building2,
  Search,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FolderPlus,
  ImagePlus,
  KeyRound,
  Loader2,
  MapPin,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getBulkTaskSnapshot,
  startBulkStatus,
  stopBulkStatus,
  subscribeBulkTask,
  type BulkTaskState,
} from "@/lib/bulk-status-task";
import { ConnectWhatsAppButton } from "@/components/settings/ConnectWhatsAppButton";
import { useMembers } from "@/components/MembersContext";

interface NumberRow {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  /** Free-form operator memory note — "what is this number for".
   *  Separate from nickname (which is the primary display label).
   *  Shown as a subtitle/chip; never replaces the main name. */
  memo: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  portfolio: { key: string; name: string } | null;
  /** Whether the number still exists on Meta's WhatsApp Business API.
   *  'unknown' until the operator runs a Meta status check. */
  meta_status: "connected" | "removed" | "unknown";
  meta_checked_at: string | null;
  /** The WABA this number belongs to. Templates are WABA-scoped, so when
   *  set this overrides the portfolio-level business_account_id. */
  waba_id: string | null;
  /** 'meta' (Cloud API, default) or 'evolution' (Baileys / unofficial). */
  provider?: "meta" | "evolution";
  /** Evolution instance identifier — null on Meta rows. Used by the
   *  delete + reconnect routes. */
  evolution_instance_name?: string | null;
  /** Last known Evolution connection state. Drives the EvolutionStateBadge. */
  evolution_connection_state?: "open" | "connecting" | "close" | null;
  evolution_jid?: string | null;
  /** WhatsApp profile picture URL cached from Evolution. Short-TTL
   *  Meta CDN link; refreshed silently when the row mounts. */
  profile_pic_url?: string | null;
  /** Operator-defined cluster for Evolution numbers (Delhi / Noida /
   *  Haridwar clinic …). null = "Ungrouped". */
  evolution_group_id?: string | null;
}

interface EvolutionGroup {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
  number_count: number;
}

interface PortfolioOption {
  key: string;
  name: string;
  is_active: boolean;
}

export function NumbersView({ canEdit }: { canEdit: boolean }) {
  const [numbers, setNumbers] = useState<NumberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [connectingEvolution, setConnectingEvolution] = useState(false);
  /** Free-text search across number / verified name / nickname / memo. */
  const [query, setQuery] = useState("");
  /** Filter strip: "all" | "official" (Meta only) | "unofficial" (Evolution only). */
  const [providerFilter, setProviderFilter] = useState<
    "all" | "official" | "unofficial"
  >("all");
  /** Bulk status modal — open when operator wants to post the same
   *  status to several Evolution numbers in one shot. */
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  /** Operator-defined clusters for Evolution numbers (Delhi / Noida …). */
  const [evolutionGroups, setEvolutionGroups] = useState<EvolutionGroup[]>([]);
  /** Group filter within the "Unofficial" tab — "all", "ungrouped", or a group id. */
  const [evolutionGroupFilter, setEvolutionGroupFilter] = useState<string>("all");
  /** Manage-groups drawer/modal toggle. */
  const [managingGroups, setManagingGroups] = useState(false);
  /** Per-bpid contact + message counts. `evolution` is the parallel
   *  count straight from Evolution's own DB (only present for Evolution
   *  instances, null otherwise) so the operator can spot a stalled
   *  backfill at a glance. null = first fetch hasn't returned yet. */
  const [perNumberStats, setPerNumberStats] = useState<
    Record<
      string,
      {
        contacts: number;
        messages: number;
        evolution: { contacts: number; messages: number } | null;
      }
    > | null
  >(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/business-numbers", { cache: "no-store" });
      const json = (await res.json()) as { numbers?: NumberRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNumbers(json.numbers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  // Stats live alongside the numbers — separate fetch so a slow count
  // doesn't block the cards from rendering. Refetched whenever numbers
  // change so adding/removing one updates the totals.
  async function loadStats() {
    try {
      const res = await fetch("/api/business-numbers/stats", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as {
        stats?: Array<{
          bpid: string;
          contacts: number;
          messages: number;
          evolution: { contacts: number; messages: number } | null;
        }>;
      };
      const map: Record<
        string,
        {
          contacts: number;
          messages: number;
          evolution: { contacts: number; messages: number } | null;
        }
      > = {};
      for (const r of j.stats ?? []) {
        map[r.bpid] = {
          contacts: r.contacts,
          messages: r.messages,
          evolution: r.evolution,
        };
      }
      setPerNumberStats(map);
    } catch {
      /* best-effort — chips just won't render */
    }
  }

  async function loadEvolutionGroups() {
    try {
      const res = await fetch("/api/evolution-groups", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { groups?: EvolutionGroup[] };
      setEvolutionGroups(j.groups ?? []);
    } catch {
      /* best-effort */
    }
  }

  // Force Evolution's reported state into our `evolution_connection_state`
  // column. We do it once on mount + whenever the workspace numbers
  // changed event fires (e.g. operator just connected one) so the
  // status badge can't lag behind reality. The endpoint is a fire-and-
  // forget refresh; the badge updates via `load()` after.
  async function refreshConnectionStates() {
    try {
      const res = await fetch("/api/evolution/refresh-states", {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) return;
      const j = (await res.json()) as { changed?: number };
      // Only re-pull the numbers list if at least one state actually
      // changed — avoids a wasteful round-trip on the common no-op
      // case where everything was already in sync.
      if ((j.changed ?? 0) > 0) await load();
    } catch {
      /* best-effort — the badge will catch up on next webhook tick */
    }
  }

  useEffect(() => {
    load();
    loadStats();
    void loadEvolutionGroups();
    void refreshConnectionStates();
    const onChanged = () => void refreshConnectionStates();
    window.addEventListener("business-numbers-changed", onChanged);
    return () => window.removeEventListener("business-numbers-changed", onChanged);
  }, []);

  const stats = useMemo(() => {
    const list = numbers ?? [];
    // Evolution numbers don't belong to portfolios — they aren't
    // counted as "unassigned". Only Meta numbers participate in the
    // portfolio assignment flow.
    const metaOnly = list.filter((n) => n.provider !== "evolution");
    const evolution = list.filter((n) => n.provider === "evolution");
    return {
      total: list.length,
      official: metaOnly.length,
      unofficial: evolution.length,
      assigned: metaOnly.filter((n) => n.portfolio).length,
      unassigned: metaOnly.filter((n) => !n.portfolio).length,
    };
  }, [numbers]);

  /** Apply the provider filter strip to the rendered list, and the
   *  group filter within the unofficial tab. */
  const visibleNumbers = useMemo(() => {
    const list = numbers ?? [];
    let filtered: NumberRow[];
    if (providerFilter === "official") {
      filtered = list.filter((n) => n.provider !== "evolution");
    } else if (providerFilter === "unofficial") {
      const evo = list.filter((n) => n.provider === "evolution");
      if (evolutionGroupFilter === "all") filtered = evo;
      else if (evolutionGroupFilter === "ungrouped")
        filtered = evo.filter((n) => !n.evolution_group_id);
      else filtered = evo.filter((n) => n.evolution_group_id === evolutionGroupFilter);
    } else {
      filtered = list;
    }
    // Free-text search — name / nickname / memo (substring) or the phone
    // number / id (digits-only, ignoring spaces & dashes).
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    const qDigits = q.replace(/\D/g, "");
    return filtered.filter((n) => {
      const hay = [n.verified_name, n.nickname, n.memo, n.display_phone_number]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (hay.includes(q)) return true;
      if (qDigits) {
        const numDigits = `${n.display_phone_number ?? ""}${n.phone_number_id ?? ""}`.replace(
          /\D/g,
          "",
        );
        if (numDigits.includes(qDigits)) return true;
      }
      return false;
    });
  }, [numbers, providerFilter, evolutionGroupFilter, query]);

  const unofficialNumbers = useMemo(
    () => (numbers ?? []).filter((n) => n.provider === "evolution"),
    [numbers],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Page sub-header — sits below the global Settings hero. Uses
          light card style with stats chips so it doesn't compete with
          the gradient above. */}
      <div className="border-b bg-card">
        {/* Compact single-row header: title · search · stats · actions.
            Description dropped + paddings tightened to reclaim vertical
            space; the row wraps gracefully on narrow viewports. */}
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <Phone className="h-4 w-4" />
          </span>
          <h2 className="shrink-0 text-sm font-semibold leading-tight">
            WhatsApp numbers
          </h2>

          {/* Search — name or number. Grows to fill the row. */}
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or number…"
              className="h-8 w-full rounded-lg border bg-background pl-8 pr-3 text-xs outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200"
            />
          </div>

          {/* Stats — compact inline chips */}
          {numbers && numbers.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <SubHeroChip label="Total" value={stats.total} />
              <SubHeroChip label="Assigned" value={stats.assigned} accent="emerald" />
              {stats.unassigned > 0 ? (
                <SubHeroChip label="Unassigned" value={stats.unassigned} accent="amber" />
              ) : null}
              {perNumberStats
                ? (() => {
                    const totals = Object.values(perNumberStats).reduce(
                      (a, b) => ({
                        contacts: a.contacts + b.contacts,
                        messages: a.messages + b.messages,
                      }),
                      { contacts: 0, messages: 0 },
                    );
                    return (
                      <>
                        <SubHeroChip label="Contacts" value={totals.contacts} accent="sky" />
                        <SubHeroChip label="Messages" value={totals.messages} accent="violet" />
                      </>
                    );
                  })()
                : null}
            </div>
          ) : null}

          {/* Actions */}
          {canEdit ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <RefreshMetaPicsButton onDone={load} />
              {(numbers ?? []).some((n) => n.provider === "evolution") ? (
                <>
                  <RepairEvolutionWebhooksButton
                    onDone={() => void refreshConnectionStates()}
                  />
                  <SyncAllUnofficialButton
                    instances={(numbers ?? [])
                      .filter(
                        (n): n is NumberRow & { evolution_instance_name: string } =>
                          n.provider === "evolution" &&
                          Boolean(n.evolution_instance_name),
                      )
                      .map((n) => n.evolution_instance_name)}
                    onDone={() => loadStats()}
                  />
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setConnectingEvolution(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50"
                title="Scan a QR code to connect an unofficial WhatsApp number via Evolution API"
              >
                <Plus className="h-3.5 w-3.5" />
                Connect via QR
              </button>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Meta number
              </button>
              {/* Renders only when Embedded Signup env is configured. */}
              <ConnectWhatsAppButton onConnected={load} />
            </div>
          ) : null}
        </div>
      </div>

      {adding ? (
        <AddNumberModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      ) : null}

      {connectingEvolution ? (
        <EvolutionConnectModal
          onClose={() => setConnectingEvolution(false)}
          onConnected={() => {
            setConnectingEvolution(false);
            load();
          }}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-3">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {/* Filter strip — All / Official (Meta) / Unofficial (Evolution).
              Bulk "Post Status" only renders for the unofficial tab since
              Meta numbers don't expose the Status surface. */}
          {numbers && numbers.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm">
                {(
                  [
                    { key: "all", label: `All · ${stats.total}` },
                    { key: "official", label: `Official · ${stats.official}` },
                    {
                      key: "unofficial",
                      label: `Unofficial · ${stats.unofficial}`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setProviderFilter(tab.key)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-semibold transition",
                      providerFilter === tab.key
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {canEdit &&
              providerFilter === "unofficial" &&
              unofficialNumbers.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setBulkStatusOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50"
                  title="Post the same WhatsApp Status to multiple unofficial numbers at once"
                >
                  <CircleDot className="h-3.5 w-3.5" />
                  Bulk post status
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Evolution group strip — only on the Unofficial tab. Lets the
              operator slice numbers by city / clinic and open the manager. */}
          {providerFilter === "unofficial" && unofficialNumbers.length > 0 ? (
            <EvolutionGroupFilterStrip
              groups={evolutionGroups}
              numbers={unofficialNumbers}
              active={evolutionGroupFilter}
              onChange={setEvolutionGroupFilter}
              canEdit={canEdit}
              onManage={() => setManagingGroups(true)}
            />
          ) : null}

          {numbers === null ? (
            <SkeletonState />
          ) : numbers.length === 0 ? (
            <EmptyState />
          ) : visibleNumbers.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              {query.trim()
                ? `No numbers match "${query.trim()}".`
                : `No ${providerFilter} numbers yet.`}
            </div>
          ) : (
            <>
              {providerFilter === "unofficial" && unofficialNumbers.length > 0 ? (
                <RecentStatusesAcrossNumbers />
              ) : null}
              {visibleNumbers.map((n) => (
                <NumberRowCard
                  key={n.phone_number_id}
                  number={n}
                  canEdit={canEdit}
                  onUpdated={() => {
                    load();
                    void loadEvolutionGroups();
                  }}
                  stats={perNumberStats?.[n.phone_number_id] ?? null}
                  evolutionGroups={evolutionGroups}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {bulkStatusOpen ? (
        <BulkPostStatusModal
          numbers={unofficialNumbers}
          onClose={() => setBulkStatusOpen(false)}
        />
      ) : null}

      {managingGroups ? (
        <EvolutionGroupsManagerModal
          groups={evolutionGroups}
          onClose={() => setManagingGroups(false)}
          onChanged={() => {
            void loadEvolutionGroups();
            load();
          }}
        />
      ) : null}
    </div>
  );
}

// Compact "scope: N contacts · M messages" chip used on each number
// card. Single horizontal pill — labels are abbreviated so two chips
// (Local + Evolution) sit side-by-side without forcing a wrap on a
// typical card width.
function StatsPill({
  scope,
  contacts,
  messages,
  tone,
  hint,
}: {
  scope: string;
  contacts: number;
  messages: number;
  tone: "sky" | "amber" | "emerald";
  hint?: string;
}) {
  const palette =
    tone === "sky"
      ? "bg-sky-50 text-sky-800 ring-sky-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-800 ring-amber-200"
        : "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        palette,
      )}
      title={hint}
    >
      <span className="font-bold uppercase tracking-wide opacity-60">
        {scope}
      </span>
      <span className="tabular-nums">{contacts.toLocaleString("en-IN")}</span>
      <span className="font-normal opacity-70">chats</span>
      <span className="opacity-40">·</span>
      <span className="tabular-nums">{messages.toLocaleString("en-IN")}</span>
      <span className="font-normal opacity-70">msgs</span>
    </span>
  );
}

function SubHeroChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "emerald" | "amber" | "sky" | "violet";
}) {
  const palette =
    accent === "emerald"
      ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
      : accent === "amber"
        ? "bg-amber-50 text-amber-800 ring-amber-200"
        : accent === "sky"
          ? "bg-sky-50 text-sky-800 ring-sky-200"
          : accent === "violet"
            ? "bg-violet-50 text-violet-800 ring-violet-200"
            : "bg-secondary text-foreground ring-border";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset", palette)}>
      <span className="tabular-nums">{value.toLocaleString("en-IN")}</span>
      <span className="font-normal opacity-70">{label}</span>
    </span>
  );
}

type ActionChipTone = "violet" | "indigo" | "emerald" | "emeraldStrong" | "amber";

function ActionChip({
  onClick,
  href,
  icon: Icon,
  iconClassName,
  tone,
  active,
  disabled,
  title,
  children,
}: {
  onClick?: () => void;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  tone: ActionChipTone;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const palettes: Record<ActionChipTone, { idle: string; active: string }> = {
    violet: {
      idle: "border-violet-200 bg-white text-violet-800 hover:bg-violet-50",
      active: "border-violet-400 bg-violet-100 text-violet-900",
    },
    indigo: {
      idle: "border-indigo-200 bg-white text-indigo-800 hover:bg-indigo-50",
      active: "border-indigo-400 bg-indigo-100 text-indigo-900",
    },
    emerald: {
      idle: "border-emerald-200 bg-white text-emerald-800 hover:bg-emerald-50",
      active: "border-emerald-400 bg-emerald-100 text-emerald-900",
    },
    emeraldStrong: {
      idle: "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700",
      active: "border-emerald-500 bg-emerald-600 text-white",
    },
    amber: {
      idle: "border-amber-200 bg-white text-amber-800 hover:bg-amber-50",
      active: "border-amber-400 bg-amber-100 text-amber-900",
    },
  };
  const p = palettes[tone];
  const className = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition disabled:opacity-50",
    active ? p.active : p.idle,
  );
  if (href) {
    return (
      <Link href={href} className={className} title={title}>
        <Icon className={cn("h-3.5 w-3.5", iconClassName)} />
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={className}>
      <Icon className={cn("h-3 w-3", iconClassName)} />
      {children}
    </button>
  );
}

function NumberRowCard({
  number,
  canEdit,
  onUpdated,
  stats,
  evolutionGroups,
}: {
  number: NumberRow;
  canEdit: boolean;
  onUpdated: () => void;
  stats?: {
    contacts: number;
    messages: number;
    evolution: { contacts: number; messages: number } | null;
  } | null;
  evolutionGroups?: EvolutionGroup[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(number.nickname ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showWebhooks, setShowWebhooks] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [showDanger, setShowDanger] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showCallSettings, setShowCallSettings] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const displayName =
    number.nickname?.trim() ||
    number.verified_name?.trim() ||
    number.display_phone_number ||
    number.phone_number_id;
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "?";

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/business-numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: number.phone_number_id,
          nickname: draft.trim(),
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEditing(false);
      setSavedAt(Date.now());
      onUpdated();
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300/60 hover:shadow-lg hover:shadow-emerald-900/5">
      {/* Gradient accent bar on top — assigned = emerald, unassigned = amber */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-1",
          number.portfolio
            ? "bg-gradient-to-r from-emerald-400 via-emerald-500 to-teal-500"
            : "bg-gradient-to-r from-amber-400 to-amber-500",
        )}
      />
      {/* Soft decorative blob in the top-right corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-gradient-to-br from-emerald-100/40 to-transparent blur-2xl"
      />

      {/* Top section — identity + portfolio */}
      <div className="relative flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex min-w-0 items-start gap-3.5">
          <NumberAvatar number={number} initials={initials} />


          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={number.verified_name ?? "Nickname"}
                  maxLength={80}
                  autoFocus
                  disabled={saving}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                    if (e.key === "Escape") {
                      setEditing(false);
                      setDraft(number.nickname ?? "");
                    }
                  }}
                  className="min-w-[180px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(number.nickname ?? "");
                    setErr(null);
                  }}
                  disabled={saving}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
                  aria-label="Cancel"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-base font-semibold tracking-tight">{displayName}</span>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(true);
                      setDraft(number.nickname ?? "");
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 transition hover:bg-emerald-100"
                  >
                    <Edit3 className="h-2.5 w-2.5" />
                    Rename
                  </button>
                ) : null}
                {savedAt ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    <Check className="h-2.5 w-2.5" />
                    Saved
                  </span>
                ) : null}
              </div>
            )}
            {number.nickname && number.verified_name && number.nickname !== number.verified_name ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Meta verified: <span className="font-medium">{number.verified_name}</span>
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary/60 px-2 py-1 font-mono text-[11px] font-semibold text-foreground/85 ring-1 ring-inset ring-border">
                <Phone className="h-3 w-3 text-emerald-600" />
                {formatPhone(number.display_phone_number) || number.phone_number_id}
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                <span className="opacity-60">ID</span>
                {number.phone_number_id}
              </span>
              {stats ? (
                <StatsPill
                  scope="Local"
                  contacts={stats.contacts}
                  messages={stats.messages}
                  tone="sky"
                  hint="Contacts and messages stored locally for this number."
                />
              ) : null}
              {stats?.evolution ? (
                (() => {
                  const behind =
                    stats.evolution.messages > stats.messages ||
                    stats.evolution.contacts > stats.contacts;
                  return (
                    <StatsPill
                      scope="Evolution"
                      contacts={stats.evolution.contacts}
                      messages={stats.evolution.messages}
                      tone={behind ? "amber" : "emerald"}
                      hint={
                        behind
                          ? "Evolution has more data than the local inbox — run Sync history to backfill."
                          : "Local copy matches Evolution."
                      }
                    />
                  );
                })()
              ) : null}
            </div>
            <MemoEditor number={number} canEdit={canEdit} onUpdated={onUpdated} />
            <WabaIdEditor number={number} canEdit={canEdit} onUpdated={onUpdated} />
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {number.provider === "evolution" ? (
            // Evolution numbers don't belong to portfolios — show a
            // dedicated "Unofficial" chip so the operator knows this
            // is a Baileys/QR-scanned number rather than a Meta one.
            <span
              className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-200"
              title="Connected via Evolution API (QR-scan). Not subject to Meta approval."
            >
              <Phone className="h-3 w-3" />
              Unofficial
            </span>
          ) : null}
          {number.provider === "evolution" ? (
            <EvolutionGroupPicker
              number={number}
              groups={evolutionGroups ?? []}
              canEdit={canEdit}
              onUpdated={onUpdated}
            />
          ) : number.portfolio ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-emerald-50 to-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200">
              <Building2 className="h-3 w-3" />
              {number.portfolio.name}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
              <AlertTriangle className="h-3 w-3" />
              Unassigned
            </span>
          )}
          {number.provider === "evolution" ? (
            <EvolutionStateBadge number={number} />
          ) : (
            <MetaStatusBadge
              number={number}
              canEdit={canEdit}
              onUpdated={onUpdated}
            />
          )}
        </div>
      </div>

      {err ? (
        <div className="mx-5 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}

      {/* Action toolbar — horizontal, separated by a faint divider */}
      <div className="relative flex flex-wrap items-center gap-2 border-t bg-secondary/20 px-5 py-3">
        <ActionChip href="/automation" icon={Sparkles} tone="violet">
          Auto-reply
        </ActionChip>
        {canEdit ? (
          <ActionChip
            onClick={() => setShowWebhooks((v) => !v)}
            icon={Webhook}
            tone="indigo"
            active={showWebhooks}
          >
            Webhooks
          </ActionChip>
        ) : null}
        {canEdit ? (
          <ActionChip
            onClick={() => setShowTokens((v) => !v)}
            icon={KeyRound}
            tone="amber"
            active={showTokens}
          >
            API tokens
          </ActionChip>
        ) : null}
        {canEdit && number.provider !== "evolution" ? (
          // Meta Cloud calling API only — Baileys can't originate calls.
          <EnableCallingButton phoneNumberId={number.phone_number_id} />
        ) : null}
        {canEdit && number.provider === "evolution" ? (
          <ActionChip
            onClick={() => setShowCallSettings((v) => !v)}
            icon={PhoneCall}
            tone="indigo"
            active={showCallSettings}
          >
            Call settings
          </ActionChip>
        ) : null}
        {canEdit && number.provider === "evolution" ? (
          <ActionChip
            onClick={() => setShowStatusModal(true)}
            icon={CircleDot}
            tone="emerald"
          >
            Post Status
          </ActionChip>
        ) : null}
        {canEdit && number.provider === "evolution" && number.evolution_instance_name ? (
          <SyncHistoryButton instanceName={number.evolution_instance_name} />
        ) : null}
        {/* Reconnect — Evolution number that logged out / dropped. Re-arms
            the QR for the SAME instance, so scanning binds back into this
            number instead of creating a fresh one. */}
        {canEdit &&
        number.provider === "evolution" &&
        number.evolution_instance_name &&
        number.evolution_connection_state !== "open" ? (
          <ActionChip
            onClick={() => setReconnecting(true)}
            icon={RefreshCw}
            tone="amber"
          >
            Reconnect
          </ActionChip>
        ) : null}
      </div>

      {showWebhooks ? <WebhooksPanel bpid={number.phone_number_id} /> : null}
      {showTokens ? <ApiTokensPanel bpid={number.phone_number_id} /> : null}
      {showCallSettings && number.evolution_instance_name ? (
        <EvolutionCallSettingsPanel
          instanceName={number.evolution_instance_name}
        />
      ) : null}
      {showStatusModal ? (
        <PostStatusModal
          phoneNumberId={number.phone_number_id}
          onClose={() => setShowStatusModal(false)}
        />
      ) : null}
      {reconnecting && number.evolution_instance_name ? (
        <EvolutionConnectModal
          reconnectInstanceName={number.evolution_instance_name}
          onClose={() => setReconnecting(false)}
          onConnected={() => {
            setReconnecting(false);
            onUpdated();
          }}
        />
      ) : null}

      {/* Danger zone — remove the number + all its data. Collapsed by
          default so it can't be hit accidentally. Owner-only (API
          enforces; UI just gates on canEdit). */}
      {canEdit ? (
        <div className="border-t border-rose-100 bg-rose-50/30 px-5 py-2.5">
          {!showDanger ? (
            <button
              type="button"
              onClick={() => setShowDanger(true)}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-600 hover:text-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Danger zone — remove this number
            </button>
          ) : (
            <PurgeNumberPanel
              number={number}
              onCancel={() => setShowDanger(false)}
              onPurged={onUpdated}
            />
          )}
        </div>
      ) : null}
    </article>
  );
}

// Per-number WABA id editor. Templates live at the WABA level, and one
// Meta business portfolio can own several WABAs — so the portfolio's
// single business_account_id is wrong for any number whose WABA
// differs. Setting the WABA id here makes the Templates page fetch the
// correct library for THIS number. Find it in Meta Business Settings →
// WhatsApp accounts → the "ID:" under the account name.
// Memory note for "what is this number for" — pure operator aid, never
// the display label. Renders as a small subtitle/chip below the phone
// row; click to edit inline. Empty state shows a soft "Add note" chip
// so the operator notices the field without it being noisy.
function MemoEditor({
  number,
  canEdit,
  onUpdated,
}: {
  number: NumberRow;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(number.memo ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/business-numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: number.phone_number_id,
          memo: draft.trim(),
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEditing(false);
      onUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What is this number for? e.g. Sales, Marketing campaign…"
          maxLength={200}
          autoFocus
          disabled={saving}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(number.memo ?? "");
              setErr(null);
            }
          }}
          className="min-w-[220px] flex-1 rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft(number.memo ?? "");
            setErr(null);
          }}
          disabled={saving}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-muted-foreground hover:bg-secondary"
          aria-label="Cancel"
        >
          <X className="h-3 w-3" />
        </button>
        {err ? (
          <span className="text-[11px] text-destructive">{err}</span>
        ) : null}
      </div>
    );
  }

  if (number.memo?.trim()) {
    return (
      <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md bg-amber-50/70 px-2 py-1 text-[11px] text-amber-900 ring-1 ring-inset ring-amber-200">
        <Sparkles className="h-3 w-3 shrink-0 text-amber-600" />
        <span className="truncate">{number.memo}</span>
        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setDraft(number.memo ?? "");
              setEditing(true);
            }}
            className="shrink-0 text-[10px] font-semibold text-amber-700 hover:text-amber-900"
          >
            Edit
          </button>
        ) : null}
      </div>
    );
  }

  if (!canEdit) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft("");
        setEditing(true);
      }}
      className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
    >
      <Edit3 className="h-3 w-3" />
      Add a memory note
    </button>
  );
}

function WabaIdEditor({
  number,
  canEdit,
  onUpdated,
}: {
  number: NumberRow;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(number.waba_id ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/business-numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: number.phone_number_id,
          waba_id: draft.trim(),
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEditing(false);
      onUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit && !number.waba_id) return null;

  if (editing) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="WABA id (numeric)"
          disabled={saving}
          className="w-48 rounded-md border bg-background px-2 py-1 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft(number.waba_id ?? "");
            setErr(null);
          }}
          className="rounded-md border bg-background px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      {number.waba_id ? (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <span className="opacity-60">WABA</span>
          {number.waba_id}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
          <AlertTriangle className="h-2.5 w-2.5" />
          WABA id not set — templates may be wrong
        </span>
      )}
      {canEdit ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[10px] font-medium text-emerald-700 hover:underline"
        >
          {number.waba_id ? "Edit" : "Set WABA id"}
        </button>
      ) : null}
    </div>
  );
}

// Meta connection status badge + on-demand check. Surfaces whether a
// number still exists on Meta's WhatsApp Business API:
//   • connected → green "On Meta"
//   • removed   → rose "Removed from Meta" (operator deleted it on Meta;
//                 inbound has stopped — prompt to purge)
//   • unknown   → grey "Meta status: not checked"
// "Check" pings Meta's Graph API via /meta-check and persists the result.
function MetaStatusBadge({
  number,
  canEdit,
  onUpdated,
}: {
  number: NumberRow;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/business-numbers/${encodeURIComponent(number.phone_number_id)}/meta-check`,
        { method: "POST" },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  const status = number.meta_status ?? "unknown";
  const checkedLabel = number.meta_checked_at
    ? new Date(number.meta_checked_at).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const badge =
    status === "connected" ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        On Meta
      </span>
    ) : status === "removed" ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
        <AlertTriangle className="h-2.5 w-2.5" />
        Removed from Meta
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
        Meta: not checked
      </span>
    );

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1.5">
        {badge}
        {canEdit ? (
          <button
            type="button"
            onClick={check}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            title="Re-check this number against Meta's WhatsApp Business API"
          >
            {busy ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <RefreshCw className="h-2.5 w-2.5" />
            )}
            {busy ? "Checking…" : "Check"}
          </button>
        ) : null}
      </div>
      {err ? (
        <span className="text-[10px] text-rose-600" title={err}>
          {err.length > 38 ? `${err.slice(0, 38)}…` : err}
        </span>
      ) : checkedLabel ? (
        <span className="text-[9px] text-muted-foreground">
          Checked {checkedLabel}
        </span>
      ) : null}
    </div>
  );
}

// Typed-confirmation purge for a business number. The operator must
// type the exact phone_number_id, which is then echoed to the API as
// `confirm` so a stray click can't wipe a number. On success the API
// returns a per-table deleted-row count which we surface briefly.
function PurgeNumberPanel({
  number,
  onCancel,
  onPurged,
}: {
  number: NumberRow;
  onCancel: () => void;
  onPurged: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, number> | null>(null);
  const expected = number.phone_number_id;
  const label =
    number.nickname?.trim() ||
    number.verified_name?.trim() ||
    number.display_phone_number ||
    number.phone_number_id;

  async function handlePurge() {
    if (confirm !== expected) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/business-numbers/${encodeURIComponent(expected)}/purge`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm }),
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        deleted?: Record<string, number>;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setDone(json.deleted ?? {});
      setTimeout(onPurged, 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purge failed");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const total = Object.values(done).reduce((a, b) => a + b, 0);
    return (
      <div className="text-[11px] text-emerald-800">
        <span className="font-semibold">Removed {label}</span> — {total} row(s)
        deleted across messages, contacts, calls, automation, tokens &amp;
        webhooks. Refreshing…
      </div>
    );
  }

  const isEvolution = number.provider === "evolution";
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-rose-800">
        <strong>Permanently delete {label}</strong> and ALL of its data —
        every chat, message, call, automation config, API token and webhook.
        This cannot be undone. Owner-only.
      </div>
      <div
        className={`rounded-md border px-2.5 py-1.5 text-[10.5px] ${
          isEvolution
            ? "border-violet-200 bg-violet-50 text-violet-800"
            : "border-sky-200 bg-sky-50 text-sky-800"
        }`}
      >
        {isEvolution ? (
          <>
            <strong>Evolution side:</strong> instance will also be deleted on
            the Evolution server, freeing the WhatsApp session.
          </>
        ) : (
          <>
            <strong>Meta side:</strong> only deletes locally — the phone
            number stays on Meta Business Suite. Remove it from Meta
            yourself if needed.
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={`Type "${expected}" to confirm`}
          disabled={busy}
          className="w-64 rounded-md border border-rose-200 bg-background px-2 py-1.5 text-xs font-mono shadow-sm focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-400 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handlePurge}
          disabled={busy || confirm !== expected}
          className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Delete number + all data
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {err ? <div className="text-[11px] text-rose-700">{err}</div> : null}
    </div>
  );
}

// Render `+91 90847 23091` from `+919084723091` etc. Best-effort: if the
// upstream string already has spaces / formatting we leave it alone.
function formatPhone(raw: string | null): string {
  if (!raw) return "";
  const t = raw.trim();
  if (t.includes(" ")) return t;
  // Indian numbers (+91 or 91 prefix, 10 digits after).
  const m = t.match(/^\+?(\d{1,3})(\d{5})(\d{5})$/);
  if (m) return `+${m[1]} ${m[2]} ${m[3]}`;
  return t;
}

// One-time toggle that POSTs to /api/whatsapp-call/settings to flip
// WhatsApp Cloud Calling on for this phone number. Without this, Meta
// silently drops every inbound call and rejects every outbound dial
// attempt — so we surface the action right next to the number row
// instead of hiding it in a separate "Calling" page.
function EnableCallingButton({ phoneNumberId }: { phoneNumberId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/whatsapp-call/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: phoneNumberId, status: "ENABLED" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ActionChip
        onClick={handleClick}
        icon={busy ? Loader2 : PhoneCall}
        iconClassName={busy ? "animate-spin" : ""}
        tone={done ? "emeraldStrong" : "emerald"}
        disabled={busy}
        title="Enable WhatsApp Cloud Calling for this number"
      >
        {done ? "Calling on" : busy ? "Enabling…" : "Enable calls"}
      </ActionChip>
      {err ? (
        <span className="text-[10px] text-destructive" title={err}>
          {err.length > 32 ? `${err.slice(0, 32)}…` : err}
        </span>
      ) : null}
    </>
  );
}

function AddNumberModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [displayPhone, setDisplayPhone] = useState("");
  const [verifiedName, setVerifiedName] = useState("");
  const [nickname, setNickname] = useState("");
  const [portfolioKey, setPortfolioKey] = useState("");
  const [portfolios, setPortfolios] = useState<PortfolioOption[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // Auto-fetch state — fires when phone_number_id reaches a plausible
  // length OR portfolio changes. Tracks the last id we tried so we don't
  // hammer Meta on every keystroke.
  const [autoFetching, setAutoFetching] = useState(false);
  const [autoFetchedFor, setAutoFetchedFor] = useState<string | null>(null);
  const [autoStatus, setAutoStatus] = useState<
    | { kind: "idle" }
    | { kind: "ok"; portfolio_key: string | null }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  const lookup = async (id: string, key: string) => {
    if (!/^\d{6,}$/.test(id)) return;
    setAutoFetching(true);
    setAutoStatus({ kind: "idle" });
    try {
      const params = new URLSearchParams({ phone_number_id: id });
      if (key) params.set("portfolio_key", key);
      const res = await fetch(`/api/business-numbers/lookup?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        display_phone_number?: string;
        verified_name?: string | null;
        portfolio_key?: string | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setAutoStatus({ kind: "err", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      // Only fill if the user hasn't typed something — never clobber input.
      if (json.display_phone_number) {
        setDisplayPhone((cur) => (cur.trim() ? cur : json.display_phone_number!));
      }
      if (json.verified_name) {
        setVerifiedName((cur) => (cur.trim() ? cur : json.verified_name!));
        setNickname((cur) => (cur.trim() ? cur : json.verified_name!));
      }
      // Auto-pick the matching portfolio when none is chosen yet.
      if (!key && json.portfolio_key) {
        setPortfolioKey(json.portfolio_key);
      }
      setAutoStatus({ kind: "ok", portfolio_key: json.portfolio_key ?? null });
      setAutoFetchedFor(`${id}:${json.portfolio_key ?? ""}`);
    } catch (e) {
      setAutoStatus({
        kind: "err",
        message: e instanceof Error ? e.message : "Lookup failed",
      });
    } finally {
      setAutoFetching(false);
    }
  };

  // Debounced auto-fetch when the ID looks complete.
  useEffect(() => {
    const id = phoneNumberId.trim();
    if (!/^\d{12,}$/.test(id)) return;
    const cacheKey = `${id}:${portfolioKey}`;
    if (autoFetchedFor === cacheKey) return;
    const t = setTimeout(() => {
      lookup(id, portfolioKey);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneNumberId, portfolioKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/portfolios", { cache: "no-store" });
        const json = (await res.json()) as { portfolios?: PortfolioOption[] };
        if (cancelled) return;
        setPortfolios((json.portfolios ?? []).filter((p) => p.is_active));
      } catch {
        if (!cancelled) setPortfolios([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setErr(null);
    setWarn(null);
    try {
      const res = await fetch("/api/business-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: phoneNumberId.trim(),
          display_phone_number: displayPhone.trim() || null,
          verified_name: verifiedName.trim() || null,
          nickname: nickname.trim() || null,
          portfolio_key: portfolioKey || null,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        assigned_persisted?: boolean | null;
        message?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (portfolioKey && json.assigned_persisted === false) {
        setWarn(
          json.message ??
            "Saved in memory only — set PORTFOLIO_*_PHONE_IDS in your hosting env vars.",
        );
        return;
      }
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <form
        className="w-full max-w-lg rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold">Add WhatsApp number</h3>
            <p className="text-[11px] text-muted-foreground">
              Get the phone number ID from Meta → WhatsApp Manager → API Setup.
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
          <Field
            label="Phone number ID"
            required
            hint={
              autoFetching
                ? "Fetching from Meta…"
                : autoStatus.kind === "ok"
                  ? `Auto-filled from Meta${autoStatus.portfolio_key ? ` · ${autoStatus.portfolio_key}` : ""}`
                  : autoStatus.kind === "err"
                    ? autoStatus.message
                    : "Numeric ID from Meta (e.g. 1186098484633497)"
            }
            hintTone={
              autoStatus.kind === "ok"
                ? "ok"
                : autoStatus.kind === "err"
                  ? "err"
                  : undefined
            }
          >
            <div className="relative">
              <input
                required
                autoFocus
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                pattern="\d{6,}"
                placeholder="1186098484633497"
                className="w-full rounded-md border bg-background px-2.5 py-1.5 pr-20 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              {phoneNumberId.length >= 6 ? (
                <button
                  type="button"
                  onClick={() => {
                    setAutoFetchedFor(null);
                    void lookup(phoneNumberId.trim(), portfolioKey);
                  }}
                  disabled={autoFetching}
                  className="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
                  title="Fetch display phone number + verified name from Meta"
                >
                  {autoFetching ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  Fetch
                </button>
              ) : null}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Display phone number">
              <input
                value={displayPhone}
                onChange={(e) => setDisplayPhone(e.target.value)}
                placeholder="+91 90847 23091"
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </Field>
            <Field label="Verified name">
              <input
                value={verifiedName}
                onChange={(e) => setVerifiedName(e.target.value)}
                placeholder="QHT Clinic"
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </Field>
          </div>

          <Field label="Nickname" hint="Friendly label shown in the inbox">
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={80}
              placeholder="Support · QHT"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </Field>

          <Field label="Portfolio" hint="Each number belongs to one Meta Business App">
            {portfolios === null ? (
              <div className="grid h-9 place-items-center text-xs text-muted-foreground">
                Loading…
              </div>
            ) : portfolios.length === 0 ? (
              <div className="rounded-md border bg-secondary/30 px-2.5 py-1.5 text-xs text-muted-foreground">
                No active portfolios. Configure one under{" "}
                <Link href="/settings/portfolios" className="text-primary hover:underline">
                  Settings → Portfolios
                </Link>{" "}
                first.
              </div>
            ) : (
              <select
                value={portfolioKey}
                onChange={(e) => setPortfolioKey(e.target.value)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="">Don&apos;t assign yet</option>
                {portfolios.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {err}
            </div>
          ) : null}
          {warn ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              {warn}{" "}
              <button
                type="button"
                onClick={onAdded}
                className="font-semibold underline hover:no-underline"
              >
                Continue
              </button>
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
            type="submit"
            disabled={saving || !phoneNumberId.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add number
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  hintTone,
  required,
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: "ok" | "err";
  required?: boolean;
  children: React.ReactNode;
}) {
  const hintClass =
    hintTone === "ok"
      ? "text-emerald-700"
      : hintTone === "err"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
          {required ? <span className="text-destructive"> *</span> : null}
        </span>
        {hint ? <span className={cn("text-[10px]", hintClass)}>{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function SkeletonState() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl border bg-card shadow-sm" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-xl border-2 border-dashed bg-card/50 px-6 py-16 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
          <Phone className="h-6 w-6" />
        </div>
        <div className="text-sm font-semibold">No numbers connected yet</div>
        <p className="mt-1 text-xs text-muted-foreground">
          A number appears here automatically the first time it receives a message via the webhook. Make sure your portfolio is configured under{" "}
          <Link href="/settings/portfolios" className="text-primary hover:underline">
            Portfolios
          </Link>{" "}
          first.
        </p>
      </div>
    </div>
  );
}

interface WebhookRow {
  id: string;
  label: string | null;
  url: string;
  secret: string;
  enabled: boolean;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  delivery_count: number;
  failure_count: number;
  created_at: string;
  created_by_user_id: string | null;
}

function WebhooksPanel({ bpid }: { bpid: string }) {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch(`/api/business-numbers/${bpid}/webhooks`, {
        cache: "no-store",
      });
      const j = (await res.json()) as { webhooks?: WebhookRow[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setHooks(j.webhooks ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpid]);

  async function add() {
    if (!/^https?:\/\//i.test(draftUrl.trim())) {
      setErr("URL must start with http:// or https://");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/business-numbers/${bpid}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: draftUrl.trim(), label: draftLabel.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraftUrl("");
      setDraftLabel("");
      setAdding(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await fetch(`/api/business-numbers/${bpid}/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this webhook? Events will stop firing immediately.")) return;
    await fetch(`/api/business-numbers/${bpid}/webhooks/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="border-t bg-violet-50/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-violet-900">
          <Webhook className="h-3 w-3" />
          Outbound webhooks
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-700"
          >
            <Plus className="h-3 w-3" />
            Add URL
          </button>
        ) : null}
      </div>
      <p className="mb-3 text-[10px] text-muted-foreground">
        Every event on this number (inbound msg, status, calls) POSTs JSON to each
        URL with an{" "}
        <span className="font-mono text-[10px]">X-QHT-Signature</span> HMAC header.
      </p>

      {err ? (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}

      {adding ? (
        <div className="mb-3 grid gap-2 rounded-lg border border-violet-200 bg-white p-3">
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label (e.g. n8n inbox flow) — optional"
            className="rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="https://your-webhook-receiver.example.com/path"
            autoFocus
            className="rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraftUrl("");
                setDraftLabel("");
                setErr(null);
              }}
              disabled={busy}
              className="rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={add}
              disabled={busy || !draftUrl.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      ) : null}

      {hooks === null ? (
        <div className="grid h-16 place-items-center text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      ) : hooks.length === 0 ? (
        <p className="rounded-md border border-dashed bg-card/50 px-3 py-2 text-center text-[11px] text-muted-foreground">
          No webhooks yet — add one above to start receiving events.
        </p>
      ) : (
        <div className="space-y-2">
          {hooks.map((h) => (
            <WebhookRowCard key={h.id} hook={h} onPatch={patch} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

function WebhookRowCard({
  hook,
  onPatch,
  onDelete,
}: {
  hook: WebhookRow;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [revealSecret, setRevealSecret] = useState(false);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);
  const { byUserId } = useMembers();
  const creator = hook.created_by_user_id
    ? byUserId.get(hook.created_by_user_id)?.full_name ||
      byUserId.get(hook.created_by_user_id)?.email ||
      null
    : null;

  const ok = hook.last_status_code != null && hook.last_status_code >= 200 && hook.last_status_code < 300;
  const dot = !hook.enabled
    ? "bg-slate-400"
    : hook.last_attempt_at == null
      ? "bg-slate-300"
      : ok
        ? "bg-emerald-500"
        : "bg-rose-500";

  function copy(text: string, kind: "url" | "secret") {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1200);
    });
  }

  return (
    <div className="rounded-lg border bg-white px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("inline-flex h-2 w-2 rounded-full", dot)} />
            <span className="truncate font-semibold">
              {hook.label ?? "Webhook"}
            </span>
            {creator ? (
              <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                · by {creator}
              </span>
            ) : null}
            {!hook.enabled ? (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-slate-600">
                Paused
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {hook.url}
            </span>
            <button
              type="button"
              onClick={() => copy(hook.url, "url")}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Copy URL"
            >
              {copied === "url" ? (
                <Check className="h-2.5 w-2.5 text-emerald-600" />
              ) : (
                <Copy className="h-2.5 w-2.5" />
              )}
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Secret
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {revealSecret ? hook.secret : "•".repeat(Math.min(24, hook.secret.length))}
            </span>
            <button
              type="button"
              onClick={() => setRevealSecret((v) => !v)}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label={revealSecret ? "Hide secret" : "Reveal secret"}
            >
              {revealSecret ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
            </button>
            <button
              type="button"
              onClick={() => copy(hook.secret, "secret")}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Copy secret"
            >
              {copied === "secret" ? (
                <Check className="h-2.5 w-2.5 text-emerald-600" />
              ) : (
                <Copy className="h-2.5 w-2.5" />
              )}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => onPatch(hook.id, { enabled: !hook.enabled })}
            className="rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {hook.enabled ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Rotate secret? Existing receivers will stop verifying signatures until you update them with the new value.")) {
                onPatch(hook.id, { rotate_secret: true });
              }
            }}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Rotate
          </button>
          <button
            type="button"
            onClick={() => onDelete(hook.id)}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-2.5 w-2.5" />
            Delete
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-1.5 text-[10px] text-muted-foreground">
        <span>
          Delivered: <span className="font-semibold tabular-nums">{hook.delivery_count.toLocaleString()}</span>
        </span>
        <span>
          Failed:{" "}
          <span
            className={cn(
              "font-semibold tabular-nums",
              hook.failure_count > 0 ? "text-rose-700" : "",
            )}
          >
            {hook.failure_count.toLocaleString()}
          </span>
        </span>
        {hook.last_attempt_at ? (
          <span>
            Last:{" "}
            <span
              className={cn(
                "font-semibold",
                ok ? "text-emerald-700" : "text-rose-700",
              )}
            >
              {hook.last_status_code ?? "—"}
            </span>{" "}
            · {new Date(hook.last_attempt_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : (
          <span className="italic">No attempts yet</span>
        )}
        {hook.last_error ? (
          <span className="w-full truncate text-rose-700" title={hook.last_error}>
            ⚠ {hook.last_error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface ApiTokenRow {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
  created_by_user_id: string | null;
}

function ApiTokensPanel({ bpid }: { bpid: string }) {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch(`/api/business-numbers/${bpid}/tokens`, {
        cache: "no-store",
      });
      const j = (await res.json()) as { tokens?: ApiTokenRow[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setTokens(j.tokens ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpid]);

  async function add() {
    const n = draftName.trim();
    if (!n) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/business-numbers/${bpid}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraftName("");
      setAdding(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await fetch(`/api/business-numbers/${bpid}/tokens/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this token? Any integration using it will immediately stop working.")) return;
    await fetch(`/api/business-numbers/${bpid}/tokens/${id}`, { method: "DELETE" });
    await load();
  }

  // Convenience: figure out the public origin so the example URL we
  // show in the UI matches whatever the operator deployed under.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-app";

  return (
    <div className="border-t bg-amber-50/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-amber-900">
          <KeyRound className="h-3 w-3" />
          API tokens
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-amber-700"
          >
            <Plus className="h-3 w-3" />
            New token
          </button>
        ) : null}
      </div>
      <p className="mb-3 text-[10px] text-muted-foreground">
        Use a token as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span> on{" "}
        <span className="font-mono">{origin}/api/v1/messages</span> to send WhatsApp messages
        without ever handling Meta credentials.
      </p>

      {err ? (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}

      {adding ? (
        <div className="mb-3 grid gap-2 rounded-lg border border-amber-200 bg-white p-3">
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Name (e.g. n8n booking flow)"
            autoFocus
            className="rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraftName("");
                setErr(null);
              }}
              disabled={busy}
              className="rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={add}
              disabled={busy || !draftName.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
              Generate
            </button>
          </div>
        </div>
      ) : null}

      {tokens === null ? (
        <div className="grid h-16 place-items-center text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="rounded-md border border-dashed bg-card/50 px-3 py-2 text-center text-[11px] text-muted-foreground">
          No API tokens yet — generate one to start hitting /api/v1 from outside.
        </p>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <ApiTokenRowCard key={t.id} token={t} onPatch={patch} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApiTokenRowCard({
  token,
  onPatch,
  onDelete,
}: {
  token: ApiTokenRow;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const { byUserId } = useMembers();
  const creator = token.created_by_user_id
    ? byUserId.get(token.created_by_user_id)?.full_name ||
      byUserId.get(token.created_by_user_id)?.email ||
      null
    : null;

  function copy() {
    navigator.clipboard.writeText(token.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="rounded-lg border bg-white px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-2 w-2 rounded-full",
                token.enabled ? "bg-emerald-500" : "bg-slate-400",
              )}
            />
            <span className="truncate font-semibold">{token.name}</span>
            {creator ? (
              <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                · by {creator}
              </span>
            ) : null}
            {!token.enabled ? (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-slate-600">
                Paused
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Token
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {reveal ? token.token : token.token.slice(0, 8) + "•".repeat(20)}
            </span>
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label={reveal ? "Hide token" : "Reveal token"}
            >
              {reveal ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
            </button>
            <button
              type="button"
              onClick={copy}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Copy token"
            >
              {copied ? (
                <Check className="h-2.5 w-2.5 text-emerald-600" />
              ) : (
                <Copy className="h-2.5 w-2.5" />
              )}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => onPatch(token.id, { enabled: !token.enabled })}
            className="rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {token.enabled ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Rotate token? Any integration using the old value will stop working.")) {
                onPatch(token.id, { rotate: true });
              }
            }}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Rotate
          </button>
          <button
            type="button"
            onClick={() => onDelete(token.id)}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-2.5 w-2.5" />
            Delete
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-1.5 text-[10px] text-muted-foreground">
        <span>
          Requests:{" "}
          <span className="font-semibold tabular-nums">
            {token.request_count.toLocaleString()}
          </span>
        </span>
        {token.last_used_at ? (
          <span>
            Last used:{" "}
            {new Date(token.last_used_at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : (
          <span className="italic">Never used yet</span>
        )}
        <span>
          Created:{" "}
          {new Date(token.created_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evolution "connect via QR" modal — opens, calls POST /api/evolution/instances,
// shows the returned QR base64, then polls GET ?name=<instance> every 2s to
// pick up the connection-state transition. When state flips to "open", we
// know the QR has been scanned + the row is linked → close and refresh.
// ---------------------------------------------------------------------------
// Tiny status pill for Evolution numbers — green dot when 'open',
// amber when 'connecting' (still scanning QR), rose when 'close'
// (session ended). Replaces MetaStatusBadge on Evolution rows since
// Meta's API check is irrelevant for Baileys.
// Avatar for the number row. Renders the cached WhatsApp profile pic
// when available, falls back to the gradient initials tile. For
// Evolution numbers that have NO cached pic yet (or whose cached URL
// has 404'd — Meta CDN URLs expire after ~24h), silently triggers a
// refresh on mount so the next render shows the real picture.
function NumberAvatar({
  number,
  initials,
}: {
  number: NumberRow;
  initials: string;
}) {
  const [pic, setPic] = useState<string | null>(number.profile_pic_url ?? null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setPic(number.profile_pic_url ?? null);
    setErrored(false);
  }, [number.profile_pic_url]);

  useEffect(() => {
    if (number.provider !== "evolution") return;
    if (!number.evolution_instance_name) return;
    if (number.evolution_connection_state !== "open") return;
    // If we already have a pic AND it hasn't errored this render, skip
    // the refresh — the cache is good for ~24h.
    if (pic && !errored) return;
    if (typeof window === "undefined") return;
    void fetch(
      `/api/evolution/instances/${encodeURIComponent(number.evolution_instance_name)}/refresh-avatar`,
      { method: "POST" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { profile_pic_url?: string | null } | null) => {
        if (j?.profile_pic_url) {
          setPic(j.profile_pic_url);
          setErrored(false);
        }
      })
      .catch(() => {});
  }, [
    number.provider,
    number.evolution_instance_name,
    number.evolution_connection_state,
    pic,
    errored,
  ]);

  return (
    <span className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-base font-semibold text-white shadow-md shadow-emerald-900/10 ring-1 ring-emerald-700/20">
      {pic && !errored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pic}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        initials
      )}
      <span className="absolute -bottom-1 -right-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white text-emerald-700 ring-2 ring-card">
        <Phone className="h-2.5 w-2.5" />
      </span>
    </span>
  );
}

function EvolutionStateBadge({ number }: { number: NumberRow }) {
  const state = number.evolution_connection_state ?? "connecting";
  // Pull live health (disconnect count in the last 24h + the most recent
  // reason code) so we can flag numbers that are unstable or have been
  // logged out by WhatsApp. Defer the request behind a short delay so
  // a page of 10+ rows doesn't fire 10 simultaneous queries on mount.
  const [health, setHealth] = useState<{
    count24h: number;
    lastReason: number | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void fetch(
        `/api/evolution/health?phone_number_id=${encodeURIComponent(number.phone_number_id)}`,
        { cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (cancelled || !j) return;
          setHealth({
            count24h: j.disconnects_24h ?? 0,
            lastReason: j.last_reason_code ?? null,
          });
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [number.phone_number_id]);

  // One-time per browser session: tell Evolution to re-subscribe this
  // instance to our current webhook event list. Backfills new events
  // (e.g. CALL) onto instances that were created before we added them
  // — without this the operator would have to delete and re-scan the
  // number. Cheap (single POST), gated by sessionStorage so we don't
  // hammer Evolution on every render.
  useEffect(() => {
    if (!number.evolution_instance_name) return;
    if (typeof window === "undefined") return;
    const key = `evo-wh-refresh:${number.evolution_instance_name}`;
    if (window.sessionStorage.getItem(key)) return;
    void fetch(
      `/api/evolution/instances/${encodeURIComponent(number.evolution_instance_name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-webhook" }),
      },
    )
      // Only mark done on success — otherwise a failed re-subscribe (e.g.
      // Evolution rate-limited while every card fired at once) would be
      // locked out for the whole session, leaving that number stuck not
      // live-syncing. On failure we leave the key unset so it retries.
      .then((r) => {
        if (r.ok) window.sessionStorage.setItem(key, "1");
      })
      .catch(() => {});
  }, [number.evolution_instance_name]);

  // 401 from Baileys = logged out / number unlinked. Treat as a hard
  // failure independent of the live state, since the operator needs to
  // re-scan the QR to recover.
  const loggedOut = health?.lastReason === 401;
  // 5+ closes in 24h with the number still wobbling = unstable.
  const unstable = (health?.count24h ?? 0) >= 5 && state !== "open";

  const palette = loggedOut
    ? "bg-rose-50 text-rose-700 ring-rose-200"
    : state === "open"
      ? unstable
        ? "bg-amber-50 text-amber-800 ring-amber-200"
        : "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : state === "close"
        ? "bg-rose-50 text-rose-700 ring-rose-200"
        : "bg-amber-50 text-amber-800 ring-amber-200";
  const dot = loggedOut
    ? "bg-rose-500"
    : state === "open"
      ? unstable
        ? "bg-amber-500"
        : "bg-emerald-500"
      : state === "close"
        ? "bg-rose-500"
        : "bg-amber-500 animate-pulse";
  const label = loggedOut
    ? "Logged out"
    : state === "open"
      ? unstable
        ? "Connected · unstable"
        : "Connected"
      : state === "close"
        ? "Disconnected"
        : "Connecting";
  const title = loggedOut
    ? "WhatsApp logged this number out (kicked from Linked Devices, or banned). Re-scan the QR to restore."
    : unstable
      ? `${health?.count24h ?? 0} disconnects in the last 24h — connection is wobbling. If it persists, check the Evolution server logs.`
      : state === "open"
        ? "Connected to WhatsApp via Baileys."
        : state === "close"
          ? "Connection is down. Try Reconnect from the number actions."
          : "Establishing the Baileys session…";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${palette}`}
      title={title}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function EvolutionConnectModal({
  onClose,
  onConnected,
  reconnectInstanceName,
}: {
  onClose: () => void;
  onConnected: () => void;
  /** When set, the modal RE-links this existing instance instead of
   *  creating a new one — scanning the QR binds WhatsApp back into the
   *  same number card. */
  reconnectInstanceName?: string;
}) {
  const isReconnect = !!reconnectInstanceName;
  const [displayName, setDisplayName] = useState("");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [instanceName, setInstanceName] = useState<string | null>(null);
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "waiting" | "open" | "error">(
    "idle",
  );
  const [err, setErr] = useState<string | null>(null);

  // Reconnect mode — re-arm the QR for the existing instance on mount.
  useEffect(() => {
    if (!reconnectInstanceName) return;
    let cancelled = false;
    (async () => {
      setCreating(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/evolution/instances/${encodeURIComponent(reconnectInstanceName)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reconnect" }),
          },
        );
        const j = (await res.json()) as {
          qr_base64?: string | null;
          error?: string;
        };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setInstanceName(reconnectInstanceName);
        setQrBase64(j.qr_base64 ?? null);
        setState("waiting");
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Reconnect failed");
          setState("error");
        }
      } finally {
        if (!cancelled) setCreating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reconnectInstanceName]);

  async function start() {
    setCreating(true);
    setErr(null);
    try {
      const res = await fetch("/api/evolution/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName.trim() || null,
          memo: memo.trim() || null,
        }),
      });
      const j = (await res.json()) as {
        instance_name?: string;
        qr_base64?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setInstanceName(j.instance_name ?? null);
      setQrBase64(j.qr_base64 ?? null);
      setState("waiting");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create instance");
      setState("error");
    } finally {
      setCreating(false);
    }
  }

  // Poll for QR refresh + connection state once an instance is in flight.
  // Evolution rotates the QR every ~20s — refetching the GET endpoint keeps
  // it fresh AND surfaces the state transition without a websocket.
  useEffect(() => {
    if (!instanceName || state !== "waiting") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/evolution/instances?name=${encodeURIComponent(instanceName)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          state?: "open" | "connecting" | "close";
          qr_base64?: string | null;
        };
        if (cancelled) return;
        if (j.qr_base64) setQrBase64(j.qr_base64);
        if (j.state === "open") {
          setState("open");
          // Brief celebratory pause so the operator sees the success state
          // before the modal vanishes.
          setTimeout(() => {
            if (!cancelled) onConnected();
          }, 1200);
        }
      } catch {
        /* network blip — keep polling */
      }
    };
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [instanceName, state, onConnected]);

  const modalContent = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-emerald-100/60">
        <header className="flex items-center justify-between border-b bg-gradient-to-br from-emerald-50 via-card to-card px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <Phone className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-tight">
                {isReconnect ? "Reconnect WhatsApp" : "Connect unofficial WhatsApp"}
              </h2>
              <p className="text-[10px] text-muted-foreground">
                {isReconnect
                  ? "Scan QR to re-link this same number."
                  : "Scan QR with the phone you want to connect."}
              </p>
            </div>
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

        <div className="px-5 py-4">
          {state === "idle" && isReconnect ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Generating reconnect QR…
            </div>
          ) : state === "idle" ? (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Yeh ek <strong>unofficial</strong> connection hai (Baileys via
                Evolution API) — Meta Cloud API se alag. Personal WhatsApp ki
                tarah QR scan karke connect hota hai. Approval / templates
                ki zarurat nahi, lekin ban risk hota hai agar bulk / spam
                bheja jaye.
              </p>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Display name (optional)
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Marketing"
                  maxLength={40}
                  className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Memo (optional)
                </label>
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="What is this number for?"
                  maxLength={200}
                  className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
              </div>
              {err ? (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                  {err}
                </div>
              ) : null}
              <button
                type="button"
                onClick={start}
                disabled={creating}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Generate QR
              </button>
            </div>
          ) : state === "waiting" ? (
            <div className="space-y-3">
              <div className="grid place-items-center rounded-xl border bg-secondary/40 p-4">
                {qrBase64 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrBase64}
                    alt="WhatsApp QR"
                    className="h-56 w-56 rounded-md bg-white p-2"
                  />
                ) : (
                  <div className="flex h-56 w-56 items-center justify-center text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                )}
              </div>
              <ol className="space-y-1 text-[11px] text-muted-foreground">
                <li>1. Phone par WhatsApp kholo</li>
                <li>2. Settings → Linked Devices → Link a Device</li>
                <li>3. Camera se yeh QR scan karo</li>
              </ol>
              <p className="text-[10px] text-muted-foreground">
                QR ~20s mein refresh hota hai. Connection automatic detect
                ho jayegi — yahaan rukna nahi padega.
              </p>
            </div>
          ) : state === "open" ? (
            <div className="grid place-items-center gap-2 py-6">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg">
                <Check className="h-6 w-6" />
              </span>
              <p className="text-sm font-semibold text-emerald-700">
                Connected!
              </p>
              <p className="text-[11px] text-muted-foreground">
                Number ab dashboard mein available hai.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-rose-700">{err}</p>
              <button
                type="button"
                onClick={() => setState("idle")}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Portal to <body> — invoked from a number card, the card's hover-
  // transform becomes the containing block for `position: fixed`, so
  // the overlay would otherwise be trapped (and clipped) inside the card.
  return typeof document !== "undefined"
    ? createPortal(modalContent, document.body)
    : null;
}

// Post a 24-hour WhatsApp Status from an Evolution number. Operator
// picks text or image, fills the body / picks the file, hits Post.
// File uploads land in the same `automation-trigger-images` bucket so
// Evolution can fetch a public URL (any public bucket works — we
// re-use this one to avoid adding new storage config).
function PostStatusModal({
  phoneNumberId,
  onClose,
}: {
  phoneNumberId: string;
  onClose: () => void;
}) {
  const [type, setType] = useState<"text" | "image" | "video">("text");
  const [text, setText] = useState("");
  const [caption, setCaption] = useState("");
  const [bgColor, setBgColor] = useState("#075E54");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  // Recent (last 24h) status posts for this number — shown at the bottom
  // of the modal so the operator can see what they've already pushed.
  interface StatusPost {
    id: string;
    type: "text" | "image" | "video" | "audio";
    content_preview: string | null;
    media_url: string | null;
    background_color: string | null;
    posted_at: string;
    expires_at: string;
    posted_by_email: string | null;
  }
  const [recent, setRecent] = useState<StatusPost[] | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/evolution/status?phone_number_id=${encodeURIComponent(phoneNumberId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setRecent((j.posts as StatusPost[]) ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [phoneNumberId, recentTick]);

  async function uploadFile(f: File): Promise<string> {
    const form = new FormData();
    form.set("file", f);
    const res = await fetch("/api/evolution/status-upload", {
      method: "POST",
      body: form,
    });
    const j = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !j.url) {
      throw new Error(j.error ?? "Upload failed");
    }
    return j.url;
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      let body: Record<string, unknown>;
      if (type === "text") {
        const t = text.trim();
        if (!t) throw new Error("Status text required");
        body = {
          phone_number_id: phoneNumberId,
          type: "text",
          content: t,
          background_color: bgColor,
        };
      } else {
        if (!file) throw new Error(`Pick a ${type} file`);
        const url = await uploadFile(file);
        body = {
          phone_number_id: phoneNumberId,
          type,
          content: url,
          caption: caption.trim() || undefined,
        };
      }
      const res = await fetch("/api/evolution/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setOk(true);
      // Refresh the recent list so the new post shows up immediately
      // before the modal auto-closes.
      setRecentTick((t) => t + 1);
      // Reset the form for the next post but keep the modal open a beat
      // so the operator can see it landed.
      setText("");
      setCaption("");
      setFile(null);
      setTimeout(() => setOk(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to post status");
    } finally {
      setBusy(false);
    }
  }

  // Portal to <body> — the parent number row card has `overflow-hidden`
  // plus a hover transform, which would otherwise trap this fixed-position
  // overlay inside the card and clip it. Rendering to body sidesteps both.
  if (typeof window === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-emerald-100/60">
        <header className="flex items-center justify-between border-b bg-gradient-to-br from-emerald-50 via-card to-card px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <CircleDot className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-tight">Post status</h2>
              <p className="text-[10px] text-muted-foreground">
                Visible to your contacts for 24 hours.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setType("text");
                setFile(null);
              }}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium",
                type === "text"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              Text
            </button>
            <button
              type="button"
              onClick={() => {
                setType("image");
                setFile(null);
              }}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium",
                type === "image"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              Image
            </button>
            <button
              type="button"
              onClick={() => {
                setType("video");
                setFile(null);
              }}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium",
                type === "video"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              Video
            </button>
          </div>

          {type === "text" ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="What's on your mind?"
                rows={4}
                maxLength={1024}
                disabled={busy}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              <div className="flex items-center gap-2 text-xs">
                <label className="text-muted-foreground">Background</label>
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  disabled={busy}
                  className="h-7 w-10 cursor-pointer rounded border bg-background"
                />
                <span className="font-mono text-muted-foreground">{bgColor}</span>
              </div>
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed bg-background px-4 py-6 text-sm text-muted-foreground hover:border-primary hover:text-foreground">
                <ImagePlus className="h-4 w-4" />
                {file
                  ? file.name
                  : type === "video"
                    ? "Choose video (≤16MB)"
                    : "Choose image (≤5MB)"}
                <input
                  type="file"
                  accept={
                    type === "video"
                      ? "video/mp4,video/quicktime,video/webm"
                      : "image/jpeg,image/png,image/webp"
                  }
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Optional caption"
                maxLength={500}
                disabled={busy}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </>
          )}

          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {err}
            </div>
          ) : null}
          {ok ? (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
              Status posted.
            </div>
          ) : null}

          <button
            type="button"
            onClick={submit}
            disabled={busy || (type === "text" ? !text.trim() : !file)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDot className="h-4 w-4" />}
            {busy ? "Posting…" : "Post status"}
          </button>

          {/* Recent statuses — last 24h. Mirrors what we sent to
              Evolution, not what's actually on the operator's phone
              (Evolution doesn't expose a "list my statuses" endpoint). */}
          <div className="border-t pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Recent (last 24h)
            </p>
            {recent === null ? (
              <p className="text-[11px] text-muted-foreground">Loading…</p>
            ) : recent.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No statuses posted in the last 24 hours.
              </p>
            ) : (
              <ul className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {recent.map((p) => {
                  const ageMin = Math.max(
                    0,
                    Math.floor((Date.now() - new Date(p.posted_at).getTime()) / 60000),
                  );
                  const ageLabel =
                    ageMin < 1
                      ? "just now"
                      : ageMin < 60
                        ? `${ageMin}m ago`
                        : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
                  return (
                    <li
                      key={p.id}
                      className="flex items-center gap-2 rounded-md border bg-secondary/30 px-2 py-1.5 text-[11px]"
                    >
                      <span
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded ring-1 ring-inset ring-border"
                        style={
                          p.type === "text"
                            ? {
                                backgroundColor: p.background_color ?? "#075E54",
                                color: "white",
                              }
                            : undefined
                        }
                      >
                        {p.type === "text" ? (
                          <span className="text-[9px] font-bold">Aa</span>
                        ) : p.type === "image" && p.media_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.media_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : p.type === "video" ? (
                          <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">
                          {p.content_preview ||
                            (p.type === "image"
                              ? "Image status"
                              : p.type === "video"
                                ? "Video status"
                                : p.type === "audio"
                                  ? "Audio status"
                                  : "Status")}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {p.type} · {ageLabel}
                          {p.posted_by_email ? ` · ${p.posted_by_email}` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Bulk status — post the same text/image/video status to a hand-picked
// set of Evolution numbers in one shot. We loop the existing per-number
// /api/evolution/status endpoint so the wiring stays trivial; perf is
// fine for typical 1–10 numbers. Per-number outcome is surfaced inline
// so the operator can see exactly which sends failed (rate limit, dead
// session, etc.) without having to reconcile a global toast.
function BulkPostStatusModal({
  numbers,
  onClose,
}: {
  numbers: NumberRow[];
  onClose: () => void;
}) {
  const [type, setType] = useState<"text" | "image" | "video">("text");
  const [text, setText] = useState("");
  const [caption, setCaption] = useState("");
  const [bgColor, setBgColor] = useState("#075E54");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(numbers.map((n) => n.phone_number_id)),
  );
  // Local error for input validation. Per-number results + busy state
  // now live in the module-level task store (lib/bulk-status-task) so
  // the work survives the modal closing.
  const [validationError, setValidationError] = useState<string | null>(null);
  const [task, setTask] = useState<BulkTaskState | null>(() =>
    getBulkTaskSnapshot(),
  );
  useEffect(() => subscribeBulkTask((s) => setTask(s)), []);
  const busy = !!task?.running;
  const results = task?.outcomes ?? [];

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allOn = selected.size === numbers.length;
  const toggleAll = () => {
    setSelected(allOn ? new Set() : new Set(numbers.map((n) => n.phone_number_id)));
  };

  async function uploadFile(f: File): Promise<string> {
    const form = new FormData();
    form.set("file", f);
    const res = await fetch("/api/evolution/status-upload", {
      method: "POST",
      body: form,
    });
    const j = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !j.url) throw new Error(j.error ?? "Upload failed");
    return j.url;
  }

  async function submit() {
    setValidationError(null);
    try {
      if (selected.size === 0) throw new Error("Pick at least one number");
      let payloadBase: Record<string, unknown>;
      if (type === "text") {
        const t = text.trim();
        if (!t) throw new Error("Status text required");
        payloadBase = { type: "text", content: t, background_color: bgColor };
      } else {
        if (!file) throw new Error(`Pick a ${type} file`);
        // Upload happens inline — small enough that the modal stays
        // open for the few seconds it takes. Bulk POSTs are the slow
        // part and now run inside the task store.
        const url = await uploadFile(file);
        payloadBase = {
          type,
          content: url,
          caption: caption.trim() || undefined,
        };
      }
      const targets = numbers
        .filter((n) => selected.has(n.phone_number_id))
        .map((n) => ({
          id: n.phone_number_id,
          label:
            n.nickname?.trim() ||
            n.verified_name ||
            n.display_phone_number ||
            n.phone_number_id,
        }));
      // Hands off to the module-level runner. Modal can be closed now —
      // the upload keeps going and the floating widget shows progress.
      startBulkStatus({
        kind: type,
        payloadBase,
        targets,
      });
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : "Failed");
    }
  }

  if (typeof window === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-emerald-100/60">
        <header className="flex items-center justify-between border-b bg-gradient-to-br from-emerald-50 via-card to-card px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <CircleDot className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-tight">
                Bulk post status
              </h2>
              <p className="text-[10px] text-muted-foreground">
                Post the same status to multiple unofficial numbers.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            // Always closable — work continues in the background task
            // store + a floating widget keeps the operator informed
            // across pages while uploads finish.
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          {/* Number multi-select */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Send to ({selected.size} of {numbers.length})
              </p>
              <button
                type="button"
                onClick={toggleAll}
                className="text-[11px] font-semibold text-emerald-700 hover:underline"
              >
                {allOn ? "Deselect all" : "Select all"}
              </button>
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-secondary/20 p-1.5">
              {numbers.map((n) => {
                const label =
                  n.nickname?.trim() ||
                  n.verified_name ||
                  n.display_phone_number ||
                  n.phone_number_id;
                const isOn = selected.has(n.phone_number_id);
                const isConnected = n.evolution_connection_state === "open";
                return (
                  <li key={n.phone_number_id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background",
                        isOn ? "bg-background" : "",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => toggle(n.phone_number_id)}
                        disabled={busy}
                        className="h-3.5 w-3.5 accent-emerald-600"
                      />
                      <span className="flex-1 truncate font-medium">{label}</span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                          isConnected
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"
                            : "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1 w-1 rounded-full",
                            isConnected ? "bg-emerald-500" : "bg-rose-500",
                          )}
                        />
                        {isConnected ? "Online" : "Offline"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Type picker */}
          <div className="flex gap-2">
            {(["text", "image", "video"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setType(k);
                  setFile(null);
                }}
                className={cn(
                  "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium capitalize",
                  type === k
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "bg-background text-muted-foreground hover:bg-secondary",
                )}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Form */}
          {type === "text" ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="What's on your mind?"
                rows={3}
                maxLength={1024}
                disabled={busy}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              <div className="flex items-center gap-2 text-xs">
                <label className="text-muted-foreground">Background</label>
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  disabled={busy}
                  className="h-7 w-10 cursor-pointer rounded border bg-background"
                />
                <span className="font-mono text-muted-foreground">{bgColor}</span>
              </div>
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed bg-background px-4 py-6 text-sm text-muted-foreground hover:border-primary hover:text-foreground">
                <ImagePlus className="h-4 w-4" />
                {file
                  ? file.name
                  : type === "video"
                    ? "Choose video (≤16MB)"
                    : "Choose image (≤5MB)"}
                <input
                  type="file"
                  accept={
                    type === "video"
                      ? "video/mp4,video/quicktime,video/webm"
                      : "image/jpeg,image/png,image/webp"
                  }
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Optional caption"
                maxLength={500}
                disabled={busy}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={
                busy ||
                selected.size === 0 ||
                (type === "text" ? !text.trim() : !file)
              }
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDot className="h-4 w-4" />}
              {busy
                ? `Posting ${task?.done ?? 0}/${task?.total ?? 0}…`
                : `Post to ${selected.size} number${selected.size === 1 ? "" : "s"}`}
            </button>
            {busy ? (
              <>
                <button
                  type="button"
                  onClick={() => stopBulkStatus()}
                  title="Stop — skip the numbers not yet posted."
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-rose-200 bg-background px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                >
                  <Square className="h-3 w-3 fill-current" />
                  Stop
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  title="Close this dialog. Upload keeps going in the background."
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
                >
                  Run in background
                </button>
              </>
            ) : null}
          </div>
          {validationError ? (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
              {validationError}
            </div>
          ) : null}

          {/* Per-number results */}
          {results.length > 0 ? (
            <div className="border-t pt-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Results
              </p>
              <ul className="space-y-1">
                {results.map((r) => (
                  <li
                    key={r.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1 text-[11px]",
                      r.ok
                        ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200"
                        : "bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-200",
                    )}
                  >
                    {r.ok ? (
                      <Check className="h-3 w-3 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 shrink-0" />
                    )}
                    <span className="font-semibold">{r.label}</span>
                    {r.error ? (
                      <span className="truncate text-muted-foreground">
                        — {r.error}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">— posted</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Inline panel rendered under an Evolution number's action toolbar.
// Loads the live settings (rejectCall + msgCall) from Evolution, lets
// the operator toggle auto-reject and set a custom auto-reply text,
// and PUTs back on Save. We don't cache locally — first paint waits on
// the GET so the toggle's initial state always matches the source.
function EvolutionCallSettingsPanel({ instanceName }: { instanceName: string }) {
  const [loading, setLoading] = useState(true);
  const [rejectCall, setRejectCall] = useState(false);
  const [msgCall, setMsgCall] = useState("");
  const [originalRejectCall, setOriginalRejectCall] = useState(false);
  const [originalMsgCall, setOriginalMsgCall] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/evolution/instances/${encodeURIComponent(instanceName)}/settings`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.settings) {
          setRejectCall(!!j.settings.rejectCall);
          setMsgCall(j.settings.msgCall ?? "");
          setOriginalRejectCall(!!j.settings.rejectCall);
          setOriginalMsgCall(j.settings.msgCall ?? "");
        } else if (j?.error) {
          setErr(j.error);
        }
      })
      .catch((e) =>
        setErr(e instanceof Error ? e.message : "Failed to load settings"),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceName]);

  const dirty = rejectCall !== originalRejectCall || msgCall !== originalMsgCall;

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/evolution/instances/${encodeURIComponent(instanceName)}/settings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rejectCall, msgCall }),
        },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setOriginalRejectCall(rejectCall);
      setOriginalMsgCall(msgCall);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t bg-secondary/10 px-5 py-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <PhoneCall className="h-3.5 w-3.5 text-indigo-600" />
        <span className="font-semibold">Call handling</span>
        <span className="text-muted-foreground">
          · Baileys can&apos;t place calls — only reject incoming ones.
        </span>
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={rejectCall}
              onChange={(e) => setRejectCall(e.target.checked)}
              disabled={saving}
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            <span className="font-medium">Auto-reject all incoming calls</span>
          </label>
          {rejectCall ? (
            <div className="ml-5 space-y-1">
              <label className="block text-[11px] text-muted-foreground">
                Auto-reply text (sent right after the reject — leave blank for none)
              </label>
              <input
                type="text"
                value={msgCall}
                onChange={(e) => setMsgCall(e.target.value)}
                placeholder="Sorry, calls aren't supported on this number. Please send a message."
                maxLength={500}
                disabled={saving}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </div>
          ) : null}
          {err ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {err}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </button>
            {savedAt ? (
              <span className="text-[11px] font-semibold text-emerald-700">Saved</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// Cross-number "Recent statuses" panel — shown above the Unofficial
// number list so the operator can see at a glance which status went out
// on which number, without opening each row's Post Status modal. Pulls
// from /api/evolution/status?all=1 which joins through business_numbers
// for the label.
function RecentStatusesAcrossNumbers() {
  interface CrossPost {
    id: string;
    business_phone_number_id: string;
    number_label: string;
    type: "text" | "image" | "video" | "audio";
    content_preview: string | null;
    media_url: string | null;
    background_color: string | null;
    posted_at: string;
    expires_at: string;
    posted_by_email: string | null;
    wa_message_id: string | null;
    seen_count: number;
    last_views_synced_at: string | null;
  }
  type Range = "24h" | "7d" | "30d" | "all";
  const RANGES: Array<{ key: Range; label: string }> = [
    { key: "24h", label: "24h" },
    { key: "7d", label: "7 days" },
    { key: "30d", label: "30 days" },
    { key: "all", label: "All" },
  ];
  const [posts, setPosts] = useState<CrossPost[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState<Range>("7d");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/evolution/status?all=1&range=${range}`, {
          cache: "no-store",
        });
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setErr((j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
          setPosts([]);
          return;
        }
        setErr(null);
        setPosts(((j as { posts?: CrossPost[] } | null)?.posts) ?? []);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Network error");
        setPosts([]);
      }
    };
    void load();
    // Light refresh every 30s so posts made elsewhere bubble up here too.
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tick, range]);

  // Background view-count refresh — fire once when the panel renders
  // visible posts, so seen_count is fresh without forcing the operator
  // to click anything. Best-effort; failure is silent.
  async function syncViews() {
    if (syncing) return;
    setSyncing(true);
    try {
      await fetch("/api/evolution/status/refresh-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setTick((t) => t + 1);
    } catch {
      /* silent */
    } finally {
      setSyncing(false);
    }
  }
  useEffect(() => {
    // Auto-refresh views every 90s while the panel is mounted, plus
    // once on first load — keeps "seen X" numbers within ~1.5 min of
    // reality without spamming Evolution.
    void syncViews();
    const t = setInterval(() => void syncViews(), 90_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deletePost(id: string) {
    if (!window.confirm("Delete this status everywhere? This can't be undone.")) {
      return;
    }
    // Optimistic remove so the UI feels snappy.
    setPosts((cur) => (cur ?? []).filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/evolution/status/${id}`, {
        method: "DELETE",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j as { error?: string }).error ?? `Delete failed`);
        setTick((t) => t + 1);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setTick((t) => t + 1);
    }
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <CircleDot className="h-3.5 w-3.5" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">
              Recent statuses
            </p>
            <p className="text-[11px] text-muted-foreground">
              {RANGES.find((r) => r.key === range)?.label} · across all unofficial numbers
              {posts ? ` · ${posts.length}` : ""}
            </p>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {collapsed ? "Expand" : "Collapse"}
        </span>
      </button>

      {!collapsed ? (
        <div className="flex items-center justify-between gap-2 border-t bg-secondary/20 px-5 py-2">
          <div className="inline-flex overflow-hidden rounded-full border bg-card p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setRange(r.key);
                }}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition",
                  range === r.key
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void syncViews();
            }}
            disabled={syncing}
            className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-secondary disabled:opacity-50"
            title="Pull the latest seen-by count from WhatsApp"
          >
            {syncing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh views
          </button>
        </div>
      ) : null}
      {!collapsed ? (
        <div className="border-t px-5 py-3">
          {err ? (
            <div className="mb-2 rounded-md border border-rose-200 bg-rose-50/60 px-2.5 py-1.5 text-[11px] text-rose-800">
              {err}
              {err.toLowerCase().includes("relation") ||
              err.toLowerCase().includes("does not exist") ? (
                <span className="ml-1">
                  · Run migration <code className="font-mono">0041_evolution_status_posts.sql</code>{" "}
                  on Supabase.
                </span>
              ) : null}
            </div>
          ) : null}
          {posts === null ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : posts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No statuses in this range.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {posts.map((p) => {
                const ageMin = Math.max(
                  0,
                  Math.floor((Date.now() - new Date(p.posted_at).getTime()) / 60000),
                );
                const ageLabel =
                  ageMin < 1
                    ? "just now"
                    : ageMin < 60
                      ? `${ageMin}m ago`
                      : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 rounded-md border bg-secondary/30 px-2 py-1.5 text-[11px]"
                  >
                    <span
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded ring-1 ring-inset ring-border"
                      style={
                        p.type === "text"
                          ? {
                              backgroundColor: p.background_color ?? "#075E54",
                              color: "white",
                            }
                          : undefined
                      }
                    >
                      {p.type === "text" ? (
                        <span className="text-[10px] font-bold">Aa</span>
                      ) : p.type === "image" && p.media_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.media_url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <CircleDot className="h-4 w-4 text-muted-foreground" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-semibold text-foreground">
                          {p.number_label}
                        </span>
                        <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                          {p.type}
                        </span>
                      </div>
                      <p className="truncate text-muted-foreground">
                        {p.content_preview ||
                          (p.type === "image"
                            ? "Image status"
                            : p.type === "video"
                              ? "Video status"
                              : p.type === "audio"
                                ? "Audio status"
                                : "Status")}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {ageLabel}
                        {p.posted_by_email ? ` · ${p.posted_by_email}` : ""}
                      </p>
                    </div>
                    {/* Seen-by chip — viewer count from Evolution's READ
                        receipts (refresh-views endpoint). WhatsApp only
                        reports status viewers when the number's "Read
                        receipts" privacy setting is ON; when it's off no
                        receipts ever arrive, so we show "—" (not tracked)
                        instead of a misleading "0". A real count goes
                        emerald. */}
                    <span
                      title={
                        p.seen_count > 0
                          ? p.last_views_synced_at
                            ? `${p.seen_count} viewed · last synced ${new Date(p.last_views_synced_at).toLocaleString()}`
                            : `${p.seen_count} viewed`
                          : "No view data. WhatsApp only reports status viewers when this number's Read receipts setting is ON (WhatsApp → Settings → Privacy → Read receipts)."
                      }
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                        p.seen_count > 0
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : "bg-secondary text-muted-foreground ring-border",
                      )}
                    >
                      <Eye className="h-2.5 w-2.5" />
                      {p.seen_count > 0 ? p.seen_count.toLocaleString("en-IN") : "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => deletePost(p.id)}
                      title="Delete this status (revokes on WhatsApp too)"
                      aria-label="Delete status"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-50 hover:text-rose-700"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// One-click bulk-borrow: routes every Meta number's profile-pic
// lookup through the first online Evolution instance and caches the
// returned WhatsApp CDN URL. Meta Cloud API doesn't expose pics at
// all, so without this Meta number rows always render initials —
// even when the same operator already has an Evolution number that
// CAN fetch them.
function RefreshMetaPicsButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function go() {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch(
        "/api/business-numbers/refresh-via-evolution",
        { method: "POST" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        checked?: number;
        updated?: number;
        error?: string;
      };
      if (!res.ok) {
        setFlash(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setFlash(
        `Checked ${j.checked ?? 0} · updated ${j.updated ?? 0}`,
      );
      onDone();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground shadow-sm transition hover:bg-secondary disabled:opacity-50"
        title="Borrow profile pictures for Meta numbers via a connected Evolution instance (Meta Cloud API doesn't expose them)"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {busy ? "Borrowing pics…" : "Borrow Meta pics"}
      </button>
      {flash ? (
        <span className="absolute top-full right-0 mt-1 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-[10px] text-foreground shadow-sm">
          {flash}
        </span>
      ) : null}
    </div>
  );
}

// Re-register the webhook (URL + full event list + enabled) on every
// Evolution number in one click. The repair for "connected but not live-
// syncing": Evolution persists a stale webhook URL across a domain change
// or drops it on restart, and nothing re-verifies it server-side. Safe to
// re-run.
function RepairEvolutionWebhooksButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function go() {
    if (busy) return;
    if (
      !confirm(
        "Re-apply webhooks to all unofficial (Evolution) numbers? Fixes numbers that show connected but aren't receiving live messages. Safe to re-run.",
      )
    ) {
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/evolution/refresh-all-webhooks", {
        method: "POST",
      });
      const j = (await res.json().catch(() => ({}))) as {
        total?: number;
        repaired?: number;
        failed?: number;
        error?: string;
      };
      if (!res.ok) {
        setFlash(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setFlash(
        `Re-applied to ${j.repaired ?? 0}/${j.total ?? 0}${
          (j.failed ?? 0) > 0 ? ` · ${j.failed} failed` : ""
        }`,
      );
      onDone();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground shadow-sm transition hover:bg-secondary disabled:opacity-50"
        title="Re-register the webhook (URL + events) on every Evolution number. Fixes unofficial numbers that connected but stopped receiving live messages."
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {busy ? "Repairing sync…" : "Repair sync"}
      </button>
      {flash ? (
        <span className="absolute top-full right-0 mt-1 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-[10px] text-foreground shadow-sm">
          {flash}
        </span>
      ) : null}
    </div>
  );
}

// Run sync-history for every Evolution instance in one click. Sequential
// (not parallel) so we don't hammer Evolution's API or overwhelm the
// Postgres connection pool. Reports per-instance progress + a final
// summary; on failure for one instance, keeps going through the rest.
function SyncAllUnofficialButton({
  instances,
  onDone,
}: {
  instances: string[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    if (
      !confirm(
        `Sync history for all ${instances.length} unofficial numbers? Safe to re-run — duplicates skipped.`,
      )
    ) {
      return;
    }
    setBusy(true);
    let totalIngested = 0;
    let failures = 0;
    for (let i = 0; i < instances.length; i += 1) {
      const inst = instances[i];
      setProgress(`Syncing ${i + 1}/${instances.length}: ${inst}`);
      try {
        const res = await fetch(
          `/api/evolution/instances/${encodeURIComponent(inst)}/sync-history`,
          { method: "POST" },
        );
        const j = (await res.json()) as { ingested?: number; error?: string };
        if (!res.ok) {
          failures += 1;
          continue;
        }
        totalIngested += j.ingested ?? 0;
      } catch {
        failures += 1;
      }
    }
    setProgress(
      `Done. Ingested ${totalIngested.toLocaleString("en-IN")} messages${
        failures > 0 ? ` · ${failures} failed` : ""
      }.`,
    );
    setBusy(false);
    onDone();
    setTimeout(() => setProgress(null), 8000);
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-sm transition",
          busy
            ? "cursor-wait border-teal-200 bg-teal-50 text-teal-700"
            : "border-teal-200 bg-white text-teal-700 hover:bg-teal-50",
        )}
        title="Pull Evolution's stored chats + messages into the local inbox for every unofficial number"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Sync all unofficial
      </button>
      {progress ? (
        // z-50 so the popover sits above the stats chips row beneath
        // the header. bg-popover + ring give a proper opaque surface so
        // the chips don't bleed through and look overlapped.
        <span className="absolute top-full right-0 z-50 mt-1 whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-[10px] font-medium text-popover-foreground shadow-lg ring-1 ring-border">
          {progress}
        </span>
      ) : null}
    </span>
  );
}

// Pulls every message Evolution has persisted for this instance into our
// Supabase. Use this when Baileys' one-shot history broadcast didn't
// reach our webhook in time (e.g. the instance was created or the user
// scanned the QR before our webhook subscription list included
// MESSAGING_HISTORY_SET). Idempotent — re-running can only add missing
// messages, never duplicate.
function SyncHistoryButton({ instanceName }: { instanceName: string }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    if (
      !confirm(
        "Pull all chats Evolution already has for this number into the inbox?\nSafe to re-run — duplicates are skipped automatically.",
      )
    ) {
      return;
    }
    setBusy(true);
    setFlash("Syncing… this can take a minute.");
    try {
      const res = await fetch(
        `/api/evolution/instances/${encodeURIComponent(instanceName)}/sync-history`,
        { method: "POST" },
      );
      const j = (await res.json()) as {
        ingested?: number;
        evolution_total?: number;
        pages_fetched?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setFlash(
        `Synced ${j.ingested ?? 0} messages (${j.pages_fetched ?? 0} pages).`,
      );
      // Inbox list polls every 4s — operator will see chats land within
      // seconds without needing a full refresh.
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition",
          busy
            ? "cursor-wait border-teal-200 bg-teal-50 text-teal-700"
            : "border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100",
        )}
        title="Pull Evolution's stored history into the inbox"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
        Sync history
      </button>
      {flash ? (
        <span className="absolute top-full left-0 z-50 mt-1 whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-[10px] font-medium text-popover-foreground shadow-lg ring-1 ring-border">
          {flash}
        </span>
      ) : null}
    </span>
  );
}

// =====================================================================
// Evolution group filter strip — pill row above the unofficial cards.
// Each pill represents an operator-defined cluster (Delhi / Noida /
// Haridwar clinic…). Owner/superadmin also sees a "Manage" button that
// opens the CRUD modal.
// =====================================================================
function EvolutionGroupFilterStrip({
  groups,
  numbers,
  active,
  onChange,
  canEdit,
  onManage,
}: {
  groups: EvolutionGroup[];
  numbers: NumberRow[];
  active: string;
  onChange: (next: string) => void;
  canEdit: boolean;
  onManage: () => void;
}) {
  const ungroupedCount = numbers.filter((n) => !n.evolution_group_id).length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <MapPin className="h-3 w-3" />
        Group:
      </span>
      <GroupPill
        label={`All · ${numbers.length}`}
        active={active === "all"}
        onClick={() => onChange("all")}
      />
      <GroupPill
        label={`Ungrouped · ${ungroupedCount}`}
        active={active === "ungrouped"}
        onClick={() => onChange("ungrouped")}
        tone="amber"
      />
      {groups.map((g) => (
        <GroupPill
          key={g.id}
          label={`${g.name} · ${g.number_count}`}
          active={active === g.id}
          onClick={() => onChange(g.id)}
        />
      ))}
      {canEdit ? (
        <button
          type="button"
          onClick={onManage}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50"
          title="Add, rename or delete location groups"
        >
          <Settings className="h-3 w-3" />
          Manage groups
        </button>
      ) : null}
    </div>
  );
}

function GroupPill({
  label,
  active,
  onClick,
  tone = "emerald",
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "emerald" | "amber";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset transition",
        active
          ? tone === "amber"
            ? "bg-amber-500 text-white ring-amber-500"
            : "bg-emerald-600 text-white ring-emerald-600"
          : tone === "amber"
            ? "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100"
            : "bg-white text-foreground ring-border hover:bg-secondary",
      )}
    >
      {label}
    </button>
  );
}

// =====================================================================
// Manage-groups modal — CRUD over /api/evolution-groups. Owner /
// superadmin only (read-only members never see the trigger).
// =====================================================================
function EvolutionGroupsManagerModal({
  groups,
  onClose,
  onChanged,
}: {
  groups: EvolutionGroup[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/evolution-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNewName("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <MapPin className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Location groups</h3>
              <p className="text-[11px] text-muted-foreground">
                Cluster unofficial numbers by clinic / city.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Delhi clinic"
              maxLength={60}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy || !newName.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderPlus className="h-3 w-3" />}
              Add
            </button>
          </div>
          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {err}
            </div>
          ) : null}

          <div className="max-h-72 space-y-1.5 overflow-auto rounded-lg border bg-secondary/30 p-2">
            {groups.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No groups yet. Add one above.
              </p>
            ) : (
              groups.map((g) => (
                <EvolutionGroupRow key={g.id} group={g} onChanged={onChanged} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EvolutionGroupRow({
  group,
  onChanged,
}: {
  group: EvolutionGroup;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleRename() {
    const name = draft.trim();
    if (!name || name === group.name) {
      setEditing(false);
      setDraft(group.name);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/evolution-groups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: group.id, name }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/evolution-groups?id=${encodeURIComponent(group.id)}`,
        { method: "DELETE" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md bg-card px-2.5 py-2 ring-1 ring-inset ring-border">
      <div className="flex items-center gap-2">
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={60}
            autoFocus
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(group.name);
              }
            }}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {group.name}
          </span>
        )}
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {group.number_count} {group.number_count === 1 ? "number" : "numbers"}
        </span>
        {editing ? (
          <>
            <button
              type="button"
              onClick={handleRename}
              disabled={busy}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              aria-label="Save"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(group.name);
                setErr(null);
              }}
              disabled={busy}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
              aria-label="Cancel"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
              aria-label="Rename"
              title="Rename"
            >
              <Edit3 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
      {err ? (
        <p className="mt-1.5 text-[11px] text-destructive">{err}</p>
      ) : null}
      {confirmDelete ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
          <span className="flex-1">
            Delete &ldquo;{group.name}&rdquo;? Numbers in it fall back to Ungrouped.
          </span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="rounded-md bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
            className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-semibold hover:bg-secondary"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

// =====================================================================
// Per-card group picker — small dropdown on each Evolution number card.
// Owner / superadmin can re-assign; read-only members see the current
// group as a flat label.
// =====================================================================
function EvolutionGroupPicker({
  number,
  groups,
  canEdit,
  onUpdated,
}: {
  number: NumberRow;
  groups: EvolutionGroup[];
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = number.evolution_group_id
    ? groups.find((g) => g.id === number.evolution_group_id) ?? null
    : null;
  const label = current?.name ?? "Ungrouped";

  async function assign(groupId: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/business-numbers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: number.phone_number_id,
          evolution_group_id: groupId,
        }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOpen(false);
      onUpdated();
    } catch {
      /* swallow — picker stays open so user can retry */
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
          current
            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
            : "bg-secondary text-muted-foreground ring-border",
        )}
      >
        <MapPin className="h-3 w-3" />
        {label}
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset transition",
          current
            ? "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100"
            : "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100",
        )}
        title="Change location group"
      >
        <MapPin className="h-3 w-3" />
        {label}
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ChevronDown className="h-3 w-3 opacity-70" />
        )}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="absolute right-0 z-40 mt-1 w-48 overflow-hidden rounded-lg border bg-popover shadow-lg ring-1 ring-border">
            <button
              type="button"
              onClick={() => assign(null)}
              className={cn(
                "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-secondary",
                !current && "bg-secondary/60 font-semibold",
              )}
            >
              <span>Ungrouped</span>
              {!current ? <Check className="h-3 w-3" /> : null}
            </button>
            {groups.length === 0 ? (
              <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                No groups yet. Use &ldquo;Manage groups&rdquo; above.
              </p>
            ) : (
              <div className="border-t">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => assign(g.id)}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-secondary",
                      current?.id === g.id && "bg-secondary/60 font-semibold",
                    )}
                  >
                    <span className="truncate">{g.name}</span>
                    {current?.id === g.id ? <Check className="h-3 w-3" /> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
