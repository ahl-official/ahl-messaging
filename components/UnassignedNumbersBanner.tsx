"use client";

// Owner-only banner that polls /api/portfolios/orphans and shows a
// pop-up when an inbound message arrives from a phone_number_id that
// isn't yet listed in any PORTFOLIO_*_PHONE_IDS env var. Click "Assign"
// to drop down the modal that lets the owner pick which portfolio
// owns each new number — the assignment is appended to .env.local and
// also live-updated in process.env (no restart needed for dev).

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Building2, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface OrphanNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  is_active: boolean;
  created_at: string;
}

interface PortfolioOption {
  key: string;
  name: string;
  is_active: boolean;
}

export function UnassignedNumbersBanner({ role }: { role: string | null }) {
  const [orphans, setOrphans] = useState<OrphanNumber[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/portfolios/orphans", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { orphans?: OrphanNumber[] };
      setOrphans(json.orphans ?? []);
    } catch {
      /* ignore — non-critical */
    }
  }, []);

  useEffect(() => {
    if (role !== "owner") return;
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [role, refresh]);

  if (role !== "owner" || orphans.length === 0) return null;

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="truncate">
            <strong>{orphans.length}</strong>{" "}
            {orphans.length === 1 ? "number" : "numbers"} not yet assigned to a portfolio.
            Messages from {orphans.length === 1 ? "this number" : "these numbers"} will fail until you assign{" "}
            {orphans.length === 1 ? "it" : "them"}.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-amber-700"
        >
          <Building2 className="h-3 w-3" />
          Assign now
        </button>
      </div>

      {open ? (
        <AssignModal
          orphans={orphans}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

function AssignModal({
  orphans,
  onClose,
  onChanged,
}: {
  orphans: OrphanNumber[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [portfolios, setPortfolios] = useState<PortfolioOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/portfolios", { cache: "no-store" });
        const json = (await res.json()) as {
          portfolios?: PortfolioOption[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setLoadErr(json.error ?? `HTTP ${res.status}`);
          return;
        }
        setPortfolios((json.portfolios ?? []).filter((p) => p.is_active));
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold">Assign numbers to portfolios</h3>
            <p className="text-[11px] text-muted-foreground">
              Each number belongs to one Meta Business App. We&apos;ll save the assignment to <span className="font-mono">.env.local</span> and live-reload it.
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

        <div className="max-h-[60vh] overflow-auto px-5 py-3">
          {loadErr ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {loadErr}
            </div>
          ) : portfolios === null ? (
            <div className="grid h-20 place-items-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : portfolios.length === 0 ? (
            <div className="rounded-md border bg-secondary/30 px-3 py-3 text-xs text-muted-foreground">
              No active portfolios. Add a <span className="font-mono">PORTFOLIO_*</span> block to{" "}
              <span className="font-mono">.env.local</span> first.
            </div>
          ) : (
            <ul className="space-y-2">
              {orphans.map((o) => (
                <OrphanRow
                  key={o.phone_number_id}
                  orphan={o}
                  portfolios={portfolios}
                  onAssigned={onChanged}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function OrphanRow({
  orphan,
  portfolios,
  onAssigned,
}: {
  orphan: OrphanNumber;
  portfolios: PortfolioOption[];
  onAssigned: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleAssign() {
    if (!selectedKey) return;
    setSaving(true);
    setErr(null);
    setWarning(null);
    try {
      const res = await fetch("/api/portfolios/assign-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number_id: orphan.phone_number_id,
          portfolio_key: selectedKey,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        persisted?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.persisted === false) {
        setWarning(json.message ?? "Persisted in memory only — update env vars manually.");
      }
      setDone(true);
      onAssigned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5",
        done && "border-primary/25 bg-primary/10",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs">{orphan.phone_number_id}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {orphan.verified_name ?? "Unknown business"} · {orphan.display_phone_number ?? "—"}
        </div>
      </div>

      {done ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
          <Check className="h-3.5 w-3.5" />
          Assigned
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            disabled={saving}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">Select portfolio…</option>
            {portfolios.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAssign}
            disabled={!selectedKey || saving}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Assign
          </button>
        </div>
      )}

      {err ? (
        <div className="basis-full rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      ) : null}
      {warning ? (
        <div className="basis-full rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          {warning}
        </div>
      ) : null}
    </li>
  );
}
