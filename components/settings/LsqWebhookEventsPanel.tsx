"use client";

// Recent LSQ webhook events with their FULL payloads — so a form submission's
// exact payload can be inspected. Ring-buffered server-side (last 50/webhook).

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCcw, FileJson } from "lucide-react";

interface EventRow {
  id: string;
  webhook_name: string | null;
  received_at: string;
  notable_event: string | null;
  activity: string | null;
  prospect_id: string | null;
  prospect_auto_id: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  payload: unknown;
}

function istTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

export function LsqWebhookEventsPanel() {
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [formOnly, setFormOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lsq/webhook-events?limit=100${formOnly ? "&form=1" : ""}`, { cache: "no-store" });
      const j = (await res.json()) as { rows?: EventRow[] };
      setRows(j.rows ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [formOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <FileJson className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Webhook event payloads</h2>
            <p className="text-[11px] text-muted-foreground">
              Har webhook event ka <b>full payload</b> (last 50 per webhook). Form submission ka exact data dekhne ke liye row kholo.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <input type="checkbox" checked={formOnly} onChange={(e) => setFormOnly(e.target.checked)} className="h-3.5 w-3.5 rounded border-input accent-emerald-600" />
            Form submissions only
          </label>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
      </header>

      <div className="px-5 py-4">
        {rows === null ? (
          <div className="grid h-16 place-items-center text-xs text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="grid h-16 place-items-center text-xs text-muted-foreground">
            Koi event log nahi — webhook pe ek event bhejo, yahan full payload aa jayega.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border">
                <button
                  type="button"
                  onClick={() => setOpenId((p) => (p === r.id ? null : r.id))}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[11px] hover:bg-secondary/40"
                >
                  <span className="font-semibold">{r.webhook_name ?? "—"}</span>
                  {r.notable_event ? <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium">{r.notable_event}</span> : null}
                  {r.stage ? <span className="text-muted-foreground">stage: {r.stage}</span> : null}
                  {r.prospect_auto_id ? <span className="font-mono text-muted-foreground">#{r.prospect_auto_id}</span> : null}
                  {r.phone ? <span className="text-muted-foreground">{r.phone}</span> : null}
                  <span className="ml-auto text-[10px] text-muted-foreground">{istTime(r.received_at)}</span>
                  <span className="text-primary">{openId === r.id ? "Hide" : "View"}</span>
                </button>
                {openId === r.id ? (
                  <pre className="max-h-96 overflow-auto border-t bg-card px-3 py-2 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(r.payload, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
