"use client";

// LeadSquared webhook manager — multiple named endpoints.
//
// LSQ fires one webhook per event type, so the operator creates one
// named endpoint per event (e.g. "Lead Stage Change"). Each gets its
// own URL + its own "Connected" status and event counter. Shared by
// the LeadSquared integration page and Settings → Data.

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  created_at: string;
  last_received_at: string | null;
  event_count: number;
  connected: boolean;
  last_payload: string | null;
  last_payload_at: string | null;
}

function prettyPayload(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// The events worth wiring for this dashboard — one-click add.
const SUGGESTED = ["Lead Stage Change", "Lead Ownership Change", "Lead Update"];

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function LsqWebhookGenerator() {
  const [rows, setRows] = useState<WebhookRow[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPayloadId, setOpenPayloadId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/lsq/webhook-config", { cache: "no-store" });
      const j = (await res.json()) as { webhooks?: WebhookRow[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRows(j.webhooks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
    // Poll so the "Connected" badges update as LSQ events land.
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function add(name: string) {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lsq/webhook-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNewName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete the "${name}" webhook? Its URL stops working — remove it from LSQ too.`)) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/lsq/webhook-config?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  function copyUrl(id: string, url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1800);
    });
  }

  const existingNames = new Set((rows ?? []).map((r) => r.name.toLowerCase()));
  const suggestionsLeft = SUGGESTED.filter(
    (s) => !existingNames.has(s.toLowerCase()),
  );

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
          <Webhook className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Live event webhooks</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            LSQ sends one webhook per event. Add one endpoint per event,
            paste its URL into LeadSquared → Settings → Webhooks. Stage /
            owner / name updates then flow into the inbox instantly.
          </p>
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {/* Existing webhooks */}
        {rows === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No webhooks yet. Add one below.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((w) => (
              <div
                key={w.id}
                className="rounded-lg border bg-secondary/30 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{w.name}</span>
                  {w.connected ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Connected · {timeAgo(w.last_received_at)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                      Waiting for first event
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {w.event_count} event{w.event_count === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(w.id, w.name)}
                    className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete ${w.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border bg-card px-2.5 py-1.5 font-mono text-[11px]">
                    {w.url}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyUrl(w.id, w.url)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-card px-2.5 py-1.5 text-[11px] font-semibold hover:bg-secondary"
                  >
                    {copiedId === w.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedId === w.id ? "Copied" : "Copy"}
                  </button>
                </div>

                {/* Last payload received on THIS webhook (per-webhook copy). */}
                {w.last_payload ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setOpenPayloadId((p) => (p === w.id ? null : w.id))}
                      className="text-[11px] font-semibold text-primary hover:underline"
                    >
                      {openPayloadId === w.id ? "Hide" : "View"} last payload
                      {w.last_payload_at ? ` · ${timeAgo(w.last_payload_at)}` : ""}
                    </button>
                    {openPayloadId === w.id ? (
                      <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border bg-card px-2.5 py-2 font-mono text-[10px] leading-relaxed">
                        {prettyPayload(w.last_payload)}
                      </pre>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    Abhi tak koi payload capture nahi hua — ek event bhejo, yahan dikhega.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add a webhook */}
        <div className="border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add(newName);
              }}
              placeholder="Webhook name (e.g. Lead Stage Change)"
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
            <button
              type="button"
              onClick={() => add(newName)}
              disabled={busy || !newName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-[12px] font-semibold text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Add webhook
            </button>
          </div>
          {suggestionsLeft.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">
                Quick add:
              </span>
              {suggestionsLeft.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => add(s)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {s}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
