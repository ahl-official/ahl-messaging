"use client";

// /campaigns — list + create wizard + detail. Three internal "screens"
// driven by local state instead of a sub-router so the create flow can
// keep its in-progress state when the user pops back to the list.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Download,
  Eye,
  GitBranch,
  IndianRupee,
  Inbox,
  LayoutGrid,
  List,
  Loader2,
  Megaphone,
  Pause,
  Phone,
  Play,
  Plus,
  Reply,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import {
  estimateCampaignCostInr,
  rateForCategory,
  CATEGORY_LABEL,
} from "@/lib/campaign-cost";
import { usePhoneMasker, useNameOrPhoneMasker } from "@/components/PermissionsContext";
import { AiAssistButton } from "@/components/AiAssistButton";
import { SearchableMultiSelect } from "@/components/SearchableMultiSelect";
import { PremiumHeader } from "@/components/PremiumHeader";
import { DripBuilder, DripsList } from "@/components/DripBuilder";
import {
  LSQ_DEFAULT_STAGES,
  LSQ_DEFAULT_SOURCES,
  LSQ_DEFAULT_SUB_SOURCES,
  mergeWithDefaults,
} from "@/lib/lsq-defaults";

interface Campaign {
  id: string;
  name: string;
  type: "template" | "magic_message";
  status: "draft" | "scheduled" | "sending" | "completed" | "canceled" | "failed";
  business_phone_number_id: string;
  template_name: string | null;
  template_language: string | null;
  template_body_preview: string | null;
  magic_prompt: string | null;
  magic_tone: string | null;
  schedule_at: string | null;
  rate_limit_per_minute: number;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
  unsubscribed_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface CostBucket {
  sent: number;
  cost: number;
}
interface NumberCost {
  bpid: string;
  label: string;
  phone: string | null;
  utility: CostBucket;
  marketing: CostBucket;
  authentication: CostBucket;
  total_cost: number;
}
interface CostSummary {
  utility: CostBucket;
  marketing: CostBucket;
  authentication: CostBucket;
  total_cost: number;
  by_number: NumberCost[];
  rates: Record<string, number>;
}

interface Recipient {
  id: string;
  wa_id: string;
  display_name: string | null;
  status: string;
  variables: Record<string, string>;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  failed_reason: string | null;
  error_code: string | null;
  generated_text: string | null;
  reply_text: string | null;
  button_clicked: string | null;
  button_clicked_at: string | null;
  lead_number?: string | null;
}

interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
}

const STATUS_TONE: Record<Campaign["status"], string> = {
  draft: "bg-secondary text-foreground/70 ring-border",
  scheduled: "bg-amber-50 text-amber-800 ring-amber-200",
  sending: "bg-sky-50 text-sky-800 ring-sky-200",
  completed: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  canceled: "bg-secondary text-muted-foreground ring-border",
  failed: "bg-rose-50 text-rose-800 ring-rose-200",
};

const STATUS_LABEL: Record<Campaign["status"], string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  completed: "Completed",
  canceled: "Canceled",
  failed: "Failed",
};

export function CampaignsView() {
  const [view, setView] = useState<
    | { kind: "list" }
    | { kind: "choose" }
    | { kind: "create" }
    | { kind: "drip"; editId?: string }
    | { kind: "drips" }
    | { kind: "recurring" }
    | { kind: "cost" }
    | { kind: "detail"; id: string }
  >({
    kind: "list",
  });

  if (view.kind === "cost") {
    return <CostByNumberPage onBack={() => setView({ kind: "list" })} />;
  }
  if (view.kind === "drips") {
    return (
      <DripsList
        onBack={() => setView({ kind: "list" })}
        onNew={() => setView({ kind: "drip" })}
        onEdit={(id) => setView({ kind: "drip", editId: id })}
      />
    );
  }
  if (view.kind === "recurring") {
    return <RecurringList onBack={() => setView({ kind: "list" })} />;
  }
  if (view.kind === "choose") {
    return (
      <CreateChooser
        onClose={() => setView({ kind: "list" })}
        onPick={(k) => setView({ kind: k === "drip" ? "drip" : "create" })}
      />
    );
  }
  if (view.kind === "create") {
    return <CreateWizard onClose={() => setView({ kind: "list" })} onCreated={(id) => setView({ kind: "detail", id })} />;
  }
  if (view.kind === "drip") {
    return <DripBuilder onClose={() => setView({ kind: "drips" })} editId={view.editId} />;
  }
  if (view.kind === "detail") {
    return <CampaignDetail id={view.id} onBack={() => setView({ kind: "list" })} />;
  }
  return (
    <CampaignsList
      onCreate={() => setView({ kind: "choose" })}
      onOpen={(id) => setView({ kind: "detail", id })}
      onOpenCost={() => setView({ kind: "cost" })}
      onOpenDrips={() => setView({ kind: "drips" })}
      onOpenRecurring={() => setView({ kind: "recurring" })}
    />
  );
}

// ---------------------------------------------------------------------------
// CREATE CHOOSER — "New campaign" first asks blast vs drip.
// ---------------------------------------------------------------------------
function CreateChooser({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (kind: "campaign" | "drip") => void;
}) {
  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <header className="relative overflow-hidden border-b bg-gradient-to-br from-emerald-700 via-emerald-800 to-slate-900 text-white">
        <div className="relative mx-auto max-w-3xl px-6 py-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white ring-1 ring-white/20 transition hover:bg-white/20"
              aria-label="Close"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">What do you want to create?</h1>
              <p className="mt-0.5 text-xs text-white/80">
                One-time blast, ya lead stage ke hisaab se auto drip sequence.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-2">
          <ChooserCard
            icon={Megaphone}
            tone="emerald"
            title="Campaign"
            sub="Ek baar ka blast — approved template ya AI magic message ek segment ko bhejo. Live delivery / read / reply analytics."
            onSelect={() => onPick("campaign")}
          />
          <ChooserCard
            icon={GitBranch}
            tone="violet"
            title="Drip campaign"
            sub="Lead stage trigger pe multi-step sequence — har step pichle ke kuch din baad auto-send. Stage badle to ruk jaye."
            onSelect={() => onPick("drip")}
          />
        </div>
      </div>
    </div>
  );
}

function ChooserCard({
  icon: Icon,
  tone,
  title,
  sub,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "emerald" | "violet";
  title: string;
  sub: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex h-full flex-col items-start gap-3 rounded-2xl border bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg",
        tone === "emerald" ? "hover:border-emerald-300" : "hover:border-violet-300",
      )}
    >
      <span
        className={cn(
          "inline-flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset",
          tone === "emerald"
            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
            : "bg-violet-50 text-violet-700 ring-violet-200",
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <div className="text-base font-semibold">{title}</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sub}</p>
      </div>
      <span
        className={cn(
          "mt-auto inline-flex items-center gap-1 text-xs font-semibold transition group-hover:gap-1.5",
          tone === "emerald" ? "text-emerald-700" : "text-violet-700",
        )}
      >
        Continue
        <Plus className="h-3.5 w-3.5 transition group-hover:rotate-90" />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
function CampaignsList({
  onCreate,
  onOpen,
  onOpenCost,
  onOpenDrips,
  onOpenRecurring,
}: {
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenCost: () => void;
  onOpenDrips: () => void;
  onOpenRecurring: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "completed" | "draft">("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/campaigns", { cache: "no-store" });
      const json = (await res.json()) as {
        campaigns?: Campaign[];
        cost_summary?: CostSummary;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCampaigns(json.campaigns ?? []);
      setCost(json.cost_summary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  // Poll faster (2s) while any campaign is sending so the live counters
  // feel responsive; idle list backs off to 5s.
  const anyLive = campaigns?.some((c) => c.status === "sending") ?? false;
  useEffect(() => {
    load();
    const t = setInterval(load, anyLive ? 2000 : 5000);
    return () => clearInterval(t);
  }, [anyLive]);

  const summary = useMemo(() => {
    if (!campaigns) return null;
    const active = campaigns.filter((c) => ["scheduled", "sending"].includes(c.status));
    return {
      total: campaigns.length,
      active: active.length,
      sent: campaigns.reduce((s, c) => s + c.sent_count, 0),
      replied: campaigns.reduce((s, c) => s + c.replied_count, 0),
    };
  }, [campaigns]);

  const filtered = useMemo(() => {
    if (!campaigns) return null;
    return campaigns.filter((c) => {
      if (filter === "active" && !["scheduled", "sending"].includes(c.status)) return false;
      if (filter === "completed" && c.status !== "completed") return false;
      if (filter === "draft" && c.status !== "draft") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [campaigns, filter, search]);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={Megaphone}
        title="Campaigns"
        subtitle="Approved templates + AI-personalized blasts · live delivery / read / reply analytics."
        tone="emerald"
        badges={
          <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ring-1 ring-white/25 backdrop-blur">
            <Sparkles className="h-3 w-3" /> Live
          </span>
        }
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenRecurring}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-2 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
            >
              <Clock className="h-3.5 w-3.5" />
              Daily campaigns
            </button>
            <button
              type="button"
              onClick={onOpenDrips}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-2 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Drip campaigns
            </button>
            <button
              type="button"
              onClick={onCreate}
              className="group inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-emerald-800 shadow-lg shadow-emerald-900/25 ring-1 ring-white/40 transition hover:shadow-xl active:scale-[0.98]"
            >
              <Plus className="h-3.5 w-3.5 transition group-hover:rotate-90" />
              New campaign
            </button>
          </div>
        }
        below={
          summary ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <HeroStat label="Total campaigns" value={summary.total} icon={Megaphone} />
              <HeroStat label="Active now" value={summary.active} icon={Send} highlight={summary.active > 0} />
              <HeroStat label="Messages sent" value={summary.sent} icon={Check} />
              <HeroStat label="Replies received" value={summary.replied} icon={Reply} />
              <HeroStat
                label="Utility cost"
                value={cost?.utility.cost ?? 0}
                display={fmtInr(cost?.utility.cost ?? 0)}
                sub={`${(cost?.utility.sent ?? 0).toLocaleString()} msgs · est.`}
                icon={IndianRupee}
                onClick={cost ? onOpenCost : undefined}
              />
              <HeroStat
                label="Marketing cost"
                value={cost?.marketing.cost ?? 0}
                display={fmtInr(cost?.marketing.cost ?? 0)}
                sub={`${(cost?.marketing.sent ?? 0).toLocaleString()} msgs · est.`}
                icon={IndianRupee}
                onClick={cost ? onOpenCost : undefined}
              />
              <HeroStat
                label="Total cost"
                value={cost?.total_cost ?? 0}
                display={fmtInr(cost?.total_cost ?? 0)}
                sub="all numbers · est."
                icon={IndianRupee}
                highlight
                onClick={cost ? onOpenCost : undefined}
              />
            </div>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
          {/* Filter + search */}
          {campaigns && campaigns.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm">
              <div className="flex items-center gap-1">
                {(["all", "active", "draft", "completed"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                      filter === f
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex max-w-xs flex-1 items-center gap-2 rounded-md border bg-background px-2.5">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search campaigns…"
                  className="h-8 w-full bg-transparent text-xs outline-none"
                />
              </div>
              {/* Grid / list view toggle (like a file explorer). */}
              <div className="flex items-center gap-0.5 rounded-md border bg-background p-0.5">
                <button
                  type="button"
                  onClick={() => setView("grid")}
                  title="Grid view"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded transition",
                    view === "grid" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setView("list")}
                  title="List view"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded transition",
                    view === "list" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {campaigns === null ? (
            <SkeletonList />
          ) : campaigns.length === 0 ? (
            <EmptyState onCreate={onCreate} />
          ) : filtered && filtered.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
              No campaigns match your filter.
            </div>
          ) : view === "list" ? (
            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <ul className="divide-y">
                {(filtered ?? []).map((c) => (
                  <li key={c.id}>
                    <CampaignRow campaign={c} onOpen={() => onOpen(c.id)} onChanged={load} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {(filtered ?? []).map((c) => (
                <li key={c.id}>
                  <CampaignCard campaign={c} onOpen={() => onOpen(c.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  display,
  sub,
  icon: Icon,
  highlight,
  onClick,
}: {
  label: string;
  value: number;
  display?: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-xl border bg-white/10 px-4 py-3 text-left backdrop-blur-sm ring-1 ring-white/15 transition",
        highlight && "ring-2 ring-amber-300/60 bg-amber-300/10",
        onClick && "cursor-pointer hover:bg-white/20 hover:ring-white/40 active:scale-[0.98]",
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/85">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {display ?? value.toLocaleString()}
      </div>
      {sub ? <div className="text-[10px] font-medium text-white/70">{sub}</div> : null}
    </Tag>
  );
}

// Dedicated full-page cost breakdown — opened from the Total/Utility/Marketing
// cost tiles. Every outbound template send (magic, campaign, welcome, LSQ),
// per WhatsApp number, split by category. Cloud numbers only (evo/interakt
// don't bill through Meta).
function CostByNumberPage({ onBack }: { onBack: () => void }) {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/campaigns", { cache: "no-store" });
        const json = (await res.json()) as { cost_summary?: CostSummary; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (alive) setCost(json.cost_summary ?? null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const totalMsgs =
    (cost?.utility.sent ?? 0) + (cost?.marketing.sent ?? 0) + (cost?.authentication.sent ?? 0);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={IndianRupee}
        title="Cost by number"
        subtitle="Estimated WhatsApp send-cost per number — all outbound template sends (magic, campaign, welcome, LSQ) by category."
        tone="emerald"
        right={
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        }
        below={
          cost ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <HeroStat
                label="Total cost"
                value={cost.total_cost}
                display={fmtInr(cost.total_cost)}
                sub={`${totalMsgs.toLocaleString()} msgs · est.`}
                icon={IndianRupee}
                highlight
              />
              <HeroStat
                label="Utility"
                value={cost.utility.cost}
                display={fmtInr(cost.utility.cost)}
                sub={`${cost.utility.sent.toLocaleString()} msgs`}
                icon={IndianRupee}
              />
              <HeroStat
                label="Marketing"
                value={cost.marketing.cost}
                display={fmtInr(cost.marketing.cost)}
                sub={`${cost.marketing.sent.toLocaleString()} msgs`}
                icon={IndianRupee}
              />
              <HeroStat
                label="Numbers"
                value={cost.by_number.length}
                icon={Megaphone}
              />
            </div>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : cost === null ? (
            <SkeletonList />
          ) : cost.by_number.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
              No billable template sends yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="hidden grid-cols-[1fr_repeat(3,minmax(0,140px))] gap-2 border-b bg-secondary/30 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
                <span>Number</span>
                <span className="text-right">Utility</span>
                <span className="text-right">Marketing</span>
                <span className="text-right">Total</span>
              </div>
              <ul className="divide-y">
                {cost.by_number.map((n) => (
                  <li
                    key={n.bpid}
                    className="grid grid-cols-2 gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_repeat(3,minmax(0,140px))] sm:gap-2"
                  >
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <div className="truncate font-medium">{n.label}</div>
                      {n.phone ? (
                        <div className="truncate text-[11px] text-muted-foreground">{n.phone}</div>
                      ) : null}
                    </div>
                    <CostCell label="Utility" bucket={n.utility} />
                    <CostCell label="Marketing" bucket={n.marketing} />
                    <div className="text-right sm:flex sm:flex-col sm:items-end sm:justify-center">
                      <span className="sm:hidden text-[10px] uppercase text-muted-foreground">Total </span>
                      <span className="font-semibold tabular-nums">
                        ₹{n.total_cost.toLocaleString("en-IN", { maximumFractionDigits: n.total_cost < 100 ? 2 : 0 })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CostCell({ label, bucket }: { label: string; bucket: CostBucket }) {
  return (
    <div className="text-right sm:flex sm:flex-col sm:items-end sm:justify-center">
      <span className="sm:hidden text-[10px] uppercase text-muted-foreground">{label} </span>
      <span className="tabular-nums">
        ₹{bucket.cost.toLocaleString("en-IN", { maximumFractionDigits: bucket.cost < 100 ? 2 : 0 })}
      </span>
      {bucket.sent > 0 ? (
        <span className="text-[10px] text-muted-foreground">{bucket.sent.toLocaleString()} msgs</span>
      ) : null}
    </div>
  );
}

// Compact one-line row for the list view (file-explorer style) with inline
// Stop / Delete actions.
function CampaignRow({
  campaign,
  onOpen,
  onChanged,
}: {
  campaign: Campaign;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isMagic = campaign.type === "magic_message";
  const TypeIcon = isMagic ? Sparkles : Send;
  const isActive = campaign.status === "sending" || campaign.status === "scheduled";
  const statusTint =
    campaign.status === "sending"
      ? "bg-sky-50 text-sky-700 ring-sky-200"
      : campaign.status === "completed"
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
        : campaign.status === "failed"
          ? "bg-rose-50 text-rose-700 ring-rose-200"
          : campaign.status === "canceled"
            ? "bg-amber-50 text-amber-700 ring-amber-200"
            : "bg-slate-100 text-slate-600 ring-slate-200";

  async function stop(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Stop "${campaign.name}"? Pending recipients will be skipped.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function del(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${campaign.name}" permanently? This removes it and its report.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/campaigns/${campaign.id}?purge=1`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const Num = ({ n, label, tint }: { n: number; label: string; tint?: string }) => (
    <span className="hidden w-14 flex-col items-end sm:flex">
      <span className={cn("text-sm font-bold tabular-nums leading-none", tint)}>{n.toLocaleString()}</span>
      <span className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">{label}</span>
    </span>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" ? onOpen() : null)}
      className="group flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-secondary/40"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <TypeIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{campaign.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={cn("rounded px-1.5 py-0.5 font-semibold uppercase ring-1 ring-inset", statusTint)}>
            {campaign.status}
          </span>
          <span>{isMagic ? "AI" : "Template"}</span>
          <span>· {campaign.sent_count}/{campaign.total_recipients} sent</span>
        </span>
      </span>

      <Num n={campaign.sent_count} label="Sent" tint="text-sky-700" />
      <Num n={campaign.delivered_count} label="Deliv." tint="text-emerald-700" />
      <Num n={campaign.read_count} label="Read" tint="text-emerald-800" />
      <Num n={campaign.replied_count} label="Repl." tint="text-violet-700" />
      <Num n={campaign.failed_count} label="Failed" tint={campaign.failed_count > 0 ? "text-rose-600" : "text-muted-foreground"} />

      {/* Actions */}
      <span className="ml-1 flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={stop}
          disabled={busy || !isActive}
          title={isActive ? "Stop campaign" : "Only a sending / scheduled campaign can be stopped"}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-200 px-2 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
        >
          <Pause className="h-3.5 w-3.5" /> Stop
        </button>
        <button
          type="button"
          onClick={del}
          disabled={busy}
          title="Delete campaign"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 px-2 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </span>
    </div>
  );
}

function CampaignCard({ campaign, onOpen }: { campaign: Campaign; onOpen: () => void }) {
  const isMagic = campaign.type === "magic_message";
  const TypeIcon = isMagic ? Sparkles : Send;
  const sentPct = campaign.total_recipients
    ? Math.round((campaign.sent_count / campaign.total_recipients) * 100)
    : 0;
  const replyRate = campaign.sent_count
    ? Math.round((campaign.replied_count / campaign.sent_count) * 100)
    : 0;
  const isLive = campaign.status === "sending";

  // Detect which numbers just bumped vs the previous poll snapshot. We
  // briefly tag those so the corresponding chip plays the bump
  // animation. The bump key changes (timestamp) to retrigger the
  // animation each time the value moves up.
  const prev = useRef({
    sent: campaign.sent_count,
    delivered: campaign.delivered_count,
    read: campaign.read_count,
    replied: campaign.replied_count,
    failed: campaign.failed_count,
    unsub: campaign.unsubscribed_count,
  });
  const [bumps, setBumps] = useState<Record<string, number>>({});
  useEffect(() => {
    const next: Record<string, number> = {};
    const now = Date.now();
    if (campaign.sent_count > prev.current.sent) next.sent = now;
    if (campaign.delivered_count > prev.current.delivered) next.delivered = now;
    if (campaign.read_count > prev.current.read) next.read = now;
    if (campaign.replied_count > prev.current.replied) next.replied = now;
    if (campaign.failed_count > prev.current.failed) next.failed = now;
    if (campaign.unsubscribed_count > prev.current.unsub) next.unsub = now;
    prev.current = {
      sent: campaign.sent_count,
      delivered: campaign.delivered_count,
      read: campaign.read_count,
      replied: campaign.replied_count,
      failed: campaign.failed_count,
      unsub: campaign.unsubscribed_count,
    };
    if (Object.keys(next).length > 0) setBumps((b) => ({ ...b, ...next }));
  }, [
    campaign.sent_count,
    campaign.delivered_count,
    campaign.read_count,
    campaign.replied_count,
    campaign.failed_count,
    campaign.unsubscribed_count,
  ]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card text-left shadow-sm transition",
        "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5",
        isLive && "campaign-live-glow border-sky-300",
      )}
    >
      {/* Gradient accent bar */}
      <span
        className={cn(
          "absolute inset-x-0 top-0 h-0.5",
          isMagic
            ? "bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500"
            : "bg-gradient-to-r from-emerald-500 to-emerald-700",
        )}
      />

      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Top row: icon + name + status */}
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
              isMagic
                ? "bg-violet-50 text-violet-700 ring-violet-200"
                : "bg-emerald-50 text-emerald-700 ring-emerald-200",
            )}
          >
            <TypeIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{campaign.name}</span>
              {isLive ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold ring-1 ring-inset",
                  STATUS_TONE[campaign.status],
                )}
              >
                {STATUS_LABEL[campaign.status]}
              </span>
              <span className="font-medium uppercase tracking-wide">
                {isMagic ? "Magic Message" : "Template"}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                {new Date(campaign.created_at).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </div>
          </div>
        </div>

        {/* Progress bar with percentage */}
        <div>
          <div className="mb-1 flex items-baseline justify-between text-[10px]">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">
              Sent
            </span>
            <span className="tabular-nums">
              <span
                key={bumps.sent ?? 0}
                className={cn(
                  "font-semibold text-foreground",
                  bumps.sent ? "campaign-bump" : "",
                )}
              >
                {campaign.sent_count.toLocaleString()}
              </span>
              <span className="text-muted-foreground"> / {campaign.total_recipients.toLocaleString()}</span>
              <span className="ml-1.5 font-semibold text-emerald-700">{sentPct}%</span>
            </span>
          </div>
          <div
            className={cn(
              "h-1.5 w-full overflow-hidden rounded-full bg-secondary",
              isLive && "campaign-shimmer-bar",
            )}
          >
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                campaign.status === "completed"
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-600"
                  : campaign.status === "failed" || campaign.status === "canceled"
                    ? "bg-gradient-to-r from-rose-400 to-rose-500"
                    : "bg-gradient-to-r from-sky-400 to-emerald-500",
              )}
              style={{ width: `${Math.max(2, sentPct)}%` }}
            />
          </div>
        </div>

        {/* Mini stat chips — full breakdown so operators don't need to
            open the detail page for the headline numbers */}
        <div className="grid grid-cols-3 gap-2 pt-1">
          <MiniStat
            icon={Check}
            label="Delivered"
            value={campaign.delivered_count}
            pct={campaign.sent_count ? Math.round((campaign.delivered_count / campaign.sent_count) * 100) : 0}
            bumpKey={bumps.delivered}
          />
          <MiniStat
            icon={Eye}
            label="Read"
            value={campaign.read_count}
            pct={campaign.sent_count ? Math.round((campaign.read_count / campaign.sent_count) * 100) : 0}
            bumpKey={bumps.read}
          />
          <MiniStat
            icon={Reply}
            label="Replied"
            value={campaign.replied_count}
            pct={replyRate}
            tone="primary"
            bumpKey={bumps.replied}
          />
          <MiniStat
            icon={X}
            label="Failed"
            value={campaign.failed_count}
            pct={campaign.total_recipients ? Math.round((campaign.failed_count / campaign.total_recipients) * 100) : 0}
            tone={campaign.failed_count > 0 ? "destructive" : undefined}
            bumpKey={bumps.failed}
          />
          <MiniStat
            icon={X}
            label="Unsub"
            value={campaign.unsubscribed_count}
            bumpKey={bumps.unsub}
          />
          <MiniStat
            icon={Clock}
            label="Pending"
            value={Math.max(
              0,
              campaign.total_recipients -
                campaign.sent_count -
                campaign.failed_count -
                campaign.unsubscribed_count,
            )}
          />
        </div>
      </div>
    </button>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  pct,
  tone,
  bumpKey,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  pct?: number;
  tone?: "primary" | "destructive";
  /** When this changes, the value animates a brief "bump". Pass a
   *  timestamp (or any monotonic id) from the parent's poll. */
  bumpKey?: number;
}) {
  const accent =
    tone === "destructive"
      ? "text-destructive"
      : tone === "primary"
        ? "text-primary"
        : "text-foreground";
  return (
    <div className="rounded-lg border bg-secondary/30 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-2.5 w-2.5" />
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          key={bumpKey ?? 0}
          className={cn(
            "text-sm font-semibold tabular-nums",
            accent,
            bumpKey ? "campaign-bump" : "",
          )}
        >
          {value.toLocaleString()}
        </span>
        {pct && pct > 0 ? (
          <span className="text-[9px] tabular-nums text-muted-foreground">{pct}%</span>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: "primary" | "destructive";
}) {
  const color =
    tone === "destructive"
      ? "text-destructive"
      : tone === "primary"
        ? "text-primary"
        : "text-foreground/80";
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tabular-nums", color)}>{value.toLocaleString()}</span>
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border-2 border-dashed bg-card/50 p-10 text-center">
      <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700">
        <Megaphone className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold">No campaigns yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Send a WhatsApp template to a tagged segment, or let AI personalize a message per recipient.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
      >
        <Plus className="h-3.5 w-3.5" />
        Create your first campaign
      </button>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-xl border bg-card shadow-sm" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CREATE WIZARD
// ---------------------------------------------------------------------------
type CampaignType = "template" | "magic_message";

function CreateWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [type, setType] = useState<CampaignType>("template");
  const [bpid, setBpid] = useState("");
  const [numbers, setNumbers] = useState<BusinessNumber[]>([]);

  // Template fields
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("en");
  const [templateBodyPreview, setTemplateBodyPreview] = useState("");
  // Static variable values typed in the UI — applied to every recipient
  // (a CSV column with the same name overrides per-recipient).
  const [varDefaults, setVarDefaults] = useState<Record<string, string>>({});

  // Magic message fields. Default seeds the {{name}} greeting so the
  // operator sees how variables are written without having to remember
  // the syntax. Presets / AI generate replace it; manual typing
  // continues from there.
  const [magicPrompt, setMagicPrompt] = useState("Hi {{name}},\n");
  const [magicTone, setMagicTone] = useState("warm, conversational, professional");

  // Recipients
  const [recipientsSource, setRecipientsSource] = useState<"all" | "tags" | "csv" | "lsq">("all");
  const [tagsInput, setTagsInput] = useState("");
  const [csvText, setCsvText] = useState("");
  // LSQ filter state
  const [lsqStages, setLsqStages] = useState<string[]>([]);
  const [lsqOwners, setLsqOwners] = useState<string[]>([]);
  const [lsqSources, setLsqSources] = useState<string[]>([]);
  const [lsqSubSources, setLsqSubSources] = useState<string[]>([]);
  const [lsqBrands, setLsqBrands] = useState<string[]>([]);
  const [lsqCreatedAfter, setLsqCreatedAfter] = useState<string>("");
  const [lsqCreatedBefore, setLsqCreatedBefore] = useState<string>("");
  // When the operator clicks "Fetch from LSQ", we cache the live pull
  // here and use it as the source instead of the local-cached filter.
  const [lsqDirectLeads, setLsqDirectLeads] = useState<Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null>(null);

  // Schedule + rate
  const [sendNow, setSendNow] = useState(true);
  const [scheduleAt, setScheduleAt] = useState("");
  // Recurring (dynamic) — re-run daily against the rolling LSQ filter.
  const [repeatDaily, setRepeatDaily] = useState(false);
  // Auto-pull on Continue (when the operator skips the manual "Fetch from LSQ").
  const [autoPulling, setAutoPulling] = useState(false);
  const [rateLimit, setRateLimit] = useState(30);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: BusinessNumber[] }) => {
        // Campaigns send approved templates — Meta-Cloud numbers (numeric id)
        // and Interakt numbers (interakt: prefix). Drop only Evolution.
        const list = (j.numbers ?? []).filter(
          (n) => /^\d+$/.test(n.phone_number_id) || n.phone_number_id.startsWith("interakt:"),
        );
        setNumbers(list);
        if (list[0]) setBpid(list[0].phone_number_id);
      })
      .catch(() => setNumbers([]));
  }, []);

  const canStep1 = name.trim().length > 0 && bpid.length > 0;
  const canStep2 =
    type === "template"
      ? templateName.trim().length > 0
      : magicPrompt.trim().length > 0;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      // Recurring (dynamic) campaign — re-runs daily against the rolling LSQ
      // filter, sends to NEW matches only. Distinct path from one-shot.
      if (repeatDaily) {
        if (recipientsSource !== "lsq") {
          throw new Error("Repeat daily ke liye recipients me 'From LSQ' filter chuno.");
        }
        if (type !== "template") {
          throw new Error("Repeat daily abhi sirf approved-template campaigns ke liye hai.");
        }
        // Rolling window = the date-range the operator picked (e.g. "Last 90
        // days" → 90). Each daily run re-pulls leads from (now − window) days.
        const afterMs = lsqCreatedAfter ? new Date(lsqCreatedAfter).getTime() : NaN;
        const beforeMs = lsqCreatedBefore ? new Date(lsqCreatedBefore).getTime() : Date.now();
        const windowDays = !isNaN(afterMs)
          ? Math.max(1, Math.min(365, Math.round((beforeMs - afterMs) / 86_400_000)))
          : 90;
        const res = await fetch("/api/recurring", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            business_phone_number_id: bpid,
            template_name: templateName.trim(),
            template_language: templateLanguage.trim() || "en",
            template_body_preview: templateBodyPreview.trim() || null,
            filter: {
              stages: lsqStages,
              owners: lsqOwners,
              sources: lsqSources,
              sub_sources: lsqSubSources,
              brands: lsqBrands,
            },
            window_days: windowDays,
            rate_limit_per_minute: rateLimit,
          }),
        });
        const j = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        onClose();
        return;
      }

      // 1. Create draft
      const createRes = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          business_phone_number_id: bpid,
          template_name: type === "template" ? templateName.trim() : undefined,
          template_language: type === "template" ? templateLanguage.trim() : undefined,
          template_body_preview: type === "template" ? templateBodyPreview.trim() : undefined,
          magic_prompt: type === "magic_message" ? magicPrompt.trim() : undefined,
          magic_tone: type === "magic_message" ? magicTone.trim() : undefined,
          schedule_at: sendNow ? null : new Date(scheduleAt).toISOString(),
          rate_limit_per_minute: rateLimit,
          quiet_hours_start: quietStart || null,
          quiet_hours_end: quietEnd || null,
        }),
      });
      const createJson = (await createRes.json()) as { campaign?: Campaign; error?: string };
      if (!createRes.ok || !createJson.campaign) {
        throw new Error(createJson.error ?? `Create failed (HTTP ${createRes.status})`);
      }
      const campaignId = createJson.campaign.id;

      // Static variable values typed in the UI — non-empty only. Merged
      // into every recipient (a CSV column of the same name overrides).
      const defaults = Object.fromEntries(
        Object.entries(varDefaults).filter(([, v]) => v.trim() !== ""),
      );

      // 2. Add recipients
      let recipientBody: Record<string, unknown>;
      if (recipientsSource === "csv") {
        const rows = parseCsv(csvText).map((r) => ({
          ...r,
          variables: { ...defaults, ...r.variables },
        }));
        recipientBody = { from: "csv", rows };
      } else if (recipientsSource === "tags") {
        const tags = tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (tags.length === 0) throw new Error("Add at least one tag");
        recipientBody = { from: "tags", tags, variable_defaults: defaults };
      } else if (recipientsSource === "lsq") {
        // If the operator pulled fresh leads from LSQ via "Fetch from
        // LSQ", send them as a CSV-style row list (the API path that
        // takes pre-resolved {wa_id, display_name} pairs).
        if (lsqDirectLeads && lsqDirectLeads.length > 0) {
          recipientBody = {
            from: "csv",
            rows: lsqDirectLeads.map((l) => ({
              wa_id: l.wa_id,
              display_name: l.display_name,
              variables: defaults,
            })),
          };
        } else {
          if (
            lsqStages.length === 0 &&
            lsqOwners.length === 0 &&
            lsqSources.length === 0 &&
            lsqSubSources.length === 0 &&
            !lsqCreatedAfter &&
            !lsqCreatedBefore
          ) {
            throw new Error("Pick at least one filter (stage / owner / source / date)");
          }
          recipientBody = {
            from: "lsq",
            lsq_stages: lsqStages,
            lsq_owners: lsqOwners,
            created_after: lsqCreatedAfter ? new Date(lsqCreatedAfter).toISOString() : undefined,
            created_before: lsqCreatedBefore ? new Date(lsqCreatedBefore).toISOString() : undefined,
            variable_defaults: defaults,
          };
        }
      } else {
        recipientBody = { from: "all", variable_defaults: defaults };
      }
      const recRes = await fetch(`/api/campaigns/${campaignId}/recipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recipientBody),
      });
      const recJson = (await recRes.json()) as { added?: number; error?: string; total_recipients?: number };
      if (!recRes.ok) throw new Error(recJson.error ?? "Failed to add recipients");
      if ((recJson.total_recipients ?? 0) === 0) {
        throw new Error("No recipients matched. Adjust filter or upload a CSV.");
      }

      // 3. Start
      const startRes = await fetch(`/api/campaigns/${campaignId}/start`, { method: "POST" });
      const startJson = (await startRes.json()) as { error?: string };
      if (!startRes.ok) throw new Error(startJson.error ?? "Failed to start");

      onCreated(campaignId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Pull LSQ leads from the current filter (same as the panel's "Fetch" button).
  async function pullLsqLeads() {
    setAutoPulling(true);
    try {
      const res = await fetch("/api/lsq/pull-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stages: lsqStages,
          owners: lsqOwners,
          sources: lsqSources,
          sub_sources: lsqSubSources,
          brands: lsqBrands,
          created_after: lsqCreatedAfter ? new Date(lsqCreatedAfter).toISOString() : undefined,
          created_before: lsqCreatedBefore ? new Date(lsqCreatedBefore).toISOString() : undefined,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        leads?: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }>;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setLsqDirectLeads(json.leads ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "LSQ fetch failed");
    } finally {
      setAutoPulling(false);
    }
  }

  // On reaching the Schedule step with an LSQ filter but no fetched leads yet
  // (operator skipped the manual "Fetch from LSQ"), auto-pull so they see the
  // recipient list + count without going back.
  useEffect(() => {
    if (step !== 4 || recipientsSource !== "lsq" || lsqDirectLeads !== null || autoPulling) return;
    const hasFilter =
      lsqStages.length > 0 ||
      lsqOwners.length > 0 ||
      lsqSources.length > 0 ||
      lsqSubSources.length > 0 ||
      lsqBrands.length > 0 ||
      !!lsqCreatedAfter ||
      !!lsqCreatedBefore;
    if (hasFilter) void pullLsqLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const steps = [
    { n: 1, label: "Basics", sub: "Name + type + source", icon: Megaphone },
    {
      n: 2,
      label: type === "magic_message" ? "AI brief" : "Template",
      sub: type === "magic_message" ? "Prompt + tone" : "Approved template + variables",
      icon: type === "magic_message" ? Sparkles : Send,
    },
    { n: 3, label: "Recipients", sub: "Tags / CSV / All", icon: Users },
    { n: 4, label: "Schedule", sub: "Timing + guard rails", icon: Clock },
  ];

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* Premium gradient hero with stepper */}
      <header className="relative overflow-hidden border-b bg-gradient-to-br from-emerald-700 via-emerald-800 to-slate-900 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 right-1/4 h-72 w-72 rounded-full bg-emerald-300/15 blur-3xl"
        />
        <div className="relative mx-auto max-w-3xl px-6 py-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => (step > 1 ? setStep(step - 1) : onClose())}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white ring-1 ring-white/20 transition hover:bg-white/20"
              aria-label={step > 1 ? "Previous step" : "Close"}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">New campaign</h1>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-white/25">
                  Step {step} of 4
                </span>
              </div>
              <p className="mt-0.5 text-xs text-white/80">
                {steps[step - 1].sub}
              </p>
            </div>
          </div>

          {/* Stepper */}
          <ol className="mt-5 grid grid-cols-4 gap-2">
            {steps.map((s) => {
              const StepIcon = s.icon;
              const isDone = step > s.n;
              const isActive = step === s.n;
              return (
                <li key={s.n} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-2 transition",
                        isDone
                          ? "bg-emerald-300 text-emerald-900 ring-emerald-300"
                          : isActive
                            ? "bg-white text-emerald-800 ring-white shadow-lg shadow-emerald-900/30"
                            : "bg-white/10 text-white/60 ring-white/20",
                      )}
                    >
                      {isDone ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                    </span>
                    <span
                      className={cn(
                        "truncate text-xs font-semibold",
                        isActive ? "text-white" : "text-white/70",
                      )}
                    >
                      {s.label}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "h-1 rounded-full transition-all",
                      isDone ? "bg-emerald-300" : isActive ? "bg-white" : "bg-white/10",
                    )}
                  />
                </li>
              );
            })}
          </ol>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mr-1.5 inline h-3.5 w-3.5" />
              {error}
            </div>
          ) : null}

          {step === 1 ? (
            <Step1
              name={name}
              setName={setName}
              type={type}
              setType={setType}
              bpid={bpid}
              setBpid={setBpid}
              numbers={numbers}
            />
          ) : step === 2 ? (
            type === "template" ? (
              <Step2Template
                bpid={bpid}
                templateName={templateName}
                setTemplateName={setTemplateName}
                language={templateLanguage}
                setLanguage={setTemplateLanguage}
                preview={templateBodyPreview}
                setPreview={setTemplateBodyPreview}
                varDefaults={varDefaults}
                setVarDefaults={setVarDefaults}
              />
            ) : (
              <Step2Magic
                prompt={magicPrompt}
                setPrompt={setMagicPrompt}
                tone={magicTone}
                setTone={setMagicTone}
              />
            )
          ) : step === 3 ? (
            <Step3Recipients
              source={recipientsSource}
              setSource={setRecipientsSource}
              tags={tagsInput}
              setTags={setTagsInput}
              csvText={csvText}
              setCsvText={setCsvText}
              templateBody={type === "template" ? templateBodyPreview : ""}
              bpid={bpid}
              lsqStages={lsqStages}
              setLsqStages={setLsqStages}
              lsqOwners={lsqOwners}
              setLsqOwners={setLsqOwners}
              lsqCreatedAfter={lsqCreatedAfter}
              setLsqCreatedAfter={setLsqCreatedAfter}
              lsqCreatedBefore={lsqCreatedBefore}
              setLsqCreatedBefore={setLsqCreatedBefore}
              lsqSources={lsqSources}
              setLsqSources={setLsqSources}
              lsqSubSources={lsqSubSources}
              setLsqSubSources={setLsqSubSources}
              lsqBrands={lsqBrands}
              setLsqBrands={setLsqBrands}
              repeatDaily={repeatDaily}
              setRepeatDaily={setRepeatDaily}
              directLeads={lsqDirectLeads}
              setDirectLeads={setLsqDirectLeads}
            />
          ) : (
            <Step4Schedule
              sendNow={sendNow}
              setSendNow={setSendNow}
              scheduleAt={scheduleAt}
              setScheduleAt={setScheduleAt}
              rateLimit={rateLimit}
              setRateLimit={setRateLimit}
              quietStart={quietStart}
              setQuietStart={setQuietStart}
              quietEnd={quietEnd}
              setQuietEnd={setQuietEnd}
              repeatDaily={repeatDaily}
              onBack={() => setStep(step - 1)}
              recipientLeads={recipientsSource === "lsq" ? lsqDirectLeads : null}
              recipientCount={
                recipientsSource === "lsq"
                  ? lsqDirectLeads?.length ?? null
                  : recipientsSource === "csv"
                    ? parseCsv(csvText).length
                    : null
              }
              recipientLoading={autoPulling}
            />
          )}
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t bg-card px-6 py-3">
        <button
          type="button"
          onClick={() => (step > 1 ? setStep(step - 1) : onClose())}
          className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
        >
          {step > 1 ? "Back" : "Cancel"}
        </button>
        {step < 4 ? (
          <button
            type="button"
            disabled={(step === 1 && !canStep1) || (step === 2 && !canStep2)}
            onClick={() => setStep(step + 1)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {repeatDaily ? "Create daily campaign" : sendNow ? "Send now" : "Schedule campaign"}
          </button>
        )}
      </footer>
    </div>
  );
}

function Step1({
  name,
  setName,
  type,
  setType,
  bpid,
  setBpid,
  numbers,
}: {
  name: string;
  setName: (v: string) => void;
  type: CampaignType;
  setType: (v: CampaignType) => void;
  bpid: string;
  setBpid: (v: string) => void;
  numbers: BusinessNumber[];
}) {
  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Campaign name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. May appointment reminder"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Type
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <TypeCard
            active={type === "template"}
            onSelect={() => setType("template")}
            icon={Send}
            title="Template campaign"
            sub="Send an approved WhatsApp template (re-engage outside the 24h window)"
          />
          <TypeCard
            active={type === "magic_message"}
            onSelect={() => setType("magic_message")}
            icon={Sparkles}
            title="Magic Message"
            sub="AI writes a personalized message per recipient (only inside 24h window)"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Send from
        </label>
        {numbers.length === 0 ? (
          <div className="rounded-md border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
            No business numbers connected.
          </div>
        ) : (
          <select
            value={bpid}
            onChange={(e) => setBpid(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {numbers.map((n) => (
              <option key={n.phone_number_id} value={n.phone_number_id}>
                {n.verified_name || n.display_phone_number || n.phone_number_id}
                {n.display_phone_number ? ` · ${n.display_phone_number}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function TypeCard({
  active,
  onSelect,
  icon: Icon,
  title,
  sub,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition",
        active
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border hover:border-foreground/20 hover:bg-secondary/40",
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md",
          active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground/70",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-[11px] text-muted-foreground">{sub}</span>
    </button>
  );
}

interface TemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string;
  // /api/templates returns the body text flat as `body` (not a components
  // array). Keep `components` optional for any caller that still passes it.
  body?: string;
  components?: Array<{ type: string; format?: string; text?: string }>;
  // Header media (image/video/doc) — set for both Meta and Interakt templates.
  header_url?: string | null;
  header_format?: string | null;
}

function Step2Template({
  bpid,
  templateName,
  setTemplateName,
  language,
  setLanguage,
  preview,
  setPreview,
  varDefaults,
  setVarDefaults,
}: {
  bpid: string;
  templateName: string;
  setTemplateName: (v: string) => void;
  language: string;
  setLanguage: (v: string) => void;
  preview: string;
  setPreview: (v: string) => void;
  varDefaults: Record<string, string>;
  setVarDefaults: (v: Record<string, string>) => void;
}) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (!bpid) return;
    setTemplates(null);
    setError(null);
    fetch(`/api/templates?phone_number_id=${encodeURIComponent(bpid)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const j = (await r.json()) as { templates?: TemplateSummary[]; error?: string };
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setTemplates(j.templates ?? []);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to load templates");
        setTemplates([]);
      });
  }, [bpid]);

  const filtered = useMemo(() => {
    if (!templates) return null;
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }, [templates, search]);

  function selectTemplate(t: TemplateSummary) {
    setTemplateName(t.name);
    setLanguage(t.language);
    // /api/templates exposes the body text as `body`; fall back to a
    // components array for safety. Without this the preview stayed empty
    // and the campaign saved no body → the worker sent 0 variables and
    // Meta rejected every message with (#132000) param-count mismatch.
    const body = t.body ?? t.components?.find((c) => c.type === "BODY")?.text ?? "";
    setPreview(body);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Pick an approved template</h2>
          <p className="text-[11px] text-muted-foreground">
            Pulled live from Meta Business Manager for this number.
          </p>
        </div>
        <a
          href="/templates/new"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          New template
        </a>
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, language, or category…"
        className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
      />

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mr-1.5 inline h-3 w-3" /> {error}
        </div>
      ) : null}

      {/* Template list */}
      {templates === null ? (
        <div className="grid h-32 place-items-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : filtered && filtered.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-10 text-center text-xs text-muted-foreground">
          {search ? (
            <>No templates match &ldquo;{search}&rdquo;.</>
          ) : (
            <>
              <Send className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
              No approved templates yet for this number.
              <br />
              Click <strong>+ New template</strong> above to create one.
            </>
          )}
        </div>
      ) : (
        <ul className="max-h-[600px] space-y-2 overflow-y-auto rounded-xl border bg-card p-2">
          {(filtered ?? []).map((t) => {
            const isSelected = t.name === templateName && t.language === language;
            const isApproved = t.status === "APPROVED";
            const body = t.body ?? t.components?.find((c) => c.type === "BODY")?.text ?? "";
            return (
              <li key={`${t.name}-${t.language}`}>
                <button
                  type="button"
                  onClick={() => isApproved && selectTemplate(t)}
                  disabled={!isApproved}
                  className={cn(
                    "group flex w-full flex-col gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition",
                    isSelected
                      ? "border-primary bg-primary/5 shadow-sm"
                      : isApproved
                        ? "hover:border-foreground/20 hover:bg-secondary/40"
                        : "cursor-not-allowed opacity-60",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : null}
                    <span className="truncate font-mono text-sm font-semibold">{t.name}</span>
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t.language}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
                        isApproved
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : t.status === "PENDING"
                            ? "bg-amber-50 text-amber-800 ring-amber-200"
                            : "bg-rose-50 text-rose-700 ring-rose-200",
                      )}
                    >
                      {t.status}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {t.category}
                    </span>
                  </div>
                  {/* Header media — render the actual image/video when we have a
                      real public URL (Interakt, or a dashboard-uploaded Meta
                      sample). Meta Business-Manager templates expose no public
                      sample URL, so for those show a badge marking the media
                      header instead. */}
                  {(() => {
                    const fmt = (t.header_format ?? "").toUpperCase();
                    const isMedia = fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT";
                    const url = t.header_url && /^https?:\/\//.test(t.header_url) ? t.header_url : null;
                    if (url && fmt === "VIDEO") {
                      return <video src={url} muted preload="metadata" className="mt-1 h-28 w-full rounded-md border bg-black/5 object-cover" />;
                    }
                    if (url && fmt !== "DOCUMENT") {
                      return (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={url} alt="" loading="lazy" className="mt-1 h-28 w-full rounded-md border bg-secondary/40 object-cover" />
                      );
                    }
                    if (isMedia) {
                      const label = fmt === "VIDEO" ? "🎬 Video header" : fmt === "DOCUMENT" ? "📄 Document header" : "🖼 Image header";
                      return (
                        <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-violet-50 px-2 py-1 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200">
                          {label}
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {body ? (
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {body}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Manual entry — collapsible escape hatch when the picker doesn't have it */}
      <button
        type="button"
        onClick={() => setShowManual((v) => !v)}
        className="text-[11px] font-medium text-primary hover:underline"
      >
        {showManual ? "Hide" : "Or enter template name manually"}
      </button>
      {showManual ? (
        <div className="space-y-3 rounded-lg border bg-secondary/30 p-3">
          <Field label="Template name" hint="Exactly as approved in Meta Business Manager">
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g. appointment_reminder"
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </Field>
          <Field label="Language" hint="ISO code: en, hi, en_GB, etc.">
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="en"
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </Field>
        </div>
      ) : null}

      {/* Body preview + detected variables */}
      {templateName ? (
        <>
          <Field label="Body preview" hint="Auto-filled from Meta — edit if you want a custom list label">
            <textarea
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              rows={3}
              placeholder="Hi {{name}}, your appointment is scheduled for {{date}}…"
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </Field>
          <DetectedVariables
            body={preview}
            varDefaults={varDefaults}
            setVarDefaults={setVarDefaults}
          />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detected-variables panel — parses {{1}}, {{name}}, etc. out of the
// template body and explains what columns the operator's CSV needs.
// ---------------------------------------------------------------------------
function DetectedVariables({
  body,
  varDefaults,
  setVarDefaults,
}: {
  body: string;
  varDefaults: Record<string, string>;
  setVarDefaults: (v: Record<string, string>) => void;
}) {
  const keys = useMemo(() => {
    const matches = (body ?? "").match(/\{\{\s*([\w-]+)\s*\}\}/g) ?? [];
    const seen: string[] = [];
    for (const m of matches) {
      const k = m.replace(/[{}\s]/g, "");
      if (!seen.includes(k)) seen.push(k);
    }
    return seen;
  }, [body]);

  if (keys.length === 0) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
        <Check className="mr-1.5 inline h-3 w-3" />
        No variables in this template — recipients only need <code className="font-mono">wa_id</code> in the CSV.
      </div>
    );
  }

  const isPositional = keys.every((k) => /^\d+$/.test(k));
  const exampleHeader = ["wa_id", "display_name", ...keys].join(",");
  const exampleRow = isPositional
    ? ["919045454045", "Mohd Khushnaseeb", ...keys.map((k) => `Value${k}`)].join(",")
    : ["919045454045", "Mohd Khushnaseeb", ...keys.map((k) => sampleValueFor(k))].join(",");

  return (
    <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-700">
          <Sparkles className="h-3 w-3" />
        </span>
        <span className="text-xs font-semibold text-violet-900">
          {keys.length} variable{keys.length > 1 ? "s" : ""} detected
        </span>
      </div>

      {/* Set one value for ALL recipients. A CSV column with the same name
          overrides this per-recipient. {{1}} also auto-fills from
          display_name if left blank. */}
      <div className="space-y-1.5 rounded-lg border border-violet-200 bg-white/70 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
          Set value (same for everyone) — optional
        </div>
        {keys.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <code className="w-20 shrink-0 rounded bg-violet-100 px-1.5 py-1 text-center font-mono text-[11px] text-violet-800">
              {`{{${k}}}`}
            </code>
            <input
              type="text"
              value={varDefaults[k] ?? ""}
              onChange={(e) =>
                setVarDefaults({ ...varDefaults, [k]: e.target.value })
              }
              placeholder={
                /^\d+$/.test(k)
                  ? "value for everyone (or use CSV / display_name)"
                  : `value for everyone (or CSV column "${k}")`
              }
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
            />
          </div>
        ))}
        <p className="text-[10px] text-violet-700/80">
          Blank chhodo to CSV column / display_name se bharega. Yahan likha to
          sab recipients ko wahi jayega.
        </p>
      </div>
      <p className="text-[11px] text-violet-900">
        {isPositional ? (
          <>
            This template uses <strong>positional</strong> variables — your CSV needs columns named exactly{" "}
            {keys.map((k, i) => (
              <span key={k}>
                <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">{k}</code>
                {i < keys.length - 1 ? ", " : ""}
              </span>
            ))}
            .
          </>
        ) : (
          <>
            This template uses <strong>named</strong> variables — your CSV needs columns:{" "}
            {keys.map((k, i) => (
              <span key={k}>
                <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">{k}</code>
                {i < keys.length - 1 ? ", " : ""}
              </span>
            ))}
            .
          </>
        )}{" "}
        wa_id and display_name are auto-fetched from your contacts; everything else fills the placeholders.
      </p>
      <div className="rounded-md border border-violet-200 bg-white/60 p-2 font-mono text-[10px] leading-relaxed">
        <div className="text-muted-foreground">{exampleHeader}</div>
        <div>{exampleRow}</div>
      </div>
    </div>
  );
}

function sampleValueFor(key: string): string {
  const k = key.toLowerCase();
  if (k.includes("name")) return "Rahul Sharma";
  if (k.includes("date")) return "12 May 4PM";
  if (k.includes("time")) return "4:00 PM";
  if (k.includes("doctor") || k.includes("dr")) return "Dr. Mehta";
  if (k.includes("clinic") || k.includes("city")) return "Mumbai";
  if (k.includes("amount") || k.includes("price") || k.includes("cost")) return "5000";
  if (k.includes("code") || k.includes("otp")) return "482910";
  if (k.includes("link") || k.includes("url")) return "https://americanhairline.com/x";
  return `Value${key}`;
}

const MAGIC_PROMPT_PRESETS = [
  {
    label: "Follow-up reminder",
    text: `Start with "Hi {{name}}," then warmly remind the patient about their upcoming follow-up appointment. Mention we'd love to know how their recovery has been so far. Ask if they have any questions or concerns. End with "Reply STOP to opt out." Keep it 40-60 words.`,
  },
  {
    label: "Re-engagement",
    text: `Greet "{{name}}" by name. Mention we noticed they were considering a hair-transplant consultation a while back, and we'd love to help them take the next step. Offer to share recent patient results or book a free 15-min call. Keep it short, no pressure.`,
  },
  {
    label: "Festival / offer",
    text: `Open with "{{name}}, " and a warm festive greeting. Tell them we're running a limited-time consultation slot for the next 7 days and we'd be happy to fit them in. Don't quote any price. Suggest they reply YES to claim a slot.`,
  },
  {
    label: "Photo request",
    text: `Address "{{name}}" by name. Politely ask them to share 2-3 clear scalp photos (front, top, side) so our medical team can review and call back with an accurate plan. Reassure that the photos stay private with the clinic.`,
  },
];

function Step2Magic({
  prompt,
  setPrompt,
  tone,
  setTone,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  tone: string;
  setTone: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Preset pills — click to fill the textarea with a starter brief
          that already shows {{name}} usage. The AI substitutes per
          recipient at send time. */}
      <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-700">
            <Sparkles className="h-3 w-3" />
          </span>
          <span className="text-xs font-semibold text-violet-900">
            Start from a preset
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {MAGIC_PROMPT_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPrompt(p.text)}
              className="rounded-full border border-violet-200 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-violet-800 transition hover:bg-violet-100"
            >
              + {p.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-violet-900/85">
          Use{" "}
          <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">{"{{name}}"}</code>
          {" "}or{" "}
          <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">{"{{1}}"}</code>{" "}
          anywhere in your brief — the AI replaces it with each
          recipient&apos;s display name automatically. Other CSV columns are
          available the same way ({"{{date}}"}, {"{{doctor}}"}, etc.).
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Magic prompt
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              What should the AI write to each recipient?
            </span>
            <AiAssistButton
              kind="magic_campaign_brief"
              value={prompt}
              onApply={setPrompt}
            />
          </div>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder={`Hi {{name}}, remind the patient about their upcoming follow-up. Ask if they have any questions, mention we're here to help.`}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
      </div>
      <Field label="Tone" hint="Adjective list — passed to the model">
        <input
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          placeholder="warm, conversational, professional"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
      </Field>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
        ⚠️ Magic Message only works inside the WhatsApp 24-hour customer-care
        window. Recipients with no recent inbound get skipped by Meta.
      </div>
    </div>
  );
}

function Step3Recipients({
  source,
  setSource,
  tags,
  setTags,
  csvText,
  setCsvText,
  templateBody,
  bpid,
  lsqStages,
  setLsqStages,
  lsqOwners,
  setLsqOwners,
  lsqCreatedAfter,
  setLsqCreatedAfter,
  lsqCreatedBefore,
  setLsqCreatedBefore,
  lsqSources,
  setLsqSources,
  lsqSubSources,
  setLsqSubSources,
  lsqBrands,
  setLsqBrands,
  repeatDaily,
  setRepeatDaily,
  directLeads,
  setDirectLeads,
}: {
  source: "all" | "tags" | "csv" | "lsq";
  setSource: (v: "all" | "tags" | "csv" | "lsq") => void;
  tags: string;
  setTags: (v: string) => void;
  csvText: string;
  setCsvText: (v: string) => void;
  templateBody?: string;
  bpid: string;
  lsqStages: string[];
  setLsqStages: (v: string[]) => void;
  lsqOwners: string[];
  setLsqOwners: (v: string[]) => void;
  lsqCreatedAfter: string;
  setLsqCreatedAfter: (v: string) => void;
  lsqCreatedBefore: string;
  setLsqCreatedBefore: (v: string) => void;
  lsqSources: string[];
  setLsqSources: (v: string[]) => void;
  lsqSubSources: string[];
  setLsqSubSources: (v: string[]) => void;
  lsqBrands: string[];
  setLsqBrands: (v: string[]) => void;
  repeatDaily: boolean;
  setRepeatDaily: (v: boolean) => void;
  directLeads: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null;
  setDirectLeads: (v: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SourceCard active={source === "all"} onSelect={() => setSource("all")} icon={Inbox} title="All contacts" sub="Everyone on this number" />
        <SourceCard active={source === "tags"} onSelect={() => setSource("tags")} icon={Users} title="Tag filter" sub="Match contacts by tag" />
        <SourceCard active={source === "lsq"} onSelect={() => setSource("lsq")} icon={Megaphone} title="From LSQ" sub="Filter by stage / owner / date" />
        <SourceCard active={source === "csv"} onSelect={() => setSource("csv")} icon={Upload} title="CSV upload" sub="wa_id,name,var1,var2" />
      </div>

      {source === "tags" ? (
        <Field label="Tags (comma-separated)" hint="Any tag match adds the contact (OR logic)">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="follow-up, post-procedure"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
        </Field>
      ) : null}

      {source === "lsq" ? (
        <LsqFilterPanel
          bpid={bpid}
          stages={lsqStages}
          setStages={setLsqStages}
          owners={lsqOwners}
          setOwners={setLsqOwners}
          createdAfter={lsqCreatedAfter}
          setCreatedAfter={setLsqCreatedAfter}
          createdBefore={lsqCreatedBefore}
          setCreatedBefore={setLsqCreatedBefore}
          sources={lsqSources}
          setSources={setLsqSources}
          subSources={lsqSubSources}
          setSubSources={setLsqSubSources}
          brands={lsqBrands}
          setBrands={setLsqBrands}
          repeatDaily={repeatDaily}
          setRepeatDaily={setRepeatDaily}
          directLeads={directLeads}
          setDirectLeads={setDirectLeads}
        />
      ) : null}

      {source === "csv" ? (
        <CsvUploader csvText={csvText} setCsvText={setCsvText} templateBody={templateBody} />
      ) : null}
    </div>
  );
}

const SAMPLE_CSV = `wa_id,display_name
919045454045,Mohd Khushnaseeb
919876543210,Rahul Sharma
919812345678,Anita Verma
919898765432,Imran Qureshi
918901234567,Priya Nair`;

function CsvUploader({
  csvText,
  setCsvText,
  templateBody,
}: {
  csvText: string;
  setCsvText: (v: string) => void;
  templateBody?: string;
}) {
  // Build a sample CSV that already has the columns this template needs.
  // If templateBody is empty (Magic Message campaign or no preview yet),
  // fall back to the simple wa_id + display_name sample.
  const dynamicSample = useMemo(() => {
    const placeholders = (templateBody ?? "").match(/\{\{\s*([\w-]+)\s*\}\}/g) ?? [];
    const seen: string[] = [];
    for (const m of placeholders) {
      const k = m.replace(/[{}\s]/g, "");
      if (!seen.includes(k) && k !== "name") seen.push(k);
    }
    if (seen.length === 0) return SAMPLE_CSV;
    const header = ["wa_id", "display_name", ...seen].join(",");
    const rows = [
      ["919045454045", "Mohd Khushnaseeb", ...seen.map((k) => sampleValueFor(k))],
      ["919876543210", "Rahul Sharma", ...seen.map((k) => sampleValueFor(k))],
      ["919812345678", "Anita Verma", ...seen.map((k) => sampleValueFor(k))],
      ["919898765432", "Imran Qureshi", ...seen.map((k) => sampleValueFor(k))],
    ];
    return [header, ...rows.map((r) => r.join(","))].join("\n");
  }, [templateBody]);

  function loadSample() {
    setCsvText(dynamicSample);
  }

  function downloadSample() {
    const blob = new Blob([dynamicSample], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "campaign-recipients-sample.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  const rowCount = csvText.split(/\r?\n/).filter((l) => l.trim()).length;
  const recipients = Math.max(0, rowCount - 1);

  return (
    <div className="space-y-3">
      {/* Quick guide */}
      <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-700">
            <Upload className="h-3 w-3" />
          </span>
          <span className="text-xs font-semibold text-violet-900">CSV format</span>
        </div>
        <ul className="ml-1 space-y-1 text-[11px] text-violet-900">
          <li>
            <strong>Required:</strong>{" "}
            <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">wa_id</code> — phone
            with country code, no <code className="font-mono">+</code> or spaces
            (e.g. <code className="font-mono">919876543210</code>).
          </li>
          <li>
            <strong>Optional:</strong>{" "}
            <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">display_name</code> —
            patient name (auto-fills <code className="font-mono">{"{{name}}"}</code> in templates).
          </li>
          <li>
            <strong>Template variables:</strong> any other column matches the placeholder
            with the same name. <code className="font-mono">{"{{date}}"}</code> needs a{" "}
            <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">date</code> column;{" "}
            <code className="font-mono">{"{{1}}"}</code> needs a{" "}
            <code className="rounded bg-violet-100 px-1 py-0.5 font-mono">1</code> column.
          </li>
        </ul>
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadSample}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
        >
          <Sparkles className="h-3 w-3" />
          Load sample
        </button>
        <button
          type="button"
          onClick={downloadSample}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
        >
          <Upload className="h-3 w-3 rotate-180" />
          Download sample.csv
        </button>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90">
          <Upload className="h-3 w-3" />
          Upload CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      {/* CSV textarea */}
      <Field
        label="Paste or edit CSV"
        hint={recipients > 0 ? `${recipients.toLocaleString()} recipient${recipients === 1 ? "" : "s"} ready` : "First row = header"}
      >
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={10}
          placeholder={SAMPLE_CSV}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        />
      </Field>

      {/* Live preview of detected columns */}
      {csvText.trim() ? <CsvPreview csvText={csvText} /> : null}
    </div>
  );
}

function CsvPreview({ csvText }: { csvText: string }) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 1) return null;
  const header = lines[0].split(",").map((h) => h.trim());
  const sampleRow = lines[1]?.split(",").map((c) => c.trim()) ?? [];
  const hasWaId = header.includes("wa_id");

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-xs shadow-sm">
      <header className="flex items-center justify-between border-b bg-secondary/30 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Detected columns
        </span>
        {hasWaId ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
            <Check className="h-2.5 w-2.5" /> wa_id present
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-200">
            <AlertCircle className="h-2.5 w-2.5" /> wa_id missing
          </span>
        )}
      </header>
      <div className="grid gap-y-1 px-3 py-2 text-[11px] sm:grid-cols-[120px_1fr]">
        {header.map((h, i) => {
          const role =
            h === "wa_id"
              ? "Required · phone"
              : h === "display_name"
                ? "Optional · shown name"
                : `Variable · {{${h}}}`;
          return (
            <div key={i} className="contents">
              <span className="font-mono font-semibold text-foreground/85">{h}</span>
              <span className="text-muted-foreground">
                {role}
                {sampleRow[i] ? (
                  <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                    e.g. {sampleRow[i]}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface LsqFiltersData {
  total_contacts: number;
  stages: Array<{ stage: string; count: number }>;
  owners: Array<{ owner: string; count: number }>;
  created_at_range: { oldest: string | null; newest: string | null };
}

interface LsqMasterData {
  stages: string[];
  sources: string[];
  sub_sources: string[];
  owners: Array<{ id: string; name: string; email: string | null }>;
  errors?: Record<string, string | null>;
}

function LsqFilterPanel({
  bpid,
  stages,
  setStages,
  owners,
  setOwners,
  createdAfter,
  setCreatedAfter,
  createdBefore,
  setCreatedBefore,
  sources,
  setSources,
  subSources,
  setSubSources,
  brands,
  setBrands,
  repeatDaily,
  setRepeatDaily,
  directLeads,
  setDirectLeads,
}: {
  bpid: string;
  stages: string[];
  setStages: (v: string[]) => void;
  owners: string[];
  setOwners: (v: string[]) => void;
  createdAfter: string;
  setCreatedAfter: (v: string) => void;
  createdBefore: string;
  setCreatedBefore: (v: string) => void;
  repeatDaily: boolean;
  setRepeatDaily: (v: boolean) => void;
  sources: string[];
  setSources: (v: string[]) => void;
  subSources: string[];
  setSubSources: (v: string[]) => void;
  brands: string[];
  setBrands: (v: string[]) => void;
  directLeads: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null;
  setDirectLeads: (v: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null) => void;
}) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullStats, setPullStats] = useState<{ total: number; fetched: number; truncated: boolean } | null>(null);
  // Sub source + LSQ owner are rarely-used filters — keep collapsed by
  // default (auto-open if the operator already has values selected).
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    () => subSources.length > 0 || owners.length > 0,
  );

  // Master data — full LSQ universe (stages, sources, sub-sources, owners)
  // pulled once on mount. Falls back to local-cached aggregates when LSQ
  // can't be reached.
  const [master, setMaster] = useState<LsqMasterData | null>(null);
  const [masterError, setMasterError] = useState<string | null>(null);
  // Brand (mx_Brand) values — from the field-values endpoint (LeadsMetaData).
  const [brandValues, setBrandValues] = useState<string[]>([]);
  // Local stage/owner counts from aggregator endpoint — overlays on the
  // master-data lists so each chip shows "Hot · 23".
  const [counts, setCounts] = useState<{
    stages: Record<string, number>;
    owners: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    fetch("/api/lsq/field-values", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { fields?: Array<{ schema: string; values: string[] }> }) => {
        const b = (j.fields ?? []).find((f) => f.schema.toLowerCase() === "mx_brand");
        if (b) setBrandValues(b.values);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/lsq/master-data", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as LsqMasterData & { error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setMaster(j);
      })
      .catch((e) => {
        if (!cancelled) setMasterError(e instanceof Error ? e.message : "Failed to load LSQ master data");
      });
    if (bpid) {
      fetch(`/api/lsq/filters?business_phone_number_id=${encodeURIComponent(bpid)}`, { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) return;
          const j = (await r.json()) as {
            stages?: Array<{ stage: string; count: number }>;
            owners?: Array<{ owner: string; count: number }>;
          };
          if (cancelled) return;
          const sm: Record<string, number> = {};
          for (const s of j.stages ?? []) sm[s.stage] = s.count;
          const om: Record<string, number> = {};
          for (const o of j.owners ?? []) om[o.owner] = o.count;
          setCounts({ stages: sm, owners: om });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [bpid]);

  async function pullFromLsq() {
    setPulling(true);
    setPullError(null);
    setPullStats(null);
    setDirectLeads(null);
    try {
      const res = await fetch("/api/lsq/pull-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stages,
          owners,
          sources,
          sub_sources: subSources,
          brands,
          created_after: createdAfter ? new Date(createdAfter).toISOString() : undefined,
          created_before: createdBefore ? new Date(createdBefore).toISOString() : undefined,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        leads?: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }>;
        total_records_in_lsq?: number;
        fetched?: number;
        truncated_at_cap?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDirectLeads(json.leads ?? []);
      setPullStats({
        total: json.total_records_in_lsq ?? 0,
        fetched: json.fetched ?? 0,
        truncated: json.truncated_at_cap ?? false,
      });
    } catch (e) {
      setPullError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }
  // Quick date presets
  function setDatePreset(days: number | "all") {
    if (days === "all") {
      setCreatedAfter("");
      setCreatedBefore("");
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    const fmt = (d: Date) => d.toISOString().slice(0, 16); // datetime-local format
    setCreatedAfter(fmt(start));
    setCreatedBefore(fmt(end));
  }

  // Local-cache estimate. Pure best-effort — when "Fetch from LSQ"
  // runs we replace this with the actual fetched count.
  const estimated = useMemo(() => {
    if (!counts) return null;
    if (stages.length === 0 && owners.length === 0 && sources.length === 0 && subSources.length === 0) {
      return null;
    }
    let cap = Number.MAX_SAFE_INTEGER;
    if (stages.length > 0) {
      const sum = stages.reduce((s, k) => s + (counts.stages[k] ?? 0), 0);
      cap = Math.min(cap, sum);
    }
    if (owners.length > 0) {
      const sum = owners.reduce((s, k) => s + (counts.owners[k] ?? 0), 0);
      cap = Math.min(cap, sum);
    }
    return cap === Number.MAX_SAFE_INTEGER ? null : cap;
  }, [counts, stages, owners, sources, subSources]);

  return (
    <div className="space-y-4 rounded-xl border border-violet-200 bg-violet-50/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-700">
          <Megaphone className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-semibold text-violet-900">LSQ recipient filter</span>
        {estimated !== null ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-200">
            <Users className="h-2.5 w-2.5" />
            ~{estimated.toLocaleString()} match
          </span>
        ) : null}
      </div>

      {masterError ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mr-1.5 inline h-3 w-3" />
          Couldn&apos;t load full LSQ master data ({masterError}). Showing only locally-cached values.
        </div>
      ) : null}

      {/* Stage multi-select — defaults first, then any extras LSQ surfaces */}
      <SearchableMultiSelect
        label="Lead stages"
        hint="Search or add new"
        items={mergeWithDefaults(LSQ_DEFAULT_STAGES, master?.stages ?? []).map((s) => ({
          key: s,
          label: s,
          count: counts?.stages[s] ?? 0,
        }))}
        selected={stages}
        onChange={setStages}
        allowCustom
        emptyHint="No stages configured."
        accent="violet"
      />

      {/* Date range */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-900">
            Lead created date
          </span>
          <span className="text-[10px] text-muted-foreground">Local time</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="datetime-local"
            value={createdAfter}
            onChange={(e) => setCreatedAfter(e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs"
          />
          <input
            type="datetime-local"
            value={createdBefore}
            onChange={(e) => setCreatedBefore(e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs"
          />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {[
            { label: "Last 7 days", days: 7 },
            { label: "Last 30 days", days: 30 },
            { label: "Last 90 days", days: 90 },
            { label: "All time", days: "all" as const },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDatePreset(p.days)}
              className="rounded-full border bg-white px-2 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Campaign type — one-time vs daily (dynamic). The selected date range
          above becomes the rolling window for daily. */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-2.5">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-900">
          Campaign type
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setRepeatDaily(false)}
            className={cn(
              "rounded-md border px-3 py-2 text-left text-xs transition",
              !repeatDaily ? "border-violet-500 bg-white ring-2 ring-violet-200" : "border-border bg-white/60 hover:bg-white",
            )}
          >
            <div className="font-semibold">One-time</div>
            <div className="text-[10px] text-muted-foreground">Abhi inn leads ko ek baar bhejo.</div>
          </button>
          <button
            type="button"
            onClick={() => setRepeatDaily(true)}
            className={cn(
              "rounded-md border px-3 py-2 text-left text-xs transition",
              repeatDaily ? "border-violet-500 bg-white ring-2 ring-violet-200" : "border-border bg-white/60 hover:bg-white",
            )}
          >
            <div className="font-semibold">Daily (dynamic)</div>
            <div className="text-[10px] text-muted-foreground">Roz upar wali date-range dobara chalegi; sirf NAYE matching leads ko (ek baar).</div>
          </button>
        </div>
      </div>

      {/* Source multi-select — defaults + LSQ master merge */}
      <SearchableMultiSelect
        label="Source"
        hint="Search or add new"
        items={mergeWithDefaults(LSQ_DEFAULT_SOURCES, master?.sources ?? []).map((s) => ({
          key: s,
          label: s,
        }))}
        selected={sources}
        onChange={setSources}
        allowCustom
        loading={master === null && !masterError && LSQ_DEFAULT_SOURCES.length === 0}
        emptyHint="No Source values found."
        accent="sky"
        showCounts={false}
      />

      {/* Brand (mx_Brand) multi-select — values from LeadsMetaData */}
      <SearchableMultiSelect
        label="Brand"
        hint="Search or add new"
        items={brandValues.map((b) => ({ key: b, label: b }))}
        selected={brands}
        onChange={setBrands}
        allowCustom
        loading={brandValues.length === 0}
        emptyHint="No Brand values found."
        accent="violet"
        showCounts={false}
      />

      {/* Advanced filters — collapsed by default (sub source / owner are
          optional on most campaigns) */}
      <div className="rounded-lg border border-violet-200/70 bg-white/60">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        >
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-violet-900">
            <Settings2 className="h-3 w-3" />
            Advanced filters
            {(subSources.length > 0 || owners.length > 0) ? (
              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold text-violet-800">
                {subSources.length + owners.length}
              </span>
            ) : null}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {showAdvanced ? "Hide" : "Sub source · LSQ owner"}
          </span>
        </button>
        {showAdvanced ? (
          <div className="space-y-4 border-t border-violet-200/70 px-3 py-3">
            <SearchableMultiSelect
              label="Sub source"
              hint="Search or add new"
              items={mergeWithDefaults(LSQ_DEFAULT_SUB_SOURCES, master?.sub_sources ?? []).map((s) => ({
                key: s,
                label: s,
              }))}
              selected={subSources}
              onChange={setSubSources}
              allowCustom
              loading={master === null && !masterError && LSQ_DEFAULT_SUB_SOURCES.length === 0}
              emptyHint="No Sub source values found."
              accent="sky"
              showCounts={false}
            />

            <SearchableMultiSelect
              label="LSQ owner"
              hint="Search by name"
              items={(master?.owners ?? []).map((o) => ({
                key: o.name,
                label: o.name,
                count: counts?.owners[o.name] ?? 0,
              }))}
              selected={owners}
              onChange={setOwners}
              allowCustom={false}
              loading={master === null && !masterError}
              emptyHint="No users found on the LSQ tenant."
              accent="emerald"
              visibleCap={50}
            />
          </div>
        ) : null}
      </div>

      {/* Direct LSQ pull — fetches matching leads live from LSQ rather
          than from the cached lsq_stage column. Useful when contacts
          haven't been synced yet (e.g. fresh leads created today). */}
      <div className="rounded-lg border border-emerald-300 bg-emerald-50/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <Sparkles className="h-3.5 w-3.5" />
              Fetch live from LSQ
            </div>
            <p className="mt-0.5 text-[11px] text-emerald-900/85">
              Pulls all matching leads directly from LeadSquared (not the local cache). Up to 5,000 leads.
            </p>
          </div>
          <button
            type="button"
            onClick={pullFromLsq}
            disabled={
              pulling ||
              (stages.length === 0 &&
                owners.length === 0 &&
                !createdAfter &&
                !createdBefore)
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {pulling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {pulling ? "Fetching…" : "Fetch from LSQ"}
          </button>
        </div>

        {pullError ? (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            <AlertCircle className="mr-1 inline h-3 w-3" /> {pullError}
          </div>
        ) : null}

        {directLeads !== null && pullStats ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-white/70 px-3 py-2 text-[11px] ring-1 ring-emerald-200">
              <Check className="h-3 w-3 text-emerald-600" />
              <span className="font-semibold text-emerald-900">
                {pullStats.fetched.toLocaleString()} leads fetched
              </span>
              <span className="text-muted-foreground">
                · {pullStats.total.toLocaleString()} leads scanned in date window
              </span>
              {pullStats.truncated ? (
                <span className="ml-auto rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                  Truncated at 5000
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setDirectLeads(null);
                  setPullStats(null);
                }}
                className="ml-auto text-[10px] font-semibold text-emerald-700 hover:underline"
              >
                Reset
              </button>
            </div>
            {/* Preview first 50 — with stage + source so the operator can sanity-check the filter. */}
            <div className="overflow-hidden rounded-md border border-emerald-200 bg-white text-[11px]">
              <ul className="max-h-60 divide-y divide-emerald-100/60 overflow-y-auto">
                {directLeads.slice(0, 50).map((l) => (
                  <li key={l.wa_id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="font-mono tabular-nums text-muted-foreground">{maskPhone(formatPhone(l.wa_id))}</span>
                    <span className="w-28 shrink-0 truncate">{l.display_name ? maskName(l.display_name) : <span className="text-muted-foreground/60">No name</span>}</span>
                    {l.stage ? (
                      <span className="shrink-0 truncate rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{l.stage}</span>
                    ) : null}
                    {l.source || l.sub_source ? (
                      <span className="ml-auto truncate text-[10px] text-muted-foreground" title={[l.source, l.sub_source].filter(Boolean).join(" · ")}>
                        {[l.source, l.sub_source].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {directLeads.length > 50 ? (
                <div className="border-t bg-secondary/30 px-3 py-1 text-center text-[10px] text-muted-foreground">
                  + {(directLeads.length - 50).toLocaleString()} more (all will be added on Continue)
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-[10px] text-muted-foreground">
        <strong>Local-cache mode:</strong> default — uses the lsq_stage already on each contact
        (synced via Settings → LeadSquared → Sync all).
        <br />
        <strong>Live LSQ mode:</strong> click <em>Fetch from LSQ</em> above to pull straight from LSQ —
        works even for leads that haven&apos;t been synced locally yet. All filters AND together.
      </p>
    </div>
  );
}

function SourceCard({
  active,
  onSelect,
  icon: Icon,
  title,
  sub,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-left transition",
        active ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:bg-secondary/40",
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          active ? "bg-primary text-primary-foreground" : "bg-secondary",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
}

function Step4Schedule({
  sendNow,
  setSendNow,
  scheduleAt,
  setScheduleAt,
  rateLimit,
  setRateLimit,
  quietStart,
  setQuietStart,
  quietEnd,
  setQuietEnd,
  repeatDaily,
  onBack,
  recipientLeads,
  recipientCount,
  recipientLoading,
}: {
  sendNow: boolean;
  setSendNow: (v: boolean) => void;
  scheduleAt: string;
  setScheduleAt: (v: string) => void;
  rateLimit: number;
  setRateLimit: (v: number) => void;
  quietStart: string;
  setQuietStart: (v: string) => void;
  quietEnd: string;
  setQuietEnd: (v: string) => void;
  repeatDaily: boolean;
  onBack: () => void;
  recipientLeads: Array<{ wa_id: string; display_name: string; stage?: string | null; source?: string | null; sub_source?: string | null }> | null;
  recipientCount: number | null;
  recipientLoading: boolean;
}) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-secondary"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to recipients
      </button>

      {/* Recipient summary — total + full list (so the operator sees exactly
          how many / who will get the message before sending). */}
      <div className="overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/40">
        <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-3 py-2">
          {recipientLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-emerald-700" />
          ) : (
            <Users className="h-4 w-4 text-emerald-700" />
          )}
          <span className="text-sm font-semibold text-emerald-900">
            {recipientLoading
              ? "Fetching recipients…"
              : recipientCount !== null
                ? `${recipientCount.toLocaleString()} recipient${recipientCount === 1 ? "" : "s"}`
                : "Recipients"}
          </span>
          {!recipientLoading ? (
            <span className="text-[11px] text-emerald-700">— inko message jayega</span>
          ) : null}
        </div>
        {recipientLoading ? (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            LSQ se leads fetch ho rahe hain…
          </div>
        ) : recipientLeads && recipientLeads.length > 0 ? (
          <ul className="max-h-56 divide-y divide-emerald-100/60 overflow-y-auto text-[11px]">
            {recipientLeads.map((l) => (
              <li key={l.wa_id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="font-mono tabular-nums text-muted-foreground">{maskPhone(formatPhone(l.wa_id))}</span>
                <span className="truncate">
                  {l.display_name ? maskName(l.display_name) : <span className="text-muted-foreground/60">No name</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            {recipientCount === null
              ? "Filter-based — exact recipients send pe resolve honge. Campaign detail page pe live list dikhegi."
              : "List preview yahan nahi hai; campaign banne ke baad detail page pe full list + live status dikhega."}
          </div>
        )}
      </div>
      {repeatDaily ? (
        <div className="rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-[11px] text-violet-800">
          <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
          Daily (dynamic) campaign — recipients step me set kiya. Send-timing N/A; roz date-range dobara chalegi.
        </div>
      ) : null}

      {repeatDaily ? null : (
      <Field label="Send timing">
        <div className="grid gap-2 sm:grid-cols-2">
          <SourceCard active={sendNow} onSelect={() => setSendNow(true)} icon={Play} title="Send now" sub="Start within 30 seconds" />
          <SourceCard active={!sendNow} onSelect={() => setSendNow(false)} icon={Clock} title="Schedule for later" sub="Pick date + time" />
        </div>
        {!sendNow ? (
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        ) : null}
      </Field>
      )}

      <RateLimitField rateLimit={rateLimit} setRateLimit={setRateLimit} />

      <Field label="Quiet hours (IST)" hint="Worker pauses sending in this window. Leave both empty = 24/7.">
        <div className="grid grid-cols-2 gap-2">
          <input
            type="time"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            placeholder="21:00"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <input
            type="time"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            placeholder="09:00"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </Field>
    </div>
  );
}

function RateLimitField({
  rateLimit,
  setRateLimit,
}: {
  rateLimit: number;
  setRateLimit: (v: number) => void;
}) {
  // Storage stays in per-minute. UI offers per-minute / per-second
  // toggle so operators can think in either unit. Cap = 600/min
  // (10/sec) — Meta's WABA limits are well above this, but our
  // worker tick is 30s so finer granularity is purely cosmetic.
  const MAX_PER_MIN = 600;
  const [unit, setUnit] = useState<"min" | "sec">("min");
  const display = unit === "sec" ? Math.max(1, Math.round(rateLimit / 60)) : rateLimit;
  const max = unit === "sec" ? Math.floor(MAX_PER_MIN / 60) : MAX_PER_MIN;
  return (
    <Field
      label={`Rate limit (messages per ${unit === "sec" ? "second" : "minute"})`}
      hint="Recommended 30/min. Higher = faster but risks Meta throttling."
    >
      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          max={max}
          value={display}
          onChange={(e) => {
            const n = Math.max(1, Math.min(max, Number(e.target.value) || 1));
            setRateLimit(unit === "sec" ? n * 60 : n);
          }}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value as "min" | "sec")}
          className="rounded-md border bg-background px-2 py-2 text-sm"
        >
          <option value="min">/ minute</option>
          <option value="sec">/ second</option>
        </select>
      </div>
      {unit === "sec" ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          = {rateLimit} messages / minute (stored unit)
        </p>
      ) : null}
    </Field>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function parseCsv(text: string): Array<{ wa_id: string; display_name?: string; variables: Record<string, string> }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const waIdx = header.indexOf("wa_id");
  const nameIdx = header.indexOf("display_name");
  if (waIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const wa_id = cells[waIdx] ?? "";
    const display_name = nameIdx >= 0 ? cells[nameIdx] : undefined;
    const variables: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h !== "wa_id" && h !== "display_name" && cells[i]) variables[h] = cells[i];
    });
    return { wa_id, display_name, variables };
  });
}

// ---------------------------------------------------------------------------
// DETAIL
// ---------------------------------------------------------------------------
interface PkgBucket {
  count: number;
  total_value: number;
  items: Array<{ wa_id: string; name: string | null; package_value: number; notes: string | null }>;
}
interface ConversionData {
  total_recipients: number;
  backfilled?: number;
  ht_done: PkgBucket;
  order_placed: PkgBucket;
  order: {
    count: number;
    total_value: number;
    items: Array<{ wa_id: string; name: string | null; order_value: number; confirmed_date: string | null }>;
  };
  booked?: {
    count: number;
    total_value: number;
    items: Array<{ wa_id: string; name: string | null; booking_amount: number; booking_date: string | null }>;
  };
}

function CampaignDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [clickedCount, setClickedCount] = useState(0);
  const [repliedLive, setRepliedLive] = useState(0);
  const [workflowPct, setWorkflowPct] = useState(0);
  const [workflowProgress, setWorkflowProgress] = useState<
    Array<{ wa_id: string; display_name: string | null; replies: number; pct: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversions, setConversions] = useState<ConversionData | null>(null);
  const [convLoading, setConvLoading] = useState(false);

  async function loadConversions() {
    setConvLoading(true);
    try {
      const r = await fetch(`/api/campaigns/${id}/conversions`, { cache: "no-store" });
      const j = (await r.json()) as ConversionData & { error?: string };
      if (r.ok) setConversions(j);
    } catch {
      /* non-critical */
    } finally {
      setConvLoading(false);
    }
  }
  useEffect(() => {
    loadConversions();
    // Auto-sync: stage comes from local contacts (webhook-synced) so a poll is
    // cheap; values self-heal via a bounded LSQ backfill each pass.
    const t = setInterval(loadConversions, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    try {
      const res = await fetch(`/api/campaigns/${id}`, { cache: "no-store" });
      const json = (await res.json()) as { campaign?: Campaign; recipients?: Recipient[]; clicked_count?: number; replied_count?: number; workflow_completion_pct?: number; workflow_progress?: Array<{ wa_id: string; display_name: string | null; replies: number; pct: number }>; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCampaign(json.campaign ?? null);
      setRecipients(json.recipients ?? []);
      setClickedCount(json.clicked_count ?? 0);
      setRepliedLive(json.replied_count ?? 0);
      setWorkflowPct(json.workflow_completion_pct ?? 0);
      setWorkflowProgress(json.workflow_progress ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Template category (Marketing / Utility / …) drives the cost estimate.
  // Pulled live from Meta via /api/templates and matched by name+language.
  const [templateCategory, setTemplateCategory] = useState<string | null>(null);
  useEffect(() => {
    if (!campaign || campaign.type !== "template" || !campaign.template_name) return;
    fetch(
      `/api/templates?phone_number_id=${encodeURIComponent(campaign.business_phone_number_id)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j: { templates?: Array<{ name: string; language: string; category: string }> }) => {
        const list = j.templates ?? [];
        const t =
          list.find(
            (x) => x.name === campaign.template_name && x.language === campaign.template_language,
          ) ?? list.find((x) => x.name === campaign.template_name);
        setTemplateCategory(t?.category ?? null);
      })
      .catch(() => {});
  }, [campaign?.business_phone_number_id, campaign?.template_name, campaign?.template_language, campaign?.type]);

  async function cancel() {
    if (!confirm("Cancel this campaign? Pending recipients will be skipped.")) return;
    setBusy(true);
    try {
      await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
      onBack();
    } finally {
      setBusy(false);
    }
  }

  const [syncing, setSyncing] = useState(false);
  async function syncStats() {
    setSyncing(true);
    try {
      await fetch(`/api/campaigns/${id}/recompute`, { method: "POST" });
      await load();
    } finally {
      setSyncing(false);
    }
  }

  if (!campaign) {
    return (
      <div className="grid h-full place-items-center bg-secondary/30">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  // Click-through = recipients who tapped a button / total sent. Derived
  // server-side from messages, so it works without the button_clicked column.
  const clicks = clickedCount;
  // Replied — prefer the live messages-derived count (robust to a stale
  // counter that didn't recompute), falling back to the stored column.
  const repliedCount = Math.max(campaign.replied_count, repliedLive);
  // Est. send cost = per-message rate for the template category × sent.
  const estCost = estimateCampaignCostInr(templateCategory, campaign.sent_count);
  const perMsgRate = rateForCategory(templateCategory);

  const sentPct = campaign.total_recipients
    ? Math.round((campaign.sent_count / campaign.total_recipients) * 100)
    : 0;

  const isMagic = campaign.type === "magic_message";
  const TypeIcon = isMagic ? Sparkles : Send;

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* Premium gradient hero */}
      <header
        className={cn(
          "relative overflow-hidden border-b text-white",
          isMagic
            ? "bg-gradient-to-br from-violet-700 via-fuchsia-800 to-purple-900"
            : "bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-900",
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-20 h-72 w-72 rounded-full bg-white/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-6 py-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20 transition hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/30 backdrop-blur-sm">
              <TypeIcon className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">{campaign.name}</h1>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-white/30",
                  )}
                >
                  {campaign.status === "sending" ? (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                    </span>
                  ) : null}
                  {STATUS_LABEL[campaign.status]}
                </span>
              </div>
              <p className="mt-1 text-xs text-white/85">
                <span className="font-semibold">{isMagic ? "Magic Message" : "Template"}</span>
                {" · "}
                <Phone className="inline h-3 w-3" /> {campaign.business_phone_number_id}
                {campaign.started_at ? (
                  <>
                    {" · "}
                    Started {new Date(campaign.started_at).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={syncStats}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-50"
                title="Re-aggregate stats from recipient rows"
              >
                {syncing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Sync stats
              </button>
              {["draft", "scheduled", "sending"].includes(campaign.status) ? (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-50"
                >
                  <Pause className="h-3 w-3" />
                  Cancel campaign
                </button>
              ) : null}
            </div>
          </div>

          {/* Top-line progress (sending → completed) */}
          <div className="mt-5">
            <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-white/80">
              <span className="font-semibold uppercase tracking-wide">Progress</span>
              <span className="tabular-nums">
                <span className="font-semibold text-white">{campaign.sent_count.toLocaleString()}</span>
                <span> / {campaign.total_recipients.toLocaleString()} sent</span>
                <span className="ml-2 rounded-full bg-white/15 px-1.5 py-0.5 font-semibold text-white">
                  {sentPct}%
                </span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-black/20 ring-1 ring-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 via-emerald-300 to-emerald-100 transition-all duration-700"
                style={{ width: `${Math.max(2, sentPct)}%` }}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {/* Hero rate tiles — the two metrics operators care most about */}
          <div className="grid gap-4 md:grid-cols-2">
            <RateHero
              label="Delivery rate"
              numerator={campaign.delivered_count}
              denominator={campaign.sent_count}
              icon={Check}
              variant="emerald"
              footnote={
                campaign.sent_count > 0 && campaign.delivered_count === 0
                  ? "Awaiting delivery webhooks from Meta"
                  : `${campaign.delivered_count.toLocaleString()} of ${campaign.sent_count.toLocaleString()} sent`
              }
            />
            <RateHero
              label="Reply rate"
              numerator={repliedCount}
              denominator={campaign.sent_count}
              icon={Reply}
              variant="violet"
              footnote={`${repliedCount.toLocaleString()} repl${repliedCount === 1 ? "y" : "ies"} on ${campaign.sent_count.toLocaleString()} sent`}
            />
          </div>

          {/* Click-through + cost — CTR counts button taps; cost estimates
              the spend from the template category's per-message rate. */}
          <div className="grid gap-4 md:grid-cols-2">
            <RateHero
              label="Click rate (CTR)"
              numerator={workflowPct}
              denominator={100}
              icon={Reply}
              variant="violet"
              footnote={`${clicks.toLocaleString()} tap${clicks === 1 ? "" : "s"} on ${campaign.sent_count.toLocaleString()} sent · avg ${workflowPct}% of the workflow completed`}
            />
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <IndianRupee className="h-3.5 w-3.5" />
                Est. cost
              </div>
              <div className="mt-1 text-3xl font-bold tabular-nums">
                ₹{estCost.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {campaign.type === "template"
                  ? `${CATEGORY_LABEL[(templateCategory ?? "MARKETING").toUpperCase()] ?? "Marketing"} · ₹${perMsgRate} × ${campaign.sent_count.toLocaleString()} sent (est.)`
                  : "AI message — pricing varies"}
              </div>
            </div>
          </div>

          {/* All-up status grid — colored chips, not boring tiles */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
            <StatusChip label="Recipients" value={campaign.total_recipients} icon={Users} tint="slate" />
            <StatusChip label="Sent" value={campaign.sent_count} icon={Send} tint="sky" />
            <StatusChip label="Delivered" value={campaign.delivered_count} icon={Check} tint="emerald" />
            <StatusChip label="Read" value={campaign.read_count} icon={Eye} tint="amber" />
            <StatusChip label="Replied" value={repliedCount} icon={Reply} tint="violet" />
            <StatusChip
              label="Failed"
              value={campaign.failed_count}
              icon={X}
              tint={campaign.failed_count > 0 ? "rose" : "slate"}
            />
            <StatusChip
              label="Pending"
              value={Math.max(
                0,
                campaign.total_recipients -
                  campaign.sent_count -
                  campaign.failed_count -
                  campaign.unsubscribed_count,
              )}
              icon={Clock}
              tint="slate"
            />
          </div>

          {/* LSQ conversions — HT Done / Order Placed (package value) +
              Order Confirmed (order value). Placed up here with the rate cards. */}
          <ConversionsCard data={conversions} loading={convLoading} onRefresh={loadConversions} />

          {campaign.unsubscribed_count > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
              <X className="h-3.5 w-3.5" />
              <span>
                <span className="font-semibold tabular-nums">
                  {campaign.unsubscribed_count}
                </span>{" "}
                recipient
                {campaign.unsubscribed_count === 1 ? "" : "s"} unsubscribed via STOP
              </span>
            </div>
          ) : null}

          {/* Conversion funnel — derived ratios on top of the count tiles */}
          <FunnelCard campaign={campaign} />

          {/* Side-by-side: failure breakdown + button click breakdown */}
          <div className="grid gap-4 lg:grid-cols-2">
            <FailureBreakdown recipients={recipients} campaignId={id} onRetried={load} />
            <ButtonClicksBreakdown recipients={recipients} />
          </div>

          {/* Per-recipient workflow completion — how far each tapper got
              through the template-reply flow. */}
          <WorkflowProgressCard progress={workflowProgress} />

          {/* Replies inbox — show actual reply text from recipients */}
          <RepliesInbox recipients={recipients} />

          {/* Body preview */}
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <header className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {campaign.type === "magic_message" ? "AI brief" : "Template"}
            </header>
            <div className="px-4 py-3 text-[13px] leading-relaxed">
              {campaign.type === "magic_message" ? (
                <>
                  <p className="whitespace-pre-wrap">{campaign.magic_prompt}</p>
                  {campaign.magic_tone ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      <span className="font-semibold">Tone:</span> {campaign.magic_tone}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="font-mono text-xs text-muted-foreground">
                    {campaign.template_name} · {campaign.template_language}
                  </p>
                  {campaign.template_body_preview ? (
                    <p className="mt-2 whitespace-pre-wrap">{campaign.template_body_preview}</p>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* Recipients */}
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <header className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Recipients ({recipients.length})
              </span>
            </header>
            <RecipientsTable recipients={recipients} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversion funnel — Sent → Delivered → Read → Replied as a percentage
// ladder. Each step shows what fraction of the previous made it through.
// ---------------------------------------------------------------------------
function FunnelCard({ campaign }: { campaign: Campaign }) {
  const total = campaign.total_recipients;
  if (total === 0) return null;
  const pct = (n: number, base: number) => (base > 0 ? Math.round((n / base) * 100) : 0);
  const steps = [
    { label: "Recipients", value: total, of: null as number | null, color: "bg-secondary" },
    { label: "Sent", value: campaign.sent_count, of: total, color: "bg-sky-500" },
    { label: "Delivered", value: campaign.delivered_count, of: campaign.sent_count, color: "bg-emerald-400" },
    { label: "Read", value: campaign.read_count, of: campaign.delivered_count, color: "bg-emerald-600" },
    { label: "Replied", value: campaign.replied_count, of: campaign.read_count, color: "bg-primary" },
  ];
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Conversion funnel
      </header>
      <ul className="divide-y">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-24 shrink-0 text-xs font-semibold">{s.label}</span>
            <div className="flex-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", s.color)}
                  style={{ width: `${Math.max(2, pct(s.value, total))}%` }}
                />
              </div>
            </div>
            <span className="w-32 shrink-0 text-right tabular-nums text-xs">
              <span className="font-semibold">{s.value.toLocaleString()}</span>
              {s.of !== null && i > 0 ? (
                <span className="ml-1 text-muted-foreground">
                  · {pct(s.value, s.of)}% of {steps[i - 1].label.toLowerCase()}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagement timeline — buckets sent / delivered / read / replied events
// into 12 time slots between the campaign's first and last activity.
// Lightweight stacked bar chart, no external dep.
// ---------------------------------------------------------------------------
function EngagementTimeline({ recipients }: { recipients: Recipient[] }) {
  const events = useMemo(() => {
    const out: Array<{ at: number; kind: "sent" | "delivered" | "read" | "replied" | "failed" }> = [];
    for (const r of recipients) {
      if (r.sent_at) out.push({ at: new Date(r.sent_at).getTime(), kind: r.status === "failed" ? "failed" : "sent" });
      if (r.delivered_at) out.push({ at: new Date(r.delivered_at).getTime(), kind: "delivered" });
      if (r.read_at) out.push({ at: new Date(r.read_at).getTime(), kind: "read" });
      if (r.replied_at) out.push({ at: new Date(r.replied_at).getTime(), kind: "replied" });
    }
    return out;
  }, [recipients]);

  if (events.length === 0) {
    return null;
  }

  const min = Math.min(...events.map((e) => e.at));
  const max = Math.max(...events.map((e) => e.at));
  const span = Math.max(1000, max - min);
  const SLOTS = 16;
  const buckets: Record<string, Record<string, number>> = {};
  let maxBucket = 0;
  for (const e of events) {
    const i = Math.min(SLOTS - 1, Math.floor(((e.at - min) / span) * SLOTS));
    const key = String(i);
    buckets[key] = buckets[key] ?? { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 };
    buckets[key][e.kind] = (buckets[key][e.kind] ?? 0) + 1;
    const total =
      buckets[key].sent +
      buckets[key].delivered +
      buckets[key].read +
      buckets[key].replied +
      buckets[key].failed;
    if (total > maxBucket) maxBucket = total;
  }

  const fmt = (ts: number) =>
    new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Engagement timeline
        </span>
        <span className="text-[10px] text-muted-foreground">
          {fmt(min)} → {fmt(max)}
        </span>
      </header>
      <div className="px-4 py-4">
        <div className="flex h-32 items-end gap-1">
          {Array.from({ length: SLOTS }).map((_, i) => {
            const b = buckets[String(i)] ?? { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 };
            const totalH = (n: number) => (maxBucket > 0 ? (n / maxBucket) * 100 : 0);
            const total = b.sent + b.delivered + b.read + b.replied + b.failed;
            const seg = (n: number, color: string, lbl: string) =>
              n ? (
                <div
                  className={cn("flex items-center justify-center", color)}
                  style={{ height: `${totalH(n)}%` }}
                  title={`${n} ${lbl}`}
                >
                  {totalH(n) >= 14 ? (
                    <span className="text-[9px] font-bold leading-none text-white tabular-nums">{n}</span>
                  ) : null}
                </div>
              ) : null;
            return (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end">
                {total > 0 ? (
                  <span className="mb-0.5 text-[9px] font-semibold leading-none text-muted-foreground tabular-nums">
                    {total}
                  </span>
                ) : null}
                <div className="flex w-full flex-1 flex-col-reverse gap-px overflow-hidden rounded-t">
                  {seg(b.sent, "bg-sky-300", "sent")}
                  {seg(b.delivered, "bg-emerald-400", "delivered")}
                  {seg(b.read, "bg-emerald-600", "read")}
                  {seg(b.replied, "bg-primary", "replied")}
                  {seg(b.failed, "bg-rose-400", "failed")}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <LegendDot color="bg-sky-300" label="Sent" />
          <LegendDot color="bg-emerald-400" label="Delivered" />
          <LegendDot color="bg-emerald-600" label="Read" />
          <LegendDot color="bg-primary" label="Replied" />
          <LegendDot color="bg-rose-400" label="Failed" />
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-2 w-2 rounded-sm", color)} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Failure breakdown — group recipients by failure reason / Meta error code.
// Most useful when the operator is debugging "why didn't this go through?".
// ---------------------------------------------------------------------------
function FailureBreakdown({ recipients, campaignId, onRetried }: { recipients: Recipient[]; campaignId?: string; onRetried?: () => void }) {
  const failures = recipients.filter((r) => r.status === "failed");
  const skipped = recipients.filter((r) => r.status === "skipped");
  const [retrying, setRetrying] = useState(false);
  async function retryFailed() {
    if (!campaignId || retrying) return;
    setRetrying(true);
    try {
      await fetch(`/api/campaigns/${campaignId}/retry-failed`, { method: "POST" });
      onRetried?.();
    } finally {
      setRetrying(false);
    }
  }
  const retryBtn =
    campaignId && (failures.length > 0 || skipped.length > 0) ? (
      <button
        type="button"
        onClick={retryFailed}
        disabled={retrying}
        className="rounded-md border border-rose-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
      >
        {retrying ? "Retrying…" : "Retry failed"}
      </button>
    ) : null;
  if (failures.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Failure breakdown</span>
          <div className="flex items-center gap-2">
            {retryBtn}
            {skipped.length > 0 ? (
              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
                {skipped.length} skipped
              </span>
            ) : null}
          </div>
        </header>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {skipped.length > 0 ? (
            <>Send-once guard ne {skipped.length} skip kiya (already received, ya purana attempt). Retry se phir bhej sakte ho.</>
          ) : (
            <>
              <Check className="mx-auto mb-1.5 h-5 w-5 text-emerald-500" />
              No failures yet.
            </>
          )}
        </div>
      </div>
    );
  }

  // Group by error code → reason
  const groups = new Map<string, { code: string | null; reason: string; count: number; sample: string }>();
  for (const r of failures) {
    const key = r.error_code ?? r.failed_reason?.slice(0, 60) ?? "unknown";
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, {
        code: r.error_code,
        reason: classifyError(r.error_code, r.failed_reason),
        count: 1,
        sample: r.failed_reason ?? "—",
      });
    }
  }
  const list = Array.from(groups.values()).sort((a, b) => b.count - a.count);

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Failure breakdown
        </span>
        <div className="flex items-center gap-2">
          {retryBtn}
          <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-200">
            {failures.length} failed
          </span>
        </div>
      </header>
      <ul className="divide-y">
        {list.map((g) => (
          <li key={(g.code ?? "x") + g.sample} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{g.reason}</span>
              {g.code ? (
                <span className="rounded-full bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-700 ring-1 ring-rose-200">
                  #{g.code}
                </span>
              ) : null}
              <span className="ml-auto text-xs font-semibold tabular-nums text-rose-700">
                {g.count}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {g.sample}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function classifyError(code: string | null, raw: string | null): string {
  switch (code) {
    case "131026":
      return "Outside 24h customer-care window";
    case "131056":
      return "Rate limited by Meta";
    case "131047":
      return "Re-engagement window expired";
    case "131051":
      return "Unsupported message type";
    case "132000":
    case "132001":
      return "Template paused or doesn't exist";
    case "132005":
      return "Template content mismatch";
    case "132012":
      return "Template variable count mismatch";
    case "132015":
      return "Template paused for low quality";
    case "132016":
      return "Template disabled";
    case "131031":
      return "Account banned";
    case "133010":
      return "Phone number not registered";
    case "100":
      return "Invalid parameter / unknown number";
    case "190":
      return "Access token invalid";
    default:
      return raw ? raw.split(":").slice(0, 1)[0].slice(0, 60) : "Send failed";
  }
}

// ---------------------------------------------------------------------------
// Button clicks — for templates with Quick Reply / URL / Phone buttons,
// which button did each recipient tap? Aggregated by button label.
// ---------------------------------------------------------------------------
// Per-recipient workflow completion — how far each person who tapped got
// through the template-reply flow (0–100%).
function PkgContainer({
  title,
  bucket,
  inr,
  hasData,
}: {
  title: string;
  bucket: PkgBucket | undefined;
  inr: (n: number) => string;
  hasData: boolean;
}) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-emerald-900">{title}</span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
          {bucket?.count ?? 0}
        </span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-emerald-900">
        {inr(bucket?.total_value ?? 0)}
        <span className="ml-1 text-[10px] font-normal text-emerald-700">total package value</span>
      </div>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
        {(bucket?.items ?? []).map((i) => (
          <li key={i.wa_id} className="rounded-md bg-white px-2 py-1.5 text-[11px] ring-1 ring-emerald-100">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{i.name || i.wa_id}</span>
              <span className="shrink-0 font-semibold tabular-nums">{inr(i.package_value)}</span>
            </div>
            {i.notes ? <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground/80">{i.notes}</div> : null}
          </li>
        ))}
        {hasData && (bucket?.count ?? 0) === 0 ? (
          <li className="py-2 text-center text-[11px] text-muted-foreground">Koi nahi pahuncha.</li>
        ) : null}
      </ul>
    </div>
  );
}

function ConversionsCard({
  data,
  loading,
  onRefresh,
}: {
  data: ConversionData | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const hasAny =
    data &&
    (data.ht_done.count > 0 ||
      data.order_placed.count > 0 ||
      data.order.count > 0 ||
      (data.booked?.count ?? 0) > 0);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          LSQ conversions
        </span>
        <span className="text-[10px] text-muted-foreground">— campaign ke baad stage progress</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {loading ? "Checking LSQ…" : "Refresh"}
        </button>
      </header>
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Booked container — anyone with a booking */}
        <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-sky-900">Booked</span>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">
              {data?.booked?.count ?? 0}
            </span>
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-sky-900">
            {inr(data?.booked?.total_value ?? 0)}
            <span className="ml-1 text-[10px] font-normal text-sky-700">total booking</span>
          </div>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {(data?.booked?.items ?? []).map((i) => (
              <li key={i.wa_id} className="rounded-md bg-white px-2 py-1.5 text-[11px] ring-1 ring-sky-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{i.name || i.wa_id}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{inr(i.booking_amount)}</span>
                </div>
                {i.booking_date ? <div className="text-[10px] text-muted-foreground">{i.booking_date}</div> : null}
              </li>
            ))}
            {data && (data.booked?.count ?? 0) === 0 ? (
              <li className="py-2 text-center text-[11px] text-muted-foreground">Koi nahi.</li>
            ) : null}
          </ul>
        </div>

        {/* HT Done container */}
        <PkgContainer title="HT Done" bucket={data?.ht_done} inr={inr} hasData={!!data} />

        {/* Order Placed container */}
        <PkgContainer title="Order Placed" bucket={data?.order_placed} inr={inr} hasData={!!data} />

        {/* Order container — Order Confirmed */}
        <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-violet-900">Order Confirmed</span>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-800">
              {data?.order.count ?? 0}
            </span>
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-violet-900">
            {inr(data?.order.total_value ?? 0)}
            <span className="ml-1 text-[10px] font-normal text-violet-700">total order value</span>
          </div>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {(data?.order.items ?? []).map((i) => (
              <li key={i.wa_id} className="rounded-md bg-white px-2 py-1.5 text-[11px] ring-1 ring-violet-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{i.name || i.wa_id}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{inr(i.order_value)}</span>
                </div>
                {i.confirmed_date ? (
                  <div className="text-[10px] text-muted-foreground">Confirmed: {i.confirmed_date}</div>
                ) : null}
              </li>
            ))}
            {data && data.order.count === 0 ? (
              <li className="py-2 text-center text-[11px] text-muted-foreground">Koi nahi pahuncha.</li>
            ) : null}
          </ul>
        </div>
      </div>
      {data ? (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground">
          {data.total_recipients} recipients · auto-sync (har 30s) — stage live, values LSQ se backfill
          {!hasAny && !loading ? " · abhi koi conversion nahi" : ""}
        </div>
      ) : loading ? (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground">LSQ se stages check ho rahe hain…</div>
      ) : null}
    </div>
  );
}

function WorkflowProgressCard({
  progress,
}: {
  progress: Array<{ wa_id: string; display_name: string | null; replies: number; pct: number }>;
}) {
  if (progress.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Workflow completion (by recipient)
        </span>
        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-100">
          {progress.length} tapped
        </span>
      </header>
      <div className="divide-y">
        {progress.map((p) => (
          <div key={p.wa_id} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] font-medium">
                {p.display_name || formatPhone(p.wa_id)}
                <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                  {formatPhone(p.wa_id)}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-violet-700">
                {p.pct}%
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                  style={{ width: `${p.pct}%` }}
                />
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {p.replies} repl{p.replies === 1 ? "y" : "ies"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ButtonClicksBreakdown({ recipients }: { recipients: Recipient[] }) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const clicks = recipients
    .filter((r) => r.button_clicked)
    .sort((a, b) => {
      const ta = a.button_clicked_at ? new Date(a.button_clicked_at).getTime() : 0;
      const tb = b.button_clicked_at ? new Date(b.button_clicked_at).getTime() : 0;
      return tb - ta;
    });

  // CSV holds the REAL number / name / lead id (admin export), unlike the
  // on-screen list which stays masked.
  function exportCsv() {
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Name", "Lead Number", "Number", "Button", "Tapped at"];
    const rows = clicks.map((r) =>
      [r.display_name ?? "", r.lead_number ? `#${r.lead_number}` : "", r.wa_id ?? "", r.button_clicked ?? "", r.button_clicked_at ?? ""]
        .map(esc)
        .join(","),
    );
    const blob = new Blob(["﻿" + [header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "button-clicks.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (clicks.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <header className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Button clicks
        </header>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No button taps yet. Will populate as recipients tap Quick Reply / URL / Phone buttons.
        </div>
      </div>
    );
  }

  // Per-button tap counts (chips).
  const groups = new Map<string, number>();
  for (const r of clicks) groups.set(r.button_clicked ?? "—", (groups.get(r.button_clicked ?? "—") ?? 0) + 1);
  const summary = Array.from(groups.entries()).sort((a, b) => b[1] - a[1]);

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Button clicks</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-white px-2 py-0.5 text-[10px] font-semibold text-primary transition hover:bg-primary/5"
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-primary/20">
            {clicks.length} taps
          </span>
        </div>
      </header>
      {/* Per-button summary */}
      <div className="flex flex-wrap gap-1.5 border-b bg-secondary/20 px-4 py-2">
        {summary.map(([label, count]) => (
          <span key={label} className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium ring-1 ring-border">
            {label} · <span className="font-bold text-primary">{count}</span>
          </span>
        ))}
      </div>
      {/* Per-tapper list — name · lead id · number · button */}
      <ul className="max-h-72 divide-y overflow-y-auto">
        {clicks.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-4 py-2 text-xs">
            <span className="w-24 shrink-0 truncate font-medium">{r.display_name ? maskName(r.display_name) : <span className="text-muted-foreground/60">No name</span>}</span>
            <span className="w-16 shrink-0 truncate font-mono text-[10px] text-muted-foreground" title={r.lead_number ? `#${r.lead_number}` : ""}>{r.lead_number ? `#${r.lead_number}` : "—"}</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{maskPhone(formatPhone(r.wa_id))}</span>
            <span className="ml-auto max-w-[40%] truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary" title={r.button_clicked ?? ""}>{r.button_clicked}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Replies inbox — show the actual reply text customers sent in.
// ---------------------------------------------------------------------------
function RepliesInbox({ recipients }: { recipients: Recipient[] }) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const replies = recipients
    .filter((r) => r.reply_text || r.button_clicked)
    .sort((a, b) => {
      const ta = a.replied_at ? new Date(a.replied_at).getTime() : 0;
      const tb = b.replied_at ? new Date(b.replied_at).getTime() : 0;
      return tb - ta;
    });

  if (replies.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Replies received
        </span>
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-primary/20">
          {replies.length}
        </span>
      </header>
      <ul className="max-h-72 divide-y overflow-y-auto">
        {replies.slice(0, 100).map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{maskName(r.display_name ?? formatPhone(r.wa_id))}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{maskPhone(formatPhone(r.wa_id))}</span>
              {r.button_clicked ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-200">
                  ↩ {r.button_clicked}
                </span>
              ) : null}
              {r.replied_at ? (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {new Date(r.replied_at).toLocaleString(undefined, {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}
            </div>
            {r.reply_text ? (
              <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-foreground/85">
                &ldquo;{r.reply_text}&rdquo;
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RateHero({
  label,
  numerator,
  denominator,
  icon: Icon,
  variant,
  footnote,
}: {
  label: string;
  numerator: number;
  denominator: number;
  icon: React.ComponentType<{ className?: string }>;
  variant: "emerald" | "violet";
  footnote?: string;
}) {
  const pct = denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
  const palette =
    variant === "emerald"
      ? {
          bg: "bg-gradient-to-br from-emerald-50 via-emerald-50 to-white",
          ring: "ring-emerald-100",
          accent: "text-emerald-700",
          fill: "bg-gradient-to-r from-emerald-400 to-emerald-600",
          chipBg: "bg-emerald-600",
        }
      : {
          bg: "bg-gradient-to-br from-violet-50 via-fuchsia-50 to-white",
          ring: "ring-violet-100",
          accent: "text-violet-700",
          fill: "bg-gradient-to-r from-violet-500 to-fuchsia-500",
          chipBg: "bg-violet-600",
        };
  // Bump animation when pct changes (live polling).
  const prev = useRef(pct);
  const bump = pct !== prev.current ? Date.now() : null;
  useEffect(() => {
    prev.current = pct;
  }, [pct]);
  return (
    <div className={cn("rounded-2xl border bg-card p-5 shadow-sm ring-1", palette.bg, palette.ring)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm",
              palette.chipBg,
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span
          key={bump ?? pct}
          className={cn(
            "text-4xl font-semibold tabular-nums",
            palette.accent,
            bump !== null && "campaign-bump",
          )}
        >
          {pct}
        </span>
        <span className={cn("text-lg font-semibold", palette.accent)}>%</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary/70">
        <div
          className={cn("h-full rounded-full transition-all duration-700", palette.fill)}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      {footnote ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{footnote}</p>
      ) : null}
    </div>
  );
}

function StatusChip({
  label,
  value,
  icon: Icon,
  tint,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tint: "slate" | "sky" | "emerald" | "amber" | "violet" | "rose";
}) {
  const palettes: Record<string, { bg: string; text: string; ring: string; iconBg: string }> = {
    slate: { bg: "bg-slate-50", text: "text-slate-900", ring: "ring-slate-200", iconBg: "bg-slate-200 text-slate-700" },
    sky: { bg: "bg-sky-50", text: "text-sky-900", ring: "ring-sky-200", iconBg: "bg-sky-100 text-sky-700" },
    emerald: { bg: "bg-emerald-50", text: "text-emerald-900", ring: "ring-emerald-200", iconBg: "bg-emerald-100 text-emerald-700" },
    amber: { bg: "bg-amber-50", text: "text-amber-900", ring: "ring-amber-200", iconBg: "bg-amber-100 text-amber-700" },
    violet: { bg: "bg-violet-50", text: "text-violet-900", ring: "ring-violet-200", iconBg: "bg-violet-100 text-violet-700" },
    rose: { bg: "bg-rose-50", text: "text-rose-900", ring: "ring-rose-200", iconBg: "bg-rose-100 text-rose-700" },
  };
  const p = palettes[tint];
  const prev = useRef(value);
  const bump = value !== prev.current ? Date.now() : null;
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl px-3 py-2.5 ring-1 ring-inset", p.bg, p.ring)}>
      <div className="flex items-center gap-1.5">
        <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md", p.iconBg)}>
          <Icon className="h-2.5 w-2.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <span
        key={bump ?? value}
        className={cn("text-xl font-semibold tabular-nums", p.text, bump !== null && "campaign-bump")}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}


function RecipientsTable({ recipients }: { recipients: Recipient[] }) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const [filter, setFilter] = useState<string>("all");
  const filtered = useMemo(() => {
    if (filter === "all") return recipients;
    return recipients.filter((r) => r.status === filter);
  }, [recipients, filter]);

  if (recipients.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
        No recipients yet.
      </div>
    );
  }

  const counts = recipients.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const STATUSES = ["all", "pending", "sent", "delivered", "read", "replied", "failed", "unsubscribed"];

  return (
    <>
      <div className="flex flex-wrap gap-1 border-b px-3 py-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-medium transition",
              filter === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80",
            )}
          >
            {s} {s !== "all" ? `(${counts[s] ?? 0})` : `(${recipients.length})`}
          </button>
        ))}
      </div>
      <ul className="max-h-[520px] divide-y overflow-y-auto">
        {filtered.slice(0, 500).map((r) => (
          <li key={r.id} className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {maskPhone(formatPhone(r.wa_id))}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {r.display_name ? maskName(r.display_name) : "—"}
              </span>
              {r.button_clicked ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-200">
                  ↩ {r.button_clicked}
                </span>
              ) : null}
              <RecipientStatusBadge status={r.status} />
            </div>
            {/* Inline detail row — shows whichever piece of info is
                most useful for THIS recipient: AI-generated text,
                their reply, or the failure reason. */}
            {r.status === "failed" && (r.failed_reason || r.error_code) ? (
              <p className="mt-1 line-clamp-2 text-[10px] text-rose-700">
                {r.error_code ? <span className="font-mono">#{r.error_code} · </span> : null}
                {r.failed_reason}
              </p>
            ) : r.reply_text ? (
              <p className="mt-1 line-clamp-2 text-[11px] italic text-foreground/80">
                ↩ &ldquo;{r.reply_text}&rdquo;
              </p>
            ) : r.generated_text ? (
              <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">
                {r.generated_text}
              </p>
            ) : null}
            {/* Timing chips — only for recipients past the sent state */}
            {r.sent_at ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                {r.sent_at ? <span>Sent {fmtRelative(r.sent_at)}</span> : null}
                {r.delivered_at ? <span>· Delivered {fmtRelative(r.delivered_at)}</span> : null}
                {r.read_at ? <span>· Read {fmtRelative(r.read_at)}</span> : null}
                {r.replied_at ? (
                  <span className="font-semibold text-primary">· Replied {fmtRelative(r.replied_at)}</span>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
        {filtered.length > 500 ? (
          <li className="px-4 py-3 text-center text-[11px] text-muted-foreground">
            Showing first 500 of {filtered.length}.
          </li>
        ) : null}
      </ul>
    </>
  );
}

function fmtInr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

function fmtRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function RecipientStatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    pending: "bg-secondary text-muted-foreground",
    sending: "bg-amber-50 text-amber-800 ring-amber-200",
    sent: "bg-sky-50 text-sky-800 ring-sky-200",
    delivered: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    read: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    replied: "bg-primary/10 text-primary ring-primary/30",
    failed: "bg-rose-50 text-rose-700 ring-rose-200",
    skipped: "bg-secondary text-muted-foreground",
    unsubscribed: "bg-amber-100 text-amber-900 ring-amber-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        tone[status] ?? "bg-secondary text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RECURRING (DAILY DYNAMIC) CAMPAIGNS — list + manage. Each re-runs daily
// against a rolling LSQ filter, sending the template to NEW matches only.
// ---------------------------------------------------------------------------
interface RecurringRow {
  id: string;
  name: string;
  business_phone_number_id: string;
  template_name: string;
  window_days: number;
  filter: {
    stages?: string[];
    sources?: string[];
    sub_sources?: string[];
    brands?: string[];
    owners?: string[];
  } | null;
  enabled: boolean;
  last_run_at: string | null;
  last_run_matched: number | null;
  last_run_sent: number | null;
  last_run_error: string | null;
  total_sent: number;
}

function RecurringList({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<RecurringRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/recurring", { cache: "no-store" });
      const j = (await r.json()) as { recurring?: RecurringRow[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRows(j.recurring ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  async function toggle(d: RecurringRow) {
    setBusy(d.id);
    try {
      await fetch(`/api/recurring/${d.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }
  async function remove(d: RecurringRow) {
    if (!confirm(`Delete daily campaign "${d.name}"?`)) return;
    setBusy(d.id);
    try {
      await fetch(`/api/recurring/${d.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={Clock}
        title="Daily campaigns"
        subtitle="Dynamic — har din LSQ filter dobara chalega, sirf naye matching leads ko template jaayega (ek lead ek hi baar)."
        tone="emerald"
        right={
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {rows === null ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center">
              <Clock className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-2 text-sm font-medium">Koi daily campaign nahi hai.</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                New campaign → From LSQ filter → Schedule step me "Repeat daily" ON karo.
              </p>
            </div>
          ) : (
            rows.map((d) => {
              const f = d.filter ?? {};
              const chips: string[] = [];
              if (f.stages?.length) chips.push(`Stage: ${f.stages.join(", ")}`);
              if (f.brands?.length) chips.push(`Brand: ${f.brands.join(", ")}`);
              if (f.sources?.length) chips.push(`Source: ${f.sources.join(", ")}`);
              if (f.sub_sources?.length) chips.push(`Sub: ${f.sub_sources.join(", ")}`);
              if (f.owners?.length) chips.push(`Owner: ${f.owners.join(", ")}`);
              return (
                <div key={d.id} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                        d.enabled ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-400 ring-slate-200",
                      )}
                    >
                      <Clock className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{d.name}</span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
                            d.enabled ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200",
                          )}
                        >
                          {d.enabled ? "On" : "Off"}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Template <span className="font-mono">{d.template_name}</span> · last {d.window_days} days
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                        {chips.map((c, i) => (
                          <span key={i} className="rounded-md bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700 ring-1 ring-inset ring-sky-200">
                            {c}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>Total sent: {d.total_sent.toLocaleString()}</span>
                        {d.last_run_at ? (
                          <span>
                            Last run: {fmtRelative(d.last_run_at)} · {d.last_run_sent ?? 0} sent / {d.last_run_matched ?? 0} matched
                          </span>
                        ) : (
                          <span>Not run yet</span>
                        )}
                      </div>
                      {d.last_run_error ? (
                        <div className="mt-1 text-[11px] text-rose-600">⚠ {d.last_run_error}</div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggle(d)}
                        disabled={busy === d.id}
                        className={cn(
                          "rounded-md px-2.5 py-1.5 text-xs font-semibold ring-1 ring-inset transition disabled:opacity-50",
                          d.enabled
                            ? "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100"
                            : "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100",
                        )}
                      >
                        {d.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(d)}
                        disabled={busy === d.id}
                        className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 transition hover:bg-rose-100 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
