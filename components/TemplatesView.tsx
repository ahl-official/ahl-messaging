"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Check,
  Copy,
  ExternalLink,
  LayoutTemplate,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { TemplateSummary } from "@/components/TemplatePicker";
import { QuickRepliesManager } from "@/components/QuickRepliesManager";
import { PortfolioNumberPicker } from "@/components/PortfolioNumberPicker";
import { PremiumHeader } from "@/components/PremiumHeader";

interface Props {
  wabaId: string | null;
}

interface NumberOption {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  is_active: boolean;
  portfolio: { key: string; name: string } | null;
}

type Tab = "library" | "active" | "deleted" | "quickreplies";

interface ApiResponse {
  templates: TemplateSummary[];
  business_account_id?: string;
  error?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Promotional",
  UTILITY: "Transactional",
  AUTHENTICATION: "Authentication",
  SERVICE: "Service Alerts",
};

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-primary/15 text-primary",
  PENDING: "bg-amber-100 text-amber-800",
  REJECTED: "bg-red-100 text-red-800",
  PAUSED: "bg-slate-200 text-slate-700",
  IN_APPEAL: "bg-amber-100 text-amber-800",
};

const CATEGORY_BADGE: Record<string, string> = {
  UTILITY:        "bg-sky-50 text-sky-800 ring-sky-200",
  MARKETING:      "bg-amber-50 text-amber-900 ring-amber-200",
  AUTHENTICATION: "bg-purple-50 text-purple-800 ring-purple-200",
  SERVICE:        "bg-slate-50 text-slate-700 ring-slate-200",
};

const CATEGORY_LABEL_SHORT: Record<string, string> = {
  UTILITY: "Utility",
  MARKETING: "Marketing",
  AUTHENTICATION: "Auth",
  SERVICE: "Service",
};

function displayCategory(raw: string): string {
  return CATEGORY_LABEL[raw] ?? raw.charAt(0) + raw.slice(1).toLowerCase();
}

export function TemplatesView({ wabaId: initialWabaId }: Props) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [wabaId, setWabaId] = useState<string | null>(initialWabaId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("library");
  const [query, setQuery] = useState("");

  // Per-number template view: each portfolio has its own Meta App and its
  // own template library. Picker chip drives which portfolio's templates
  // we fetch — same UX as the AutomationView number tabs.
  const [numbers, setNumbers] = useState<NumberOption[] | null>(null);
  const [portfolioKey, setPortfolioKey] = useState<string | null>(null);
  // Templates live at the PORTFOLIO (WABA) level — every number under
  // the same portfolio shares the same template library. But the UI
  // chip strip is per phone-number, so track the active phone id
  // separately to highlight exactly the one the operator clicked, not
  // every sibling under the same portfolio.
  const [activePhoneId, setActivePhoneId] = useState<string | null>(null);

  // Query string that pins every templates request (create / edit /
  // delete) to the SELECTED number — so they land on the same WABA the
  // list was read from. Without phone_number_id the API falls back to
  // the portfolio default and templates land on the wrong number.
  function scopeQs(): string {
    const p = new URLSearchParams();
    if (portfolioKey) p.set("portfolio_key", portfolioKey);
    if (activePhoneId) p.set("phone_number_id", activePhoneId);
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  // Scope the template fetch by the SELECTED phone number id. The API
  // resolves it to the owning portfolio (WABA), so two numbers under
  // different portfolios show their own libraries — and switching
  // between numbers always refetches against the right account.
  function load(phoneId?: string | null) {
    setLoading(true);
    setError(null);
    const pid = phoneId !== undefined ? phoneId : activePhoneId;
    const url = pid
      ? `/api/templates?phone_number_id=${encodeURIComponent(pid)}`
      : "/api/templates";
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as ApiResponse;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((data) => {
        setTemplates(data.templates);
        if (data.business_account_id) setWabaId(data.business_account_id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleDelete(id: string, name: string): Promise<void> {
    setError(null);
    try {
      const url = `/api/templates/${encodeURIComponent(id)}${scopeQs()}`;
      const res = await fetch(url, { method: "DELETE" });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      // Optimistically drop the row — list will be re-fetched on next refresh.
      setTemplates((prev) => (prev ?? []).filter((t) => t.id !== id));
    } catch (e) {
      setError(`Failed to delete "${name}": ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  // Load the connected-numbers list once so the picker has options. We then
  // pick the first number with a portfolio as the default selection.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/business-numbers", { cache: "no-store" });
        const json = (await res.json()) as { numbers?: NumberOption[] };
        if (cancelled) return;
        const list = (json.numbers ?? []).filter((n) => n.portfolio);
        setNumbers(list);
        const first = list.find((n) => n.is_active) ?? list[0] ?? null;
        const key = first?.portfolio?.key ?? null;
        setPortfolioKey(key);
        setActivePhoneId(first?.phone_number_id ?? null);
        load(first?.phone_number_id ?? null);
      } catch {
        if (!cancelled) {
          setNumbers([]);
          load(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // load() and portfolioKey deliberately omitted — first selection drives
    // the initial fetch; subsequent fetches happen via switchPortfolio().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchPortfolio(key: string | null, phoneId: string | null) {
    // Always refetch against the clicked number — the API scopes by
    // phone_number_id, so even sibling numbers under the same WABA get
    // a fresh, correctly-attributed fetch.
    setActivePhoneId(phoneId);
    setPortfolioKey(key);
    load(phoneId);
  }

  const filtered = useMemo(() => {
    if (!templates) return [];
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (tab === "active" && t.status !== "APPROVED") return false;
      if (tab === "deleted" && t.status !== "REJECTED" && t.status !== "PAUSED") return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    });
  }, [templates, tab, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, TemplateSummary[]>();
    for (const t of filtered) {
      const key = t.category || "OTHER";
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const counts = useMemo(() => {
    const all = templates ?? [];
    return {
      library: all.length,
      active: all.filter((t) => t.status === "APPROVED").length,
      deleted: all.filter((t) => t.status === "REJECTED" || t.status === "PAUSED").length,
    };
  }, [templates]);

  // --- Copy template to other portfolios ---------------------------------
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTplIds, setCopyTplIds] = useState<Set<string>>(new Set());
  const [copyPids, setCopyPids] = useState<Set<string>>(new Set());
  const [copyActiveKey, setCopyActiveKey] = useState<string | null>(null);
  const [copyRunning, setCopyRunning] = useState(false);
  const [copyResults, setCopyResults] = useState<
    Array<{ template: string; portfolio: string; ok: boolean; status?: string; error?: string }> | null
  >(null);

  // Target portfolios = every Meta portfolio (including the one we're viewing —
  // a portfolio can span multiple WABAs via per-number overrides, so copying to
  // a sibling number on a different WABA is valid; copying onto the source WABA
  // just collides on the name and is reported per-target). Each carries its
  // actual numbers so the modal shows a number checkbox list under the clicked
  // portfolio. Interakt/Evolution can't host Meta templates, so they're dropped.
  const targetPortfolios = useMemo(() => {
    const m = new Map<string, { key: string; name: string; numbers: NumberOption[] }>();
    for (const n of numbers ?? []) {
      const pk = n.portfolio?.key ?? null;
      if (!pk) continue;
      if (n.phone_number_id.startsWith("evo:") || n.phone_number_id.startsWith("interakt:")) continue;
      const cur = m.get(pk);
      if (cur) cur.numbers.push(n);
      else m.set(pk, { key: pk, name: n.portfolio?.name ?? pk, numbers: [n] });
    }
    return Array.from(m.values())
      .filter((p) => p.numbers.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [numbers]);

  function openCopy() {
    setCopyResults(null);
    setCopyTplIds(new Set());
    setCopyPids(new Set());
    setCopyActiveKey(targetPortfolios[0]?.key ?? null);
    setCopyOpen(true);
  }

  async function runCopy() {
    const chosen = (templates ?? []).filter((t) => copyTplIds.has(t.id));
    const targetPids = Array.from(copyPids);
    if (chosen.length === 0 || targetPids.length === 0) return;
    setCopyRunning(true);
    setCopyResults(null);
    try {
      const res = await fetch("/api/templates/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templates: chosen.map((t) => ({
            name: t.name,
            category: t.category,
            language: t.language,
            header_format: t.header_format,
            header_text: t.header_text,
            header_url: t.header_url,
            body: t.body,
            footer: t.footer,
            buttons: t.buttons,
          })),
          target_phone_number_ids: targetPids,
        }),
      });
      const j = (await res.json()) as {
        results?: Array<{ template: string; portfolio: string; ok: boolean; status?: string; error?: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setCopyResults(j.results ?? []);
    } catch (e) {
      setCopyResults([{ template: "—", portfolio: "—", ok: false, error: e instanceof Error ? e.message : "Copy failed." }]);
    } finally {
      setCopyRunning(false);
    }
  }

  const createUrl = wabaId
    ? `https://business.facebook.com/wa/manage/message-templates/?waba_id=${wabaId}`
    : "https://business.facebook.com/wa/manage/message-templates/";

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={LayoutTemplate}
        title="Templates"
        subtitle="Manage your approved WhatsApp templates and quick replies — per portfolio."
        tone="sky"
        right={
          tab !== "quickreplies" ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => load()}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30 disabled:opacity-50"
                title="Reload from Meta"
              >
                <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                Refresh
              </button>
              {targetPortfolios.length > 0 ? (
                <button
                  type="button"
                  onClick={openCopy}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30"
                  title="Copy templates to other portfolios"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy to…
                </button>
              ) : null}
              <Link
                href={`/templates/new${scopeQs()}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-primary shadow-lg shadow-primary/25 ring-1 ring-white/40 transition hover:shadow-xl"
              >
                <Plus className="h-3.5 w-3.5" />
                New template
              </Link>
            </div>
          ) : null
        }
      />

      {/* Number / portfolio picker — templates live per Meta App, so the
          card controls which portfolio's library we're looking at. */}
      {numbers && numbers.length > 0 ? (
        <div className="border-b bg-card px-6 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Number</div>
          <PortfolioNumberPicker
            numbers={numbers}
            activePhoneId={activePhoneId}
            onSelect={(id, key) => switchPortfolio(key, id)}
            excludeEvolution
            requirePortfolio
          />
        </div>
      ) : null}

      {/* Tabs + search */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-6 py-2">
        <div className="flex items-center gap-1">
          <TabButton label="Template Library" active={tab === "library"} count={counts.library} onClick={() => setTab("library")} />
          <TabButton label="Active" active={tab === "active"} count={counts.active} onClick={() => setTab("active")} />
          <TabButton label="Deleted" active={tab === "deleted"} count={counts.deleted} onClick={() => setTab("deleted")} />
        </div>
        {tab !== "quickreplies" ? (
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              className="pl-9 h-8 text-sm"
            />
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "quickreplies" ? (
          <QuickRepliesManager
            activePhoneId={activePhoneId}
            numbers={numbers ?? []}
          />
        ) : loading && !templates ? (
          <div className="grid h-40 place-items-center text-sm text-muted-foreground">
            Loading templates…
          </div>
        ) : error ? (
          <div className="mx-auto max-w-md rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <div className="font-semibold text-destructive">Couldn&apos;t load templates</div>
            <div className="mt-1 text-xs text-destructive/80">{error}</div>
            <button
              type="button"
              onClick={() => load()}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <RefreshCcw className="h-3 w-3" />
              Try again
            </button>
          </div>
        ) : grouped.length === 0 ? (
          <div className="grid h-40 place-items-center text-sm text-muted-foreground">
            {query
              ? "No templates match your search."
              : tab === "active"
                ? "No approved templates yet."
                : tab === "deleted"
                  ? "No rejected or paused templates."
                  : "No templates in this WhatsApp Business Account yet."}
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(([category, list]) => (
              <section key={category}>
                <header className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                      {displayCategory(category)}
                    </h2>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {list.length}
                    </span>
                  </div>
                  <span className="h-px flex-1 ml-4 bg-border" />
                </header>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {list.map((t) => (
                    <TemplateCard
                      key={t.id}
                      t={t}
                      scope={scopeQs()}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Footer link */}
        {!loading && !error ? (
          <div className="mt-6 border-t pt-4 text-center">
            <a
              href={createUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Manage templates in Meta Business Manager
            </a>
          </div>
        ) : null}
      </div>

      {copyOpen ? (
        <CopyTemplatesModal
          templates={(templates ?? []).filter((t) => t.status === "APPROVED")}
          targets={targetPortfolios}
          activeKey={copyActiveKey}
          tplIds={copyTplIds}
          pids={copyPids}
          running={copyRunning}
          results={copyResults}
          onSetActiveKey={setCopyActiveKey}
          onToggleTpl={(id) =>
            setCopyTplIds((s) => {
              const n = new Set(s);
              n.has(id) ? n.delete(id) : n.add(id);
              return n;
            })
          }
          onTogglePid={(pid) =>
            setCopyPids((s) => {
              const n = new Set(s);
              n.has(pid) ? n.delete(pid) : n.add(pid);
              return n;
            })
          }
          onToggleAll={(pids, on) =>
            setCopyPids((s) => {
              const n = new Set(s);
              for (const p of pids) on ? n.add(p) : n.delete(p);
              return n;
            })
          }
          onClose={() => setCopyOpen(false)}
          onRun={runCopy}
        />
      ) : null}
    </div>
  );
}

function CopyTemplatesModal({
  templates,
  targets,
  activeKey,
  tplIds,
  pids,
  running,
  results,
  onSetActiveKey,
  onToggleTpl,
  onTogglePid,
  onToggleAll,
  onClose,
  onRun,
}: {
  templates: TemplateSummary[];
  targets: Array<{ key: string; name: string; numbers: NumberOption[] }>;
  activeKey: string | null;
  tplIds: Set<string>;
  pids: Set<string>;
  running: boolean;
  results: Array<{ template: string; portfolio: string; ok: boolean; status?: string; error?: string }> | null;
  onSetActiveKey: (key: string) => void;
  onToggleTpl: (id: string) => void;
  onTogglePid: (pid: string) => void;
  onToggleAll: (pids: string[], on: boolean) => void;
  onClose: () => void;
  onRun: () => void;
}) {
  const canRun = tplIds.size > 0 && pids.size > 0 && !running;
  const activeGroup = targets.find((g) => g.key === activeKey) ?? targets[0] ?? null;
  const numLabel = (n: NumberOption) =>
    n.nickname?.trim() || n.verified_name?.trim() || n.display_phone_number || n.phone_number_id;

  const [tplQuery, setTplQuery] = useState("");
  const [numQuery, setNumQuery] = useState("");
  const tq = tplQuery.trim().toLowerCase();
  const filteredTemplates = tq
    ? templates.filter((t) => t.name.toLowerCase().includes(tq) || t.category.toLowerCase().includes(tq))
    : templates;
  const nq = numQuery.trim().toLowerCase();
  const filteredNumbers = (activeGroup?.numbers ?? []).filter((n) =>
    !nq
      ? true
      : numLabel(n).toLowerCase().includes(nq) ||
        (n.display_phone_number ?? "").toLowerCase().includes(nq) ||
        n.phone_number_id.toLowerCase().includes(nq),
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Copy templates to numbers</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {results ? (
            <div className="space-y-1.5">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {results.filter((r) => r.ok).length} of {results.length} submitted to Meta for review.
              </div>
              {results.map((r, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-3 py-2 text-xs",
                    r.ok ? "border-primary/25 bg-primary/10" : "border-red-200 bg-red-50",
                  )}
                >
                  <span className="font-medium">
                    {r.template} → {r.portfolio}
                  </span>
                  <span className={r.ok ? "text-primary" : "text-red-700"}>
                    {r.ok ? r.status ?? "PENDING" : r.error}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              {/* Templates */}
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Templates ({tplIds.size})
                </div>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={tplQuery}
                    onChange={(e) => setTplQuery(e.target.value)}
                    placeholder="Search templates"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                <div className="max-h-[48vh] space-y-1 overflow-auto">
                  {templates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No approved templates to copy.</p>
                  ) : filteredTemplates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No templates match &ldquo;{tplQuery}&rdquo;.</p>
                  ) : (
                    filteredTemplates.map((t) => {
                      const on = tplIds.has(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => onToggleTpl(t.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition",
                            on ? "border-primary/40 bg-primary/10" : "border-input hover:bg-secondary/50",
                          )}
                        >
                          <span
                            className={cn(
                              "grid h-4 w-4 shrink-0 place-items-center rounded border",
                              on ? "border-primary bg-primary text-white" : "border-input",
                            )}
                          >
                            {on ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{t.name}</span>
                            <span className="block text-[10px] text-muted-foreground">
                              {t.category} · {t.language}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Target numbers — pick a portfolio, then check its numbers */}
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Copy to numbers ({pids.size})
                </div>
                {/* Portfolio cards */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {targets.map((p) => {
                    const sel = p.numbers.filter((n) => pids.has(n.phone_number_id)).length;
                    const active = activeGroup?.key === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          onSetActiveKey(p.key);
                          setNumQuery("");
                        }}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition",
                          active ? "border-primary/40 bg-primary/10 ring-1 ring-primary/25" : "border-input hover:bg-secondary/50",
                        )}
                      >
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-semibold uppercase tracking-wide">{p.name}</span>
                        {sel > 0 ? (
                          <span className="rounded-full bg-primary px-1.5 text-[9px] font-bold text-white">{sel}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {/* Numbers in the active portfolio */}
                {activeGroup ? (
                  <div className="rounded-lg border border-input">
                    <div className="flex items-center justify-between border-b px-2.5 py-1.5">
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {nq ? `${filteredNumbers.length} of ${activeGroup.numbers.length}` : activeGroup.numbers.length} number(s)
                      </span>
                      <div className="flex items-center gap-2 text-[10px] font-semibold">
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => onToggleAll(filteredNumbers.map((n) => n.phone_number_id), true)}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground hover:underline"
                          onClick={() => onToggleAll(filteredNumbers.map((n) => n.phone_number_id), false)}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="border-b p-1.5">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={numQuery}
                          onChange={(e) => setNumQuery(e.target.value)}
                          placeholder="Search numbers"
                          className="h-8 pl-8 text-xs"
                        />
                      </div>
                    </div>
                    <div className="max-h-56 space-y-0.5 overflow-auto p-1">
                      {filteredNumbers.length === 0 ? (
                        <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No numbers match.</p>
                      ) : null}
                      {filteredNumbers.map((n) => {
                        const on = pids.has(n.phone_number_id);
                        return (
                          <button
                            key={n.phone_number_id}
                            type="button"
                            onClick={() => onTogglePid(n.phone_number_id)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition",
                              on ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-secondary/50",
                            )}
                          >
                            <span
                              className={cn(
                                "grid h-4 w-4 shrink-0 place-items-center rounded border",
                                on ? "border-primary bg-primary text-white" : "border-input",
                              )}
                            >
                              {on ? <Check className="h-3 w-3" /> : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{numLabel(n)}</span>
                              {n.display_phone_number ? (
                                <span className="block text-[10px] text-muted-foreground">{n.display_phone_number}</span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <p className="text-[10px] text-muted-foreground">
            Category is preserved. Media headers re-upload automatically. Each copy goes through Meta review again.
          </p>
          {results ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
              Copy {tplIds.size > 0 ? `${tplIds.size} ` : ""}template{tplIds.size === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-sm font-medium transition",
        active
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {count !== undefined ? (
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
              active ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
            )}
          >
            {count}
          </span>
        ) : null}
      </span>
      {active ? (
        <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
      ) : null}
    </button>
  );
}

function TemplateCard({
  t,
  scope,
  onDelete,
}: {
  t: TemplateSummary;
  /** `?portfolio_key=…&phone_number_id=…` — pins edit to the same WABA. */
  scope: string;
  onDelete: (id: string, name: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Meta only allows editing APPROVED / REJECTED / PAUSED — not PENDING.
  const editable = t.status === "APPROVED" || t.status === "REJECTED" || t.status === "PAUSED";

  async function handleConfirmDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete(t.id, t.name);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="group flex h-full flex-col rounded-xl border bg-card p-3 shadow-sm transition hover:shadow-md hover:border-brand-100">
      {/* Header — title + category + status */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="text-sm font-semibold leading-tight">{t.name.replace(/_/g, " ")}</span>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset",
              CATEGORY_BADGE[t.category] ?? CATEGORY_BADGE.SERVICE,
            )}
            title={`Category: ${t.category}`}
          >
            {CATEGORY_LABEL_SHORT[t.category] ?? t.category}
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              STATUS_BADGE[t.status] ?? "bg-secondary text-muted-foreground",
            )}
          >
            {t.status}
          </span>
        </div>
      </div>

      {/* Preview body */}
      <div className="rounded-md bg-primary/10 p-2.5 ring-1 ring-primary/20 flex-1 overflow-hidden">
        {/* Header media preview — image / video first frame / document icon */}
        {t.header_url && t.header_format === "IMAGE" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.header_url}
            alt=""
            className="mb-2 max-h-32 w-full rounded-md object-cover"
            loading="lazy"
          />
        ) : t.header_url && t.header_format === "VIDEO" ? (
          <video
            src={t.header_url}
            className="mb-2 max-h-32 w-full rounded-md"
            muted
            preload="metadata"
          />
        ) : t.header_format === "DOCUMENT" ? (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-white/70 px-2 py-1 text-[10px] font-medium text-muted-foreground ring-1 ring-primary/20">
            📄 Document header
          </div>
        ) : t.header_format === "IMAGE" || t.header_format === "VIDEO" ? (
          // Media header but no cached URL (template created before caching).
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-white/70 px-2 py-1 text-[10px] font-medium text-muted-foreground ring-1 ring-primary/20">
            {t.header_format === "IMAGE" ? "🖼️ Image header" : "🎥 Video header"}
          </div>
        ) : null}

        {t.header_text ? (
          <div className="mb-1 text-[11px] font-semibold text-foreground/85 line-clamp-2">
            {t.header_text}
          </div>
        ) : null}
        <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-snug text-foreground/85">
          {t.body || <span className="italic text-muted-foreground">[no body]</span>}
        </p>
        {t.footer ? (
          <p className="mt-1 line-clamp-1 text-[10px] italic text-muted-foreground">
            {t.footer}
          </p>
        ) : null}
      </div>

      {/* Footer — code + language + actions */}
      <div className="mt-2.5 flex items-center justify-between gap-2 pt-2 border-t">
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="truncate text-[10px] font-mono text-muted-foreground">{t.name}</code>
          <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t.language}
          </span>
        </div>

        {confirming ? (
          // Inline two-step confirmation — replaces the action row to demand
          // a deliberate click. Less jarring than browser confirm().
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-[10px] font-medium text-rose-700">Delete?</span>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-60"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Yes, delete"
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="inline-flex items-center rounded-md border border-input bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {editable ? (
              <Link
                href={`/templates/${encodeURIComponent(t.id)}/edit${scope}`}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                title="Edit template — re-submits to Meta for review"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Link>
            ) : (
              <span
                className="text-[10px] text-muted-foreground italic mr-1"
                title="Pending Meta review — edit available once APPROVED"
              >
                Editing locked
              </span>
            )}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background p-1 text-muted-foreground transition hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700"
              title="Delete template"
              aria-label="Delete template"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
