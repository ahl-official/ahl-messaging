"use client";

// Settings → Data → Data upload. Fixes contact numbers that were
// imported without a country code (bare local wa_id). Three modes:
//
//  • CSV    — upload a CSV with `Mobile Number` + `country_code` columns.
//  • India  — no CSV; prepends 91 to any bare 10-digit Indian mobile.
//  • Manual — one contact: current number → correct number.
//
// When a contact already exists under the corrected number, the two are
// MERGED (history moved over, the bare one deleted). Always previews
// first; nothing is written until "Apply".

import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Phone,
  Upload,
} from "lucide-react";

type Source = "csv" | "india" | "manual";

interface Preview {
  source: Source;
  toFix: number;
  toMerge: number;
  notFound: number;
  samples: Array<{ from: string; to: string }>;
  mergeSamples: Array<{ from: string; to: string }>;
}

interface ApplyResult {
  fixed: number;
  merged: number;
  failed: number;
  notFound: number;
}

export function NumberFixPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("csv");
  const [mFrom, setMFrom] = useState("");
  const [mTo, setMTo] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runPreview(payload: Record<string, unknown>) {
    setError(null);
    setPreview(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch("/api/data/fix-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode: "preview" }),
      });
      const j = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setPreview(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setSource("csv");
    await runPreview({ source: "csv", csv: text });
  }

  async function previewIndia() {
    setSource("india");
    await runPreview({ source: "india" });
  }

  async function previewManual() {
    setSource("manual");
    await runPreview({ source: "manual", from: mFrom, to: mTo });
  }

  async function apply() {
    if (source === "csv" && !csv) return;
    setBusy(true);
    setError(null);
    try {
      const payload =
        source === "csv"
          ? { source: "csv", csv }
          : source === "manual"
            ? { source: "manual", from: mFrom, to: mTo }
            : { source: "india" };
      const res = await fetch("/api/data/fix-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode: "apply" }),
      });
      const j = (await res.json()) as ApplyResult & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setResult(j);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCsv(null);
    setFileName(null);
    setSource("csv");
    setMFrom("");
    setMTo("");
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const total = preview ? preview.toFix + preview.toMerge : 0;

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
          <Phone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Fix imported numbers</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            Imported a chat whose numbers had no country code? Upload the
            contacts CSV (needs <span className="font-mono">Mobile Number</span>{" "}
            + <span className="font-mono">country_code</span> columns) — it
            rebuilds the correct number for each contact. Blank country
            code is treated as +91. Preview first, apply when ready.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-[12px] font-semibold hover:bg-secondary disabled:opacity-50"
            >
              {busy && source === "csv" && !preview ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {fileName ? "Choose another CSV" : "Choose CSV"}
            </button>
            {fileName ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {fileName}
              </span>
            ) : null}
          </div>

          {/* India leftovers — no CSV needed. */}
          <div className="mt-3 border-t pt-3">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Leftover Indian numbers the CSV didn&apos;t cover? This scans
              every contact for a bare 10-digit Indian mobile (no country
              code) and prepends <span className="font-mono">91</span>.
              Review the full list in the preview before applying.
            </p>
            <button
              type="button"
              onClick={() => void previewIndia()}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-[12px] font-semibold hover:bg-secondary disabled:opacity-50"
            >
              {busy && source === "india" && !preview ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Phone className="h-3.5 w-3.5" />
              )}
              Find leftover India numbers (+91)
            </button>
          </div>

          {/* Manual single-contact fix. */}
          <div className="mt-3 border-t pt-3">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              One-off wrong number? Enter the contact&apos;s current number
              and the correct one (with country code).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={mFrom}
                onChange={(e) => setMFrom(e.target.value)}
                placeholder="Current e.g. 92630383331"
                className="w-44 rounded-lg border bg-background px-2.5 py-1.5 font-mono text-[12px]"
              />
              <span className="text-muted-foreground">→</span>
              <input
                value={mTo}
                onChange={(e) => setMTo(e.target.value)}
                placeholder="Correct e.g. 919263038331"
                className="w-44 rounded-lg border bg-background px-2.5 py-1.5 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => void previewManual()}
                disabled={busy || !mFrom.trim() || !mTo.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-[12px] font-semibold hover:bg-secondary disabled:opacity-50"
              >
                {busy && source === "manual" && !preview ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Preview
              </button>
            </div>
          </div>

          {error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          ) : null}

          {/* Preview */}
          {preview ? (
            <div className="mt-3 space-y-2.5 rounded-lg border bg-secondary/30 p-3">
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
                <span>
                  <span className="font-bold text-primary">
                    {preview.toFix.toLocaleString()}
                  </span>{" "}
                  to rename
                </span>
                <span>
                  <span className="font-bold text-sky-700">
                    {preview.toMerge.toLocaleString()}
                  </span>{" "}
                  to merge
                </span>
                {preview.source !== "india" ? (
                  <span>
                    <span className="font-bold text-muted-foreground">
                      {preview.notFound.toLocaleString()}
                    </span>{" "}
                    not in inbox
                  </span>
                ) : null}
              </div>

              {preview.samples.length > 0 ? (
                <div className="space-y-0.5">
                  <div className="text-[11px] font-semibold text-primary">
                    Rename
                  </div>
                  <div className="max-h-44 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                    {preview.samples.map((s, i) => (
                      <div key={i}>
                        {s.from} →{" "}
                        <span className="text-foreground">{s.to}</span>
                      </div>
                    ))}
                    {preview.toFix > preview.samples.length ? (
                      <div>
                        …and {preview.toFix - preview.samples.length} more
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {preview.mergeSamples.length > 0 ? (
                <div className="space-y-0.5">
                  <div className="text-[11px] font-semibold text-sky-700">
                    Merge into existing contact
                  </div>
                  <div className="max-h-44 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                    {preview.mergeSamples.map((s, i) => (
                      <div key={i}>
                        {s.from} →{" "}
                        <span className="text-foreground">{s.to}</span>
                      </div>
                    ))}
                    {preview.toMerge > preview.mergeSamples.length ? (
                      <div>
                        …and {preview.toMerge - preview.mergeSamples.length}{" "}
                        more
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {total === 0 ? (
                <div className="text-[12px] text-muted-foreground">
                  Nothing to fix.
                </div>
              ) : (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={apply}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Apply {total.toLocaleString()} fixes
                  </button>
                  <button
                    type="button"
                    onClick={reset}
                    disabled={busy}
                    className="text-[12px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {preview.toMerge > 0 ? (
                <div className="flex items-start gap-1.5 text-[11px] text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Merge moves the bare contact&apos;s messages and notes
                    into the existing contact, then deletes the bare one.
                    This can&apos;t be undone.
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Result */}
          {result ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/10 p-3 text-[12px] text-primary">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <strong>{result.fixed.toLocaleString()}</strong> renamed,{" "}
                <strong>{result.merged.toLocaleString()}</strong> merged.
                {result.failed > 0 ? ` ${result.failed} failed.` : ""}
                {result.notFound > 0
                  ? ` ${result.notFound} not found in the inbox.`
                  : ""}{" "}
                <button
                  type="button"
                  onClick={reset}
                  className="font-semibold underline underline-offset-2"
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
