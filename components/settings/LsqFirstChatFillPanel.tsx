"use client";

// Backfill Source / Sub-source / Brand onto CRM leads whose attribution came in
// blank — using the lead_defaults of the business number the client FIRST
// chatted on. Paste lead numbers → Check (dry run) → Fill blank.

import { useState } from "react";
import { Loader2, Search, Upload, Wand2 } from "lucide-react";

interface Row {
  lead_number: string;
  status:
    | "filled"
    | "would_fill"
    | "skipped_has_source"
    | "no_chat_found"
    | "no_defaults"
    | "lead_not_found"
    | "error";
  phone?: string | null;
  first_chat_number?: string | null;
  current_source?: string | null;
  fields?: Array<{ Attribute: string; Value: string }>;
}

const STATUS_STYLE: Record<Row["status"], string> = {
  filled: "bg-primary/15 text-primary",
  would_fill: "bg-sky-100 text-sky-800",
  skipped_has_source: "bg-slate-100 text-slate-600",
  no_chat_found: "bg-amber-100 text-amber-800",
  no_defaults: "bg-amber-100 text-amber-800",
  lead_not_found: "bg-rose-100 text-rose-700",
  error: "bg-rose-100 text-rose-700",
};

const STATUS_LABEL: Record<Row["status"], string> = {
  filled: "Filled",
  would_fill: "Will fill",
  skipped_has_source: "Has source",
  no_chat_found: "No WA chat",
  no_defaults: "No defaults",
  lead_not_found: "Not in LSQ",
  error: "Error",
};

export function LsqFirstChatFillPanel({ configured }: { configured: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"check" | "fill" | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  const leadNumbers = Array.from(
    new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)),
  );

  async function run(check: boolean) {
    if (leadNumbers.length === 0) return;
    setBusy(check ? "check" : "fill");
    setError(null);
    try {
      const res = await fetch("/api/lsq/bulk-fill-from-firstchat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_numbers: leadNumbers, check, force }),
      });
      const j = (await res.json()) as { rows?: Row[]; summary?: Record<string, number>; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRows(j.rows ?? []);
      setSummary(j.summary ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const willFill = (rows ?? []).filter((r) => r.status === "would_fill").length;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Fill source from first-chat number</h2>
            <p className="text-[11px] text-muted-foreground">
              Lead numbers paste karo. Har lead ka phone → jis business number pe pehli WhatsApp chat hui →
              uske fields push honge: <b>Lead defaults + Update-existing fields + Facebook Ads fields</b>
              (Source ID / Campaign — contact ke ad-attribution se). Default me sirf blank-source leads pe likhता hai.
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-3 px-5 py-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={"475563\n475573\n476117\n…"}
          className="w-full rounded-md border px-3 py-2 font-mono text-xs outline-none focus:border-primary"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{leadNumbers.length} lead number(s)</span>
          <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground" title="Already-sourced leads pe bhi push kare (FB ad / update fields add karne ke liye). Source overwrite ho sakta hai.">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="h-3.5 w-3.5 rounded border-input accent-primary" />
            Force (overwrite source too)
          </label>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!configured || busy !== null || leadNumbers.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            {busy === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Check (dry run)
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={!configured || busy !== null || leadNumbers.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-40"
            title={force ? "Push fields to ALL listed leads (overwrites source)" : "Push fields to blank-source leads only"}
          >
            {busy === "fill" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {force ? "Force push" : "Fill blank"}{willFill > 0 ? ` (${willFill})` : ""}
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">{error}</div>
        ) : null}

        {summary ? (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(summary).map(([k, v]) => (
              <span key={k} className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " + (STATUS_STYLE[k as Row["status"]] ?? "bg-secondary text-muted-foreground")}>
                {STATUS_LABEL[k as Row["status"]] ?? k}: {v}
              </span>
            ))}
          </div>
        ) : null}

        {rows && rows.length > 0 ? (
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 font-semibold">Lead #</th>
                  <th className="px-2.5 py-1.5 font-semibold">First-chat number</th>
                  <th className="px-2.5 py-1.5 font-semibold">Will push</th>
                  <th className="px-2.5 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_number} className="border-t">
                    <td className="px-2.5 py-1.5 font-mono">{r.lead_number}</td>
                    <td className="px-2.5 py-1.5">{r.first_chat_number ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-2.5 py-1.5">
                      {r.fields && r.fields.length > 0 ? (
                        <span className="text-muted-foreground">{r.fields.map((f) => `${f.Attribute}=${f.Value}`).join(", ")}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " + STATUS_STYLE[r.status]}>
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
