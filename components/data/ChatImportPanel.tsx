"use client";

// Settings → Data → Import past chats.
//
// Three modes (tabs):
//   • JSON  — paste a JSON array OR upload a .json file (full schema below).
//   • CSV   — upload a contacts.csv + a messages.csv (or a single combined.csv).
//   • Script — copy a node script the operator runs locally to mirror an
//              old Supabase straight into this workspace's API.
//
// Volume model: chunks the parsed payload client-side and POSTs in
// batches of BATCH_SIZE. The /api/import/chats/batch endpoint is
// idempotent (wa_message_id unique constraint), so on network blip the
// operator can just re-run the same upload and it resumes without dupes.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  FileJson,
  FileSpreadsheet,
  MessagesSquare,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BATCH_SIZE = 500;

interface NumberRow {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname?: string | null;
  provider?: "meta" | "evolution" | null;
}

interface ImportJob {
  id: string;
  target_bpid: string;
  label: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  source_format: string | null;
  total_messages: number;
  total_contacts: number;
  processed_messages: number;
  processed_contacts: number;
  inserted_messages: number;
  inserted_contacts: number;
  errors: Array<{ at: string; msg: string }> | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ImportContact {
  wa_id: string;
  name?: string | null;
  profile_name?: string | null;
}

interface ImportMessage {
  wa_id: string;
  wa_message_id?: string | null;
  direction: "inbound" | "outbound";
  type?: string;
  content?: string | null;
  media_url?: string | null;
  media_mime_type?: string | null;
  status?: string | null;
  timestamp: string;
}

type Mode = "sessions" | "json" | "csv" | "script" | "table";

export function ChatImportPanel() {
  const [numbers, setNumbers] = useState<NumberRow[] | null>(null);
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [targetBpid, setTargetBpid] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [mode, setMode] = useState<Mode>("sessions");

  // Live upload state
  const [running, setRunning] = useState(false);
  const [currentJob, setCurrentJob] = useState<ImportJob | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadNumbers();
    void loadJobs();
  }, []);

  async function loadNumbers() {
    try {
      const res = await fetch("/api/business-numbers", { cache: "no-store" });
      const json = (await res.json()) as { numbers?: NumberRow[] };
      // Import path only supports Meta (Cloud API) numbers — Evolution
      // ingestion goes through the live webhook / sync-history paths,
      // not this CSV/JSON importer. Filter the dropdown so the operator
      // can't accidentally pick an Evolution number and have nothing
      // happen.
      const metaOnly = (json.numbers ?? []).filter(
        (n) => (n.provider ?? "meta") === "meta",
      );
      setNumbers(metaOnly);
      if (!targetBpid && metaOnly.length) {
        setTargetBpid(metaOnly[0].phone_number_id);
      }
    } catch {
      setNumbers([]);
    }
  }
  async function loadJobs() {
    try {
      const res = await fetch("/api/import/chats", { cache: "no-store" });
      const json = (await res.json()) as { jobs?: ImportJob[] };
      setJobs(json.jobs ?? []);
    } catch {
      setJobs([]);
    }
  }

  function log(line: string) {
    setLogLines((prev) => [...prev.slice(-200), line]);
  }

  async function runImport(payload: {
    contacts: ImportContact[];
    messages: ImportMessage[];
  }) {
    if (!targetBpid) {
      setError("Pick a target number first.");
      return;
    }
    if (payload.contacts.length === 0 && payload.messages.length === 0) {
      setError("Nothing to import — parsed payload was empty.");
      return;
    }
    setError(null);
    setLogLines([]);
    setRunning(true);

    try {
      log(
        `Starting job: ${payload.contacts.length} contact(s), ${payload.messages.length} message(s)`,
      );
      const startRes = await fetch("/api/import/chats/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_bpid: targetBpid,
          label: label.trim() || null,
          source_format: mode,
          total_contacts: payload.contacts.length,
          total_messages: payload.messages.length,
        }),
      });
      const startJson = (await startRes.json()) as { job?: ImportJob; error?: string };
      if (!startRes.ok || !startJson.job) {
        throw new Error(startJson.error ?? `start failed (${startRes.status})`);
      }
      const job = startJson.job;
      setCurrentJob(job);
      log(`Job ${job.id.slice(0, 8)} created.`);

      // Chunk + ship. Contacts first (so message batches can resolve their
      // contact_id), then messages.
      const contactChunks = chunk(payload.contacts, BATCH_SIZE);
      for (let i = 0; i < contactChunks.length; i++) {
        const batch = contactChunks[i];
        log(`Contacts batch ${i + 1}/${contactChunks.length} (${batch.length} rows)…`);
        await postBatch(job.id, { contacts: batch });
      }
      const messageChunks = chunk(payload.messages, BATCH_SIZE);
      for (let i = 0; i < messageChunks.length; i++) {
        const batch = messageChunks[i];
        log(`Messages batch ${i + 1}/${messageChunks.length} (${batch.length} rows)…`);
        const result = await postBatch(job.id, { messages: batch });
        if (result?.job) setCurrentJob(result.job);
      }
      log("Finalising — rebuilding contact previews…");
      const finishRes = await fetch("/api/import/chats/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
      const finishJson = (await finishRes.json()) as {
        job?: ImportJob;
        error?: string;
        previews_updated?: number;
      };
      if (!finishRes.ok || !finishJson.job) {
        throw new Error(finishJson.error ?? "finish failed");
      }
      setCurrentJob(finishJson.job);
      log(
        `Done. Inserted ${finishJson.job.inserted_contacts} contact(s) + ${finishJson.job.inserted_messages} message(s). ${finishJson.previews_updated ?? 0} previews updated.`,
      );
      void loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  async function postBatch(
    jobId: string,
    payload: { contacts?: ImportContact[]; messages?: ImportMessage[] },
  ): Promise<{ job?: ImportJob } | null> {
    const res = await fetch("/api/import/chats/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, ...payload }),
    });
    const json = (await res.json()) as { job?: ImportJob; error?: string };
    if (!res.ok) throw new Error(json.error ?? `batch failed (${res.status})`);
    return json;
  }

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm shadow-violet-500/20">
            <Database className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Import past chats</h2>
            <p className="text-[11px] text-muted-foreground">
              Bring contacts + messages from an old Supabase / Interakt
              database under a specific WhatsApp number on this workspace.
              Idempotent — re-running the same batch never duplicates.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadJobs()}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh history
        </button>
      </header>

      {/* Target + label */}
      <div className="grid gap-3 border-b bg-secondary/20 px-5 py-4 sm:grid-cols-2">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Target WhatsApp number
          </label>
          <NumberPicker
            numbers={numbers ?? []}
            value={targetBpid}
            onChange={setTargetBpid}
            disabled={running}
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Label (optional)
          </label>
          <input
            type="text"
            maxLength={120}
            placeholder="e.g. Interakt URoots Sep 2025"
            value={label}
            disabled={running}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
          />
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 border-b bg-secondary/10 px-5 pt-3">
        {(
          [
            { k: "sessions" as Mode, label: "Sessions", icon: MessagesSquare },
            { k: "json" as Mode, label: "JSON", icon: FileJson },
            { k: "csv" as Mode, label: "CSV", icon: FileSpreadsheet },
            { k: "table" as Mode, label: "Supabase table", icon: Database },
            { k: "script" as Mode, label: "Node script", icon: Terminal },
          ]
        ).map((t) => {
          const Icon = t.icon;
          const active = mode === t.k;
          return (
            <button
              key={t.k}
              type="button"
              onClick={() => setMode(t.k)}
              disabled={running}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-60",
                active
                  ? "border-x border-t bg-card text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="border-b px-5 py-5">
        {mode === "sessions" ? (
          <SessionsMode disabled={running} onSubmit={runImport} />
        ) : null}
        {mode === "json" ? (
          <JsonMode disabled={running} onSubmit={runImport} />
        ) : null}
        {mode === "csv" ? (
          <CsvMode disabled={running} onSubmit={runImport} />
        ) : null}
        {mode === "table" ? (
          <TableMode targetBpid={targetBpid} label={label} disabled={running} />
        ) : null}
        {mode === "script" ? (
          <ScriptMode targetBpid={targetBpid} label={label} />
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-rose-200 bg-rose-50/60 px-5 py-2 text-xs text-rose-800">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      {currentJob ? <ProgressBlock job={currentJob} log={logLines} /> : null}

      <JobsHistory jobs={jobs} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Searchable Target-number picker
//
// Replaces the plain native <select> — operator types a fragment of
// the nickname / verified name / phone number to jump to the right
// account. Important for workspaces with many connected Meta numbers.
// ---------------------------------------------------------------------------
function NumberPicker({
  numbers,
  value,
  onChange,
  disabled,
}: {
  numbers: NumberRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = numbers.find((n) => n.phone_number_id === value) ?? null;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (e.target instanceof Node && wrapRef.current.contains(e.target)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return numbers;
    const qDigits = q.replace(/\D/g, "");
    return numbers.filter((n) => {
      const label = (
        n.nickname ??
        n.verified_name ??
        n.display_phone_number ??
        n.phone_number_id
      ).toLowerCase();
      if (label.includes(q)) return true;
      if (n.verified_name?.toLowerCase().includes(q)) return true;
      if (n.nickname?.toLowerCase().includes(q)) return true;
      if (qDigits.length >= 3) {
        const dpnDigits = (n.display_phone_number ?? "").replace(/\D/g, "");
        if (dpnDigits.includes(qDigits)) return true;
        if (n.phone_number_id.includes(qDigits)) return true;
      }
      return false;
    });
  }, [numbers, query]);

  function labelFor(n: NumberRow): string {
    return (
      n.nickname?.trim() ||
      n.verified_name?.trim() ||
      n.display_phone_number ||
      n.phone_number_id
    );
  }

  return (
    <div ref={wrapRef} className="relative mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || numbers.length === 0}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm shadow-sm transition focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60",
          open && "border-primary ring-1 ring-primary",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <span className="truncate font-medium">{labelFor(selected)}</span>
              {selected.display_phone_number ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  · {selected.display_phone_number}
                </span>
              ) : null}
            </>
          ) : numbers.length === 0 ? (
            <span className="text-muted-foreground">
              No Meta numbers connected
            </span>
          ) : (
            <span className="text-muted-foreground">Pick a number…</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border bg-popover shadow-lg ring-1 ring-border">
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search nickname or number…"
              className="h-9 w-full bg-transparent pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-center text-xs text-muted-foreground">
                No matches.
              </li>
            ) : (
              filtered.map((n) => {
                const isSelected = n.phone_number_id === value;
                return (
                  <li key={n.phone_number_id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(n.phone_number_id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary/70",
                        isSelected && "bg-primary/10",
                      )}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-semibold">
                          {labelFor(n)}
                        </span>
                        {n.display_phone_number ? (
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {n.display_phone_number}
                          </span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <Check className="h-3 w-3 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: Sessions (LangChain-style chat history)
//
// Input rows look like:
//   { id, session_id, message: { type: "human"|"ai", content, ... } }
// where session_id is the customer's phone number and id is a global
// monotonic sequence that determines message order.
//
// We:
//   1. Group rows by session_id → one contact per session
//   2. Sort messages by id ascending so the chat reads in order
//   3. Synthesise timestamps spread 1 minute apart per row (no real
//      timestamp exists in the source); base = today minus
//      (max_id - id) minutes so the newest message lands "now-ish".
//   4. type=="human" → inbound, type=="ai" → outbound
//
// Preview rendered as actual chat bubbles before the operator commits.
// ---------------------------------------------------------------------------
interface SessionRow {
  id: number;
  session_id: string;
  message: {
    type: "human" | "ai" | string;
    content?: string;
  } | Record<string, unknown>;
}

interface ParsedSessions {
  contacts: ImportContact[];
  messages: ImportMessage[];
  /** session_id → ordered preview rows (used by the chat-bubble preview). */
  previewBySession: Map<
    string,
    Array<{ direction: "inbound" | "outbound"; content: string; timestamp: string }>
  >;
}

/** Detect a WhatsApp .txt chat export by looking for the signature
 *  bracketed timestamp + sender prefix on the first non-empty line.
 *  Matches both 12-hour ("[12/05/24, 11:01:23 PM]") and 24-hour
 *  ("[12/05/2024, 23:01:23]") variants, with hyphen / colon / dash
 *  separators that different OS exports use. */
function looksLikeWhatsAppTxt(raw: string): boolean {
  const firstLine = raw
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0) ?? "";
  return (
    /^\[?\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}[,\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?\]?\s*[-:–]/.test(
      firstLine,
    )
  );
}

/** Parse a WhatsApp-exported chat (the format Android / iOS export
 *  produces, and what /api/contacts/[id]/export emits). Single chat =
 *  single contact, so the caller provides the wa_id to attach. */
function parseWhatsAppTxt(
  raw: string,
  defaultWaId: string,
  operatorIdentifier: string,
): ParsedSessions {
  const waId = defaultWaId.replace(/\D/g, "");
  if (!waId) {
    throw new Error(
      "Customer phone (wa_id) is required for .txt chat imports. Enter it below the file picker.",
    );
  }
  // Regex captures: date, time, sender, body. Continuation lines (lines
  // without a leading timestamp) belong to the previous message.
  const lineRe =
    /^\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})[,\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]?\s*[-:–]\s*([^:]+?):\s?(.*)$/;
  const lines = raw.split(/\r?\n/);

  interface Parsed {
    iso: string;
    sender: string;
    body: string;
  }
  const parsed: Parsed[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/‎/g, "").trim();
    if (!trimmed) continue;
    const m = trimmed.match(lineRe);
    if (m) {
      const [, dateStr, timeStr, sender, body] = m;
      const iso = whatsappDateToIso(dateStr, timeStr);
      parsed.push({ iso, sender: sender.trim(), body: body ?? "" });
    } else if (parsed.length > 0) {
      // Continuation of the previous message.
      parsed[parsed.length - 1].body += `\n${trimmed}`;
    }
    // Else: header/footer junk (e.g. "Messages are end-to-end encrypted")
    // — drop silently.
  }
  if (parsed.length === 0) {
    throw new Error(
      "Couldn't find any WhatsApp-style messages in the file. Make sure it's a chat export with bracketed timestamps.",
    );
  }

  // First detected sender = whoever sent message #1. We need to map
  // {operator, customer} → {outbound, inbound}. The operator passes a
  // hint (their own name / email); if no hint or no match, fall back to
  // assuming the LESS-common sender is the operator (typical: customer
  // sends most messages in a support thread).
  const senderCounts = new Map<string, number>();
  for (const p of parsed) {
    senderCounts.set(p.sender, (senderCounts.get(p.sender) ?? 0) + 1);
  }
  const operatorHint = operatorIdentifier.trim().toLowerCase();
  let operatorSender: string | null = null;
  if (operatorHint) {
    for (const s of senderCounts.keys()) {
      if (s.toLowerCase().includes(operatorHint)) {
        operatorSender = s;
        break;
      }
    }
  }
  if (!operatorSender) {
    const sorted = [...senderCounts.entries()].sort((a, b) => a[1] - b[1]);
    operatorSender = sorted[0]?.[0] ?? null;
  }

  const messages: ImportMessage[] = parsed.map((p) => ({
    wa_id: waId,
    direction: p.sender === operatorSender ? "outbound" : "inbound",
    type: "text",
    content: p.body,
    timestamp: p.iso,
    status: "delivered",
  }));
  const previewBySession = new Map<
    string,
    Array<{ direction: "inbound" | "outbound"; content: string; timestamp: string }>
  >();
  previewBySession.set(
    waId,
    messages.map((m) => ({
      direction: m.direction,
      content: m.content ?? "",
      timestamp: m.timestamp,
    })),
  );
  return {
    contacts: [{ wa_id: waId }],
    messages,
    previewBySession,
  };
}

/** Translate the date+time strings WhatsApp's exporter spits out into
 *  an ISO timestamp. Handles both 12/24-hour and DD/MM/YY (the only
 *  format WhatsApp uses) — but accepts YYYY too, since our own export
 *  writes 4-digit years. */
function whatsappDateToIso(dateStr: string, timeStr: string): string {
  const parts = dateStr.split(/[\/.-]/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return new Date().toISOString();
  }
  let [day, month, year] = parts;
  if (year < 100) year += 2000;
  const tm = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([APap][Mm])?$/);
  if (!tm) return new Date(year, month - 1, day).toISOString();
  let hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const second = tm[3] ? parseInt(tm[3], 10) : 0;
  const ampm = tm[4]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

/** Strips agent tool-call traces some exports embed in the AI message —
 *  e.g. `[Used tools: Tool: …, Result: [{…}]] Actual reply`. Brackets are
 *  matched by depth so nested `Result` arrays don't end the block early.
 *  Returns just the human-readable message. */
function cleanMessageContent(raw: string): string {
  let text = String(raw ?? "");
  for (let guard = 0; guard < 6; guard += 1) {
    const start = text.indexOf("[Used tools:");
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      // Unbalanced — drop everything from the marker onward.
      text = text.slice(0, start);
      break;
    }
    text = text.slice(0, start) + text.slice(end + 1);
  }
  return text.trim();
}

function parseSessions(raw: string): ParsedSessions {
  // Detect CSV vs JSON. CSV is what you get from Numbers / Excel
  // exports of the supabase rows table (id,session_id,message). JSON
  // is what `SELECT json_agg(row_to_json(t))` returns.
  const trimmed = raw.trim();
  let arr: SessionRow[];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const obj = JSON.parse(trimmed);
    if (Array.isArray(obj)) {
      arr = obj as SessionRow[];
    } else if (
      typeof obj === "object" &&
      obj !== null &&
      Array.isArray((obj as { rows?: unknown }).rows)
    ) {
      arr = (obj as { rows: SessionRow[] }).rows;
    } else {
      throw new Error(
        "Top-level JSON must be an array of {id, session_id, message} rows.",
      );
    }
  } else {
    // CSV path. Each row's `message` cell is itself a JSON string —
    // parse it so the downstream type/content extraction works the
    // same way as the JSON path.
    const csvRows = parseCsv(trimmed);
    if (csvRows.length === 0) throw new Error("CSV had no data rows.");
    if (
      !("session_id" in csvRows[0]) ||
      !("message" in csvRows[0]) ||
      !("id" in csvRows[0])
    ) {
      throw new Error(
        "CSV header must include id, session_id, message (got: " +
          Object.keys(csvRows[0]).join(", ") +
          ").",
      );
    }
    arr = csvRows.map((r) => {
      let parsedMsg: SessionRow["message"];
      try {
        parsedMsg = JSON.parse(r.message);
      } catch {
        // Some exports double-quote the JSON cell. Try unwrapping once.
        try {
          parsedMsg = JSON.parse(r.message.replace(/^"(.*)"$/, "$1").replace(/""/g, '"'));
        } catch {
          parsedMsg = { type: "human", content: r.message } as SessionRow["message"];
        }
      }
      return {
        id: Number(r.id),
        session_id: String(r.session_id),
        message: parsedMsg,
      } as SessionRow;
    });
  }

  if (arr.length === 0) throw new Error("No rows.");

  // Validate shape on the first row so a wrong-format paste fails loud.
  const first = arr[0];
  if (
    typeof first?.session_id !== "string" ||
    typeof first?.message !== "object" ||
    first.message === null
  ) {
    throw new Error(
      "Each row needs {id, session_id, message:{type, content}}. The first row didn't match.",
    );
  }

  // Sort globally by id so the synthetic timestamp respects the
  // operator-recorded sequence.
  const rows = [...arr].sort((a, b) => Number(a.id) - Number(b.id));
  const ids = rows.map((r) => Number(r.id));
  const maxId = Math.max(...ids);
  const now = Date.now();

  const contactsByWa = new Map<string, ImportContact>();
  const messages: ImportMessage[] = [];
  const previewBySession = new Map<
    string,
    Array<{ direction: "inbound" | "outbound"; content: string; timestamp: string }>
  >();

  for (const r of rows) {
    const waId = String(r.session_id ?? "").replace(/\D/g, "");
    if (!waId) continue;
    if (!contactsByWa.has(waId)) {
      contactsByWa.set(waId, { wa_id: waId });
    }
    const m = r.message as { type?: string; content?: string };
    const type = (m?.type ?? "").toLowerCase();
    const direction: "inbound" | "outbound" = type === "ai" ? "outbound" : "inbound";
    // Strip embedded agent tool-call traces — keep just the real message.
    const content = cleanMessageContent((m?.content ?? "").toString());
    // Rows that were nothing but a tool-call trace clean down to empty —
    // skip them so the imported chat is only real inbound/outbound text.
    if (!content) continue;
    // Synthesise an ISO timestamp. (max_id - id) minutes ago anchored
    // at "now" so all rows have a stable chronological order.
    const ts = new Date(now - (maxId - Number(r.id)) * 60_000).toISOString();
    messages.push({
      wa_id: waId,
      direction,
      type: "text",
      content,
      timestamp: ts,
      status: direction === "outbound" ? "delivered" : "delivered",
    });
    const arr2 = previewBySession.get(waId) ?? [];
    arr2.push({ direction, content, timestamp: ts });
    previewBySession.set(waId, arr2);
  }

  return {
    contacts: Array.from(contactsByWa.values()),
    messages,
    previewBySession,
  };
}

function SessionsMode({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (p: { contacts: ImportContact[]; messages: ImportMessage[] }) => void;
}) {
  const [raw, setRaw] = useState("");
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSessions | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  // .txt-import-only — the WhatsApp export file doesn't include the
  // customer's phone, so we ask the operator for it (auto-filled from
  // the filename when possible). The operator hint helps us tell which
  // sender lines are theirs vs the customer's.
  const [txtWaId, setTxtWaId] = useState("");
  const [operatorHint, setOperatorHint] = useState("");

  const isTxt = raw.trim().length > 0 && looksLikeWhatsAppTxt(raw);

  function parse() {
    setParseErr(null);
    setParsed(null);
    if (!raw.trim()) {
      setParseErr("Paste your rows or upload a file first.");
      return;
    }
    try {
      const result = isTxt
        ? parseWhatsAppTxt(raw, txtWaId, operatorHint)
        : parseSessions(raw);
      setParsed(result);
      const first = Array.from(result.previewBySession.keys())[0] ?? null;
      setActiveSession(first);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : "Parse failed");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(String(reader.result ?? ""));
      // Try to lift the customer phone out of the filename — our own
      // export writes "chat-<name>-<waid>.txt", and operators often
      // rename WhatsApp's "WhatsApp Chat with X.txt" similarly.
      const digits = f.name.replace(/\.\w+$/, "").match(/(\d{8,})/);
      if (digits) setTxtWaId(digits[1]);
    };
    reader.readAsText(f);
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
        Columns: <code className="font-mono text-[10px]">id, session_id, message</code> — where{" "}
        <strong>session_id</strong> is the customer phone, <strong>message</strong> is the
        JSON cell with <code className="font-mono text-[10px]">{`{type, content, …}`}</code>
        , <strong>type=human</strong> = inbound, <strong>type=ai</strong> = outbound.
        Accepts <strong>CSV</strong> (Excel / Numbers export), <strong>JSON</strong>{" "}
        (<code className="font-mono text-[10px]">SELECT json_agg(row_to_json(t))</code>),
        or a <strong>WhatsApp .txt</strong> chat export (the one Android / iOS produces, or
        our own <code className="font-mono text-[10px]">Export</code> button).
        Timestamps are synthesised in id order when the source has none.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">
          <Upload className="h-3.5 w-3.5" />
          Upload .csv, .json or .txt file
          <input
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json,text/plain"
            disabled={disabled}
            onChange={onFile}
            className="hidden"
          />
        </label>
        <span className="text-[11px] text-muted-foreground">
          or paste the rows below
        </span>
      </div>

      {isTxt ? (
        <div className="grid gap-2 rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-[11px] text-primary sm:grid-cols-2">
          <div className="sm:col-span-2 text-primary">
            Detected a WhatsApp .txt chat export. Fill in the customer&apos;s phone so the
            messages attach to the right contact, and (optionally) your own name as
            it appears in the file so outbound vs inbound is correct.
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              Customer phone (wa_id) <span className="text-rose-600">*</span>
            </span>
            <input
              type="text"
              value={txtWaId}
              onChange={(e) => setTxtWaId(e.target.value)}
              placeholder="e.g. 919045454045"
              disabled={disabled}
              className="rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              Operator name in file (optional)
            </span>
            <input
              type="text"
              value={operatorHint}
              onChange={(e) => setOperatorHint(e.target.value)}
              placeholder="e.g. Birjul"
              disabled={disabled}
              className="rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </label>
        </div>
      ) : null}

      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={disabled}
        placeholder='[{"id":315,"session_id":"9720075410","message":{"type":"human","content":"Hello"}}, …]'
        rows={10}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
      />

      {parseErr ? (
        <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-1.5 text-xs text-rose-800">
          {parseErr}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={parse}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
        >
          Parse &amp; preview
        </button>
      </div>

      {parsed ? (
        <SessionsPreview
          parsed={parsed}
          activeSession={activeSession}
          setActiveSession={setActiveSession}
          disabled={disabled}
          onConfirm={() =>
            onSubmit({ contacts: parsed.contacts, messages: parsed.messages })
          }
        />
      ) : null}
    </div>
  );
}

function SessionsPreview({
  parsed,
  activeSession,
  setActiveSession,
  disabled,
  onConfirm,
}: {
  parsed: ParsedSessions;
  activeSession: string | null;
  setActiveSession: (s: string) => void;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const sessions = Array.from(parsed.previewBySession.entries()).map(
    ([waId, msgs]) => ({ waId, msgs }),
  );
  const active = sessions.find((s) => s.waId === activeSession) ?? sessions[0];

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center justify-between gap-3 border-b bg-primary/10 px-4 py-2.5">
        <div className="text-[11px] font-semibold text-primary">
          Preview · <strong>{parsed.contacts.length}</strong> contact(s),{" "}
          <strong>{parsed.messages.length}</strong> message(s) will be imported.
          Pick a session to preview the chat below before confirming.
        </div>
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          Confirm &amp; import
        </button>
      </header>

      <div className="grid gap-0 md:grid-cols-[200px_1fr]">
        {/* Session picker rail */}
        <nav className="max-h-80 overflow-auto border-b bg-secondary/30 p-2 md:border-b-0 md:border-r">
          {sessions.map((s) => {
            const isActive = active?.waId === s.waId;
            return (
              <button
                key={s.waId}
                type="button"
                onClick={() => setActiveSession(s.waId)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition",
                  isActive
                    ? "bg-card font-semibold text-foreground ring-1 ring-primary/25"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                <span className="truncate font-mono">+{s.waId}</span>
                <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0 text-[10px] font-semibold">
                  {s.msgs.length}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Chat bubbles */}
        <div className="max-h-80 space-y-2 overflow-auto bg-[#e5ddd5] bg-opacity-30 p-3">
          {active?.msgs.slice(-50).map((m, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                m.direction === "outbound" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[78%] rounded-2xl px-3 py-1.5 text-[12px] leading-snug shadow-sm",
                  m.direction === "outbound"
                    ? "rounded-br-sm bg-primary/15 text-foreground"
                    : "rounded-bl-sm bg-white text-foreground",
                )}
              >
                <div className="whitespace-pre-wrap">{m.content || <span className="italic text-muted-foreground">[empty]</span>}</div>
              </div>
            </div>
          ))}
          {!active || active.msgs.length === 0 ? (
            <div className="grid h-40 place-items-center text-xs text-muted-foreground">
              No messages in this session.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: JSON paste / file
// ---------------------------------------------------------------------------
function JsonMode({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (p: { contacts: ImportContact[]; messages: ImportMessage[] }) => void;
}) {
  const [raw, setRaw] = useState("");
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{
    contacts: ImportContact[];
    messages: ImportMessage[];
  } | null>(null);

  function parse() {
    setParseErr(null);
    setParsed(null);
    if (!raw.trim()) {
      setParseErr("Paste JSON or upload a file first.");
      return;
    }
    try {
      const obj = JSON.parse(raw);
      // Accept either { contacts: [...], messages: [...] } or a single array
      // of messages (we'll derive contacts from unique wa_ids in that case).
      let contacts: ImportContact[] = [];
      let messages: ImportMessage[] = [];
      if (Array.isArray(obj)) {
        messages = obj as ImportMessage[];
      } else if (typeof obj === "object" && obj !== null) {
        contacts = Array.isArray((obj as Record<string, unknown>).contacts)
          ? ((obj as Record<string, unknown>).contacts as ImportContact[])
          : [];
        messages = Array.isArray((obj as Record<string, unknown>).messages)
          ? ((obj as Record<string, unknown>).messages as ImportMessage[])
          : [];
      } else {
        throw new Error("Top-level JSON must be an object or array.");
      }
      // Derive contacts from message wa_ids when not supplied.
      if (contacts.length === 0 && messages.length > 0) {
        const seen = new Set<string>();
        for (const m of messages) {
          const w = (m.wa_id ?? "").replace(/\D/g, "");
          if (!w || seen.has(w)) continue;
          seen.add(w);
          contacts.push({ wa_id: w });
        }
      }
      setParsed({ contacts, messages });
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : "Parse failed");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result ?? ""));
    reader.readAsText(f);
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
        Expected shape:{" "}
        <code className="font-mono text-[10px]">
          {`{ contacts: [{wa_id, name?, profile_name?}], messages: [{wa_id, wa_message_id?, direction, type?, content, timestamp, status?, media_url?, media_mime_type?}] }`}
        </code>
        . Contacts can be omitted — we&apos;ll derive them from the messages.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">
          <Upload className="h-3.5 w-3.5" />
          Upload .json file
          <input
            type="file"
            accept="application/json,.json"
            disabled={disabled}
            onChange={onFile}
            className="hidden"
          />
        </label>
        <span className="text-[11px] text-muted-foreground">
          or paste JSON in the box below
        </span>
      </div>

      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={disabled}
        placeholder='{"contacts":[…], "messages":[…]}'
        rows={10}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
      />

      {parseErr ? (
        <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-1.5 text-xs text-rose-800">
          {parseErr}
        </div>
      ) : null}
      {parsed ? (
        <div className="rounded-md border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs text-primary">
          Parsed: <strong>{parsed.contacts.length}</strong> contact(s),{" "}
          <strong>{parsed.messages.length}</strong> message(s).
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={parse}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
        >
          Parse
        </button>
        <button
          type="button"
          onClick={() => parsed && onSubmit(parsed)}
          disabled={disabled || !parsed}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          Start import
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: CSV
// Schema (one file, two-block layout):
//   • contacts.csv → wa_id,name,profile_name
//   • messages.csv → wa_id,wa_message_id,direction,type,content,timestamp,status,media_url,media_mime_type
// ---------------------------------------------------------------------------
function CsvMode({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (p: { contacts: ImportContact[]; messages: ImportMessage[] }) => void;
}) {
  const [contactsCsv, setContactsCsv] = useState("");
  const [messagesCsv, setMessagesCsv] = useState("");
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{
    contacts: ImportContact[];
    messages: ImportMessage[];
  } | null>(null);

  function parse() {
    setParseErr(null);
    setParsed(null);
    try {
      let contacts: ImportContact[] = [];
      if (contactsCsv.trim()) {
        const rows = parseCsv(contactsCsv);
        contacts = rows.map((r) => ({
          wa_id: String(r.wa_id ?? r.phone ?? "").replace(/\D/g, ""),
          name: r.name?.toString().trim() || null,
          profile_name: r.profile_name?.toString().trim() || null,
        })).filter((c) => c.wa_id);
      }
      let messages: ImportMessage[] = [];
      if (messagesCsv.trim()) {
        const rows = parseCsv(messagesCsv);
        messages = rows.map((r) => ({
          wa_id: String(r.wa_id ?? r.phone ?? "").replace(/\D/g, ""),
          wa_message_id: r.wa_message_id?.toString().trim() || null,
          direction:
            (r.direction?.toString().toLowerCase() === "outbound" ? "outbound" : "inbound") as
              | "inbound"
              | "outbound",
          type: r.type?.toString().trim() || "text",
          content: r.content?.toString() ?? null,
          timestamp: r.timestamp?.toString() ?? new Date().toISOString(),
          status: r.status?.toString() || "delivered",
          media_url: r.media_url?.toString() || null,
          media_mime_type: r.media_mime_type?.toString() || null,
        })).filter((m) => m.wa_id);
      }
      // Derive contacts from messages if not supplied.
      if (contacts.length === 0 && messages.length > 0) {
        const seen = new Set<string>();
        for (const m of messages) {
          if (seen.has(m.wa_id)) continue;
          seen.add(m.wa_id);
          contacts.push({ wa_id: m.wa_id });
        }
      }
      setParsed({ contacts, messages });
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : "Parse failed");
    }
  }

  function onFile(target: "contacts" | "messages") {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        if (target === "contacts") setContactsCsv(text);
        else setMessagesCsv(text);
      };
      reader.readAsText(f);
    };
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
        Headers required. Contacts:{" "}
        <code className="font-mono text-[10px]">
          wa_id,name,profile_name
        </code>{" "}
        · Messages:{" "}
        <code className="font-mono text-[10px]">
          wa_id,wa_message_id,direction,type,content,timestamp,status,media_url,media_mime_type
        </code>
        . Contacts CSV is optional — derived from messages if omitted.
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <CsvField
          label="contacts.csv (optional)"
          value={contactsCsv}
          setValue={setContactsCsv}
          onFile={onFile("contacts")}
          disabled={disabled}
        />
        <CsvField
          label="messages.csv"
          value={messagesCsv}
          setValue={setMessagesCsv}
          onFile={onFile("messages")}
          disabled={disabled}
        />
      </div>

      {parseErr ? (
        <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-1.5 text-xs text-rose-800">
          {parseErr}
        </div>
      ) : null}
      {parsed ? (
        <div className="rounded-md border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs text-primary">
          Parsed: <strong>{parsed.contacts.length}</strong> contact(s),{" "}
          <strong>{parsed.messages.length}</strong> message(s).
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={parse}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
        >
          Parse
        </button>
        <button
          type="button"
          onClick={() => parsed && onSubmit(parsed)}
          disabled={disabled || !parsed}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          Start import
        </button>
      </div>
    </div>
  );
}

function CsvField({
  label,
  value,
  setValue,
  onFile,
  disabled,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary">
          <Upload className="h-3 w-3" />
          Upload
          <input
            type="file"
            accept="text/csv,.csv"
            disabled={disabled}
            onChange={onFile}
            className="hidden"
          />
        </label>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        rows={8}
        placeholder="wa_id,name,profile_name&#10;919876543210,Aarav,Aarav Sharma"
        className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px] shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
      />
    </div>
  );
}

// Minimal CSV parser. Handles quoted values + commas inside quotes.
// Not a full RFC 4180 implementation — fine for migration loads where
// the operator can clean up the source CSV.
// Quote-aware CSV parser. The old line-first variant split on every
// '\n' before parsing, which broke whenever a quoted content field
// held a literal newline (very common for WhatsApp messages). That
// shifted every column after the break, and downstream parts of the
// message body landed in numeric columns — e.g. the literal text
// "no smoking" ended up in the `timestamp` column and Postgres
// threw `invalid input syntax for type timestamp with time zone`.
//
// This implementation walks the whole text character-by-character.
// Newlines only end a record when we're OUTSIDE a quoted field;
// inside quotes they're preserved as part of the cell.
function parseCsv(text: string): Array<Record<string, string>> {
  const rawRows = splitCsvRows(text);
  if (rawRows.length === 0) return [];
  const headers = rawRows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rawRows.length; r++) {
    const cells = rawRows[r];
    // Skip blank lines between rows (single empty cell, no real content).
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, j) => {
      obj[h] = cells[j] ?? "";
    });
    out.push(obj);
  }
  return out;
}

function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false; // inside a "quoted" field
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        q = false;
      } else {
        cur += ch; // preserve newlines inside the quoted field
      }
    } else {
      if (ch === '"') {
        q = true;
      } else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\r") {
        // ignore — \n on the next iteration ends the row
      } else if (ch === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  // Trailing record without a final newline.
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Mode: Supabase table
// Skips the CSV download/upload roundtrip entirely. Operator types the
// source table name (e.g. an old `918069805090  WA Precious Chat ` archive
// already sitting in Supabase), we probe it for shape + counts, show a
// preview card, and run the import as a single Postgres function — no
// data ever leaves the DB. Drops 2M-row imports from minutes-of-network-
// shuffling to a few seconds.
// ---------------------------------------------------------------------------
function TableMode({
  targetBpid,
  label,
  disabled,
}: {
  targetBpid: string;
  label: string;
  disabled: boolean;
}) {
  const [tableName, setTableName] = useState("");
  const [preview, setPreview] = useState<{
    source_table: string;
    resolved_from: string | null;
    total_rows: number;
    distinct_contacts: number | null;
    column_map: Record<string, string | null>;
    sample: Array<Record<string, unknown>>;
    warnings: string[];
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inserted_contacts: number;
    inserted_messages: number;
    skipped_messages: number;
  } | null>(null);

  async function handlePreview() {
    setErr(null);
    setResult(null);
    setPreviewing(true);
    try {
      const res = await fetch("/api/import/chats/from-table/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_table: tableName.trim() }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string } & typeof preview;
      if (!res.ok || !j?.ok) {
        setErr(j?.error ?? `HTTP ${res.status}`);
        setPreview(null);
        return;
      }
      setPreview({
        source_table: (j as unknown as { source_table?: string }).source_table ?? tableName.trim(),
        resolved_from: (j as unknown as { resolved_from?: string | null }).resolved_from ?? null,
        total_rows: j.total_rows,
        distinct_contacts: j.distinct_contacts,
        column_map: j.column_map,
        sample: j.sample,
        warnings: j.warnings,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleRun() {
    if (!preview || !targetBpid) return;
    setErr(null);
    setRunning(true);
    try {
      const res = await fetch("/api/import/chats/from-table/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Use the resolved name from preview (whitespace-corrected)
          // so the run-side query hits the actual table.
          source_table: preview.source_table,
          target_bpid: targetBpid,
          label: label.trim() || undefined,
          column_map: preview.column_map,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        inserted_contacts?: number;
        inserted_messages?: number;
        skipped_messages?: number;
      };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult({
        inserted_contacts: j.inserted_contacts ?? 0,
        inserted_messages: j.inserted_messages ?? 0,
        skipped_messages: j.skipped_messages ?? 0,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  }

  const requiredMissing =
    preview &&
    ["wa_id", "direction", "content", "timestamp"].some(
      (k) => !preview.column_map[k],
    );

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
        <strong className="text-foreground">Source table</strong> — any
        Supabase table in this project&apos;s <code className="rounded bg-foreground/5 px-1">public</code>
        {" "}schema. Spaces in the name are allowed (e.g.{" "}
        <code className="rounded bg-foreground/5 px-1">918069805090  WA Precious Chat </code>).
        Required columns:{" "}
        <code className="rounded bg-foreground/5 px-1">wa_id</code>,{" "}
        <code className="rounded bg-foreground/5 px-1">direction</code>,{" "}
        <code className="rounded bg-foreground/5 px-1">content</code>,{" "}
        <code className="rounded bg-foreground/5 px-1">timestamp</code>. Type
        / media_url optional.
      </div>

      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={tableName}
          onChange={(e) => {
            setTableName(e.target.value);
            setPreview(null);
            setResult(null);
          }}
          disabled={disabled || running}
          placeholder="918069805090  WA Precious Chat "
          className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handlePreview}
          disabled={disabled || previewing || !tableName.trim()}
          className="inline-flex h-10 items-center gap-1.5 rounded-md bg-secondary px-3 text-xs font-semibold hover:bg-accent disabled:opacity-50"
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Preview
        </button>
      </div>

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {err}
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-3 rounded-lg border bg-card px-4 py-3">
          {preview.resolved_from ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">
              Matched <code className="font-mono">{preview.source_table}</code>{" "}
              (you typed <code className="font-mono">{preview.resolved_from}</code> — whitespace differs).
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-primary">
              {preview.total_rows.toLocaleString()} rows
            </span>
            {preview.distinct_contacts !== null ? (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-800">
                {preview.distinct_contacts.toLocaleString()} unique contacts
              </span>
            ) : null}
          </div>

          <div className="text-[11px]">
            <div className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
              Column mapping
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              {Object.entries(preview.column_map).map(([canonical, mapped]) => (
                <div key={canonical}>
                  <span className="text-muted-foreground">{canonical}</span>
                  {" → "}
                  {mapped ? (
                    <span className="text-primary">{mapped}</span>
                  ) : (
                    <span className="text-rose-600">missing</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {preview.warnings.length > 0 ? (
            <ul className="list-disc rounded-md border border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-900">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}

          {preview.sample.length > 0 ? (
            <details className="rounded-md border bg-background text-[11px]">
              <summary className="cursor-pointer px-3 py-1.5 font-semibold text-muted-foreground">
                Sample (first 10 rows)
              </summary>
              <pre className="max-h-48 overflow-auto bg-foreground/5 px-3 py-2 text-[10.5px]">
                {JSON.stringify(preview.sample, null, 2)}
              </pre>
            </details>
          ) : null}

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleRun}
              disabled={running || requiredMissing || !targetBpid}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {running
                ? "Importing…"
                : `Import into ${targetBpid || "—"}`}
            </button>
          </div>
          {requiredMissing ? (
            <div className="text-[11px] text-rose-700">
              Source is missing a required column — can&apos;t import. Fix the
              source table or pick a different one.
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">
          <strong>Done.</strong> Inserted{" "}
          {result.inserted_contacts.toLocaleString()} new contact
          {result.inserted_contacts === 1 ? "" : "s"} and{" "}
          {result.inserted_messages.toLocaleString()} new message
          {result.inserted_messages === 1 ? "" : "s"}.
          {result.skipped_messages > 0
            ? ` Skipped ${result.skipped_messages.toLocaleString()} duplicates / invalid rows.`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: Node script
// Generates a self-contained migration script the operator can run locally
// to mirror from an old Supabase DB into this workspace's import API.
// ---------------------------------------------------------------------------
function ScriptMode({
  targetBpid,
  label,
}: {
  targetBpid: string;
  label: string;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://YOUR-DOMAIN";
  const script = useMemo(
    () => generateScript({ apiBase: origin, targetBpid, label }),
    [origin, targetBpid, label],
  );
  const [copied, setCopied] = useState(false);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — operator can still select + copy manually */
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
        Use this for 50k+ messages where browser uploading would be flaky.
        Fill in <code>SOURCE_DB_URL</code> + <code>QHT_COOKIE</code> (copy
        from your browser DevTools → Application → Cookies after logging
        in to this workspace), then run <code>node import.mjs</code>.
        Idempotent — safe to re-run after a network blip.
      </div>
      <div className="relative">
        <pre className="max-h-[420px] overflow-auto rounded-md border bg-slate-950 px-4 py-3 font-mono text-[11px] leading-relaxed text-slate-100">
          {script}
        </pre>
        <button
          type="button"
          onClick={copyAll}
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-100 hover:bg-slate-700"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function generateScript(opts: { apiBase: string; targetBpid: string; label: string }): string {
  const labelSafe = (opts.label || "Bulk migration").replace(/`/g, "");
  return `// import.mjs — copy a chat history from your OLD Supabase into this workspace.
// Usage: node import.mjs
// Requires: node >= 18, "postgres" npm package (run: npm i postgres)

import postgres from "postgres";

// ============ CONFIG ============
const SOURCE_DB_URL = "postgresql://USER:PASS@HOST:5432/DBNAME"; // your OLD supabase
const API_BASE     = "${opts.apiBase}";
const TARGET_BPID  = "${opts.targetBpid}";
const LABEL        = \`${labelSafe}\`;
const QHT_COOKIE   = "sb-…=…"; // paste the cookie from your browser (DevTools → Application → Cookies)
const BATCH        = 500;
// ================================

const sql = postgres(SOURCE_DB_URL, { ssl: { rejectUnauthorized: false } });

async function post(path, body) {
  const r = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: QHT_COOKIE },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(\`\${path} → HTTP \${r.status} \${JSON.stringify(j)}\`);
  return j;
}

async function main() {
  // Adjust these SELECTs to your old schema. Defaults assume the same
  // contacts/messages shape as this workspace.
  const contacts = await sql\`
    select wa_id, name, profile_name
    from contacts
    where business_phone_number_id = \${TARGET_BPID}
       or business_phone_number_id is null
  \`;
  const messages = await sql\`
    select c.wa_id,
           m.wa_message_id,
           m.direction,
           m.type,
           m.content,
           m.media_url,
           m.media_mime_type,
           coalesce(m.status, 'delivered') as status,
           m.timestamp
    from messages m
    join contacts c on c.id = m.contact_id
    where c.business_phone_number_id = \${TARGET_BPID}
       or c.business_phone_number_id is null
    order by m.timestamp asc
  \`;
  console.log(\`Source: \${contacts.length} contacts, \${messages.length} messages.\`);

  const { job } = await post("/api/import/chats/start", {
    target_bpid: TARGET_BPID,
    label: LABEL,
    source_format: "script",
    total_contacts: contacts.length,
    total_messages: messages.length,
  });
  console.log("Job:", job.id);

  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH);
    await post("/api/import/chats/batch", { job_id: job.id, contacts: batch });
    console.log(\`  contacts \${i + batch.length}/\${contacts.length}\`);
  }
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    await post("/api/import/chats/batch", { job_id: job.id, messages: batch });
    console.log(\`  messages \${i + batch.length}/\${messages.length}\`);
  }
  const finished = await post("/api/import/chats/finish", { job_id: job.id });
  console.log("Finished:", finished.job);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
`;
}

// ---------------------------------------------------------------------------
// Progress + history widgets
// ---------------------------------------------------------------------------
function ProgressBlock({ job, log }: { job: ImportJob; log: string[] }) {
  const totalC = Math.max(job.total_contacts, job.processed_contacts);
  const totalM = Math.max(job.total_messages, job.processed_messages);
  const pctC = totalC > 0 ? Math.min(100, (job.processed_contacts / totalC) * 100) : 0;
  const pctM = totalM > 0 ? Math.min(100, (job.processed_messages / totalM) * 100) : 0;
  return (
    <div className="border-b bg-primary/10 px-5 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-primary">
        {job.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : job.status === "failed" ? (
          <X className="h-4 w-4 text-rose-700" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        Job {job.id.slice(0, 8)} · {job.status}
      </div>
      <div className="grid gap-1.5 text-[11px]">
        <ProgressLine label="Contacts" pct={pctC} done={job.processed_contacts} total={totalC} ins={job.inserted_contacts} />
        <ProgressLine label="Messages" pct={pctM} done={job.processed_messages} total={totalM} ins={job.inserted_messages} />
      </div>
      {log.length > 0 ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded border bg-white px-2 py-1 font-mono text-[10px] text-slate-700">
          {log.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

function ProgressLine({
  label,
  pct,
  done,
  total,
  ins,
}: {
  label: string;
  pct: number;
  done: number;
  total: number;
  ins: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-primary/80">
        <span>{label}</span>
        <span className="font-mono">
          {done}/{total} · inserted {ins}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
        <div
          className="h-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function JobsHistory({ jobs }: { jobs: ImportJob[] | null }) {
  if (jobs === null) {
    return (
      <div className="grid h-16 place-items-center text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <div className="px-5 py-4 text-center text-xs text-muted-foreground">
        No imports yet.
      </div>
    );
  }
  return (
    <div className="px-5 py-3">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Recent imports
      </div>
      <ul className="divide-y rounded-md border">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-start justify-between gap-3 px-3 py-2 text-[11px]">
            <div className="min-w-0">
              <div className="truncate font-medium">
                {j.label || `Job ${j.id.slice(0, 8)}`}
              </div>
              <div className="mt-0.5 truncate text-muted-foreground">
                {new Date(j.created_at).toLocaleString()} ·{" "}
                <span className="font-mono">{j.target_bpid}</span> · {j.source_format}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <span
                className={cn(
                  "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  j.status === "completed"
                    ? "bg-primary/10 text-primary ring-1 ring-primary/25"
                    : j.status === "running"
                      ? "bg-sky-50 text-sky-700 ring-1 ring-sky-200"
                      : j.status === "failed" || j.status === "cancelled"
                        ? "bg-rose-50 text-rose-800 ring-1 ring-rose-200"
                        : "bg-slate-50 text-slate-700 ring-1 ring-slate-200",
                )}
              >
                {j.status}
              </span>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {j.inserted_messages} msgs · {j.inserted_contacts} contacts
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
