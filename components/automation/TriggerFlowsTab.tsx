"use client";

// Trigger flows for one business number — list + visual canvas builder.

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Loader2, MoreVertical, Plus, Trash2, Workflow, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { FlowCanvas } from "./FlowCanvas";

interface NumberOpt {
  phone_number_id: string;
  label: string;
  number: string;
  portfolio: string;
}

interface FlowSummary {
  id: string;
  name: string;
  enabled: boolean;
  trigger_config: { phrases?: string[]; match?: string };
  priority: number;
  step_count: number;
}

export function TriggerFlowsTab({ bpid }: { bpid: string }) {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  // Per-flow ⋮ menu (copy to another number).
  const [menuFlowId, setMenuFlowId] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<NumberOpt[]>([]);
  const [copyingTo, setCopyingTo] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: Array<{ phone_number_id: string; provider?: string; verified_name?: string; nickname?: string; display_phone_number?: string; portfolio?: { name?: string } | null }> }) => {
        setNumbers(
          (j.numbers ?? [])
            // Official Meta numbers only — exclude Evolution and Interakt.
            .filter((n) => n.provider !== "evolution" && n.provider !== "interakt")
            .map((n) => ({
              phone_number_id: n.phone_number_id,
              label: n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id,
              number: n.display_phone_number || n.phone_number_id,
              portfolio: n.portfolio?.name || "Other",
            })),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!menuFlowId) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) setMenuFlowId(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFlowId]);

  // Copy a flow's graph onto another business number — fresh node ids so the
  // new flow is fully independent of the original.
  async function copyToNumber(flow: FlowSummary, targetBpid: string) {
    setCopyingTo(targetBpid);
    setError(null);
    try {
      const res = await fetch(`/api/triggers/${flow.id}`, { cache: "no-store" });
      const j = (await res.json()) as {
        flow?: { trigger_type?: string; start_node_id?: string | null; trigger_config?: Record<string, unknown> };
        nodes?: Array<{ id: string; node_type: string; config: Record<string, unknown>; position: { x: number; y: number } | null }>;
        edges?: Array<{ from_node_id: string; to_node_id: string; branch_label: string | null }>;
      };
      if (!res.ok) throw new Error("Could not load the flow to copy");
      const idMap = new Map<string, string>();
      const nodes = (j.nodes ?? []).map((n) => {
        const newId = crypto.randomUUID();
        idMap.set(n.id, newId);
        return { id: newId, node_type: n.node_type, config: n.config, position: n.position };
      });
      const edges = (j.edges ?? [])
        .filter((e) => idMap.has(e.from_node_id) && idMap.has(e.to_node_id))
        .map((e) => ({
          from_node_id: idMap.get(e.from_node_id)!,
          to_node_id: idMap.get(e.to_node_id)!,
          branch_label: e.branch_label,
        }));
      const start = j.flow?.start_node_id ? idMap.get(j.flow.start_node_id) ?? null : null;
      const r = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_phone_number_id: targetBpid,
          name: `${flow.name} (copy)`,
          enabled: false,
          trigger_type: j.flow?.trigger_type ?? "keyword",
          trigger_config: j.flow?.trigger_config ?? {},
          graph: { start_node_id: start, nodes, edges },
        }),
      });
      const rj = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(rj.error ?? `HTTP ${r.status}`);
      setCopied(targetBpid);
      setTimeout(() => setCopied(null), 2500);
      setMenuFlowId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setCopyingTo(null);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/triggers?phone_number_id=${encodeURIComponent(bpid)}`, {
        cache: "no-store",
      });
      const j = (await res.json()) as { flows?: FlowSummary[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setFlows(j.flows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [bpid]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(flow: FlowSummary) {
    await fetch(`/api/triggers/${flow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !flow.enabled }),
    });
    await load();
  }

  async function remove(flow: FlowSummary) {
    if (!confirm(`Delete flow "${flow.name}"?`)) return;
    await fetch(`/api/triggers/${flow.id}`, { method: "DELETE" });
    await load();
  }

  if (editing) {
    return (
      <FlowCanvas
        bpid={bpid}
        flowId={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Workflow className="h-4 w-4 text-emerald-700" /> Trigger flows
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Keyword aaye to action steps chalein — AI ke bina.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New flow
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {copied ? (
        <div className="rounded-md border border-emerald-300/40 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          Flow copied to {numbers.find((n) => n.phone_number_id === copied)?.label ?? "the number"} (added as disabled — enable it there).
        </div>
      ) : null}

      {flows === null ? (
        <div className="grid h-24 place-items-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : flows.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          Abhi koi flow nahi. <strong>New flow</strong> se banao.
        </div>
      ) : (
        <ul className="space-y-2">
          {flows.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-xl border bg-background px-3 py-2.5"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200">
                <Zap className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{f.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {(f.trigger_config?.phrases ?? []).join(", ") || "no keywords"} ·{" "}
                  {f.step_count} step{f.step_count === 1 ? "" : "s"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggle(f)}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition",
                  f.enabled ? "bg-emerald-500" : "bg-slate-300",
                )}
                title={f.enabled ? "Enabled" : "Disabled"}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition",
                    f.enabled ? "left-[18px]" : "left-0.5",
                  )}
                />
              </button>
              <button
                type="button"
                onClick={() => setEditing(f.id)}
                className="rounded-md border bg-card px-2.5 py-1 text-xs font-semibold hover:bg-secondary"
              >
                Edit
              </button>
              <div className="relative" ref={menuFlowId === f.id ? menuRef : null}>
                <button
                  type="button"
                  onClick={() => setMenuFlowId((cur) => (cur === f.id ? null : f.id))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
                  aria-label="More"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
                {menuFlowId === f.id ? (
                  <div className="absolute right-0 top-8 z-50 w-60 overflow-hidden rounded-lg border bg-white py-1 shadow-xl">
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Copy this flow to another number
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {(() => {
                        const others = numbers.filter((n) => n.phone_number_id !== bpid);
                        if (others.length === 0) {
                          return <div className="px-3 py-2 text-xs text-muted-foreground">No other numbers.</div>;
                        }
                        // Group by portfolio (UROOTS BY QHT, SAHIL AYYAN, …).
                        const groups = new Map<string, NumberOpt[]>();
                        for (const n of others) {
                          (groups.get(n.portfolio) ?? groups.set(n.portfolio, []).get(n.portfolio)!).push(n);
                        }
                        return [...groups.entries()].map(([portfolio, opts]) => (
                          <div key={portfolio}>
                            <div className="bg-secondary/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {portfolio}
                            </div>
                            {opts.map((n) => (
                              <button
                                key={n.phone_number_id}
                                type="button"
                                disabled={copyingTo !== null}
                                onClick={() => copyToNumber(f, n.phone_number_id)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                              >
                                {copyingTo === n.phone_number_id ? (
                                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                                ) : (
                                  <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" />
                                )}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{n.label}</span>
                                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{n.number}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => remove(f)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50"
                aria-label="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
