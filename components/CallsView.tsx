"use client";

// Call history page.
//
// Layout: stat strip across the top, two-pane below — left = the
// scrollable call log grouped by date, right = a rich detail card
// with audio player, transcript, and full meta. Density is tight on
// purpose; the previous "huge empty middle" was the symptom of a
// list-only layout when there are only a handful of calls per day.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCheck,
  Clock,
  Copy,
  Download,
  FileAudio,
  Loader2,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  RefreshCw,
  Search,
  Sparkles,
  Timer,
  TrendingUp,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import { PremiumHeader } from "@/components/PremiumHeader";
import { usePhoneMasker, useNameOrPhoneMasker } from "@/components/PermissionsContext";

interface CallContact {
  id: string;
  name: string | null;
  profile_name: string | null;
  wa_id: string;
  avatar_url: string | null;
}

interface CallRow {
  id: string;
  wa_call_id: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  direction: "inbound" | "outbound";
  status: "ringing" | "accepted" | "rejected" | "terminated" | "missed" | "failed";
  start_at: string;
  accepted_at: string | null;
  end_at: string | null;
  duration_seconds: number | null;
  ring_seconds: number | null;
  recording_url: string | null;
  recording_mime: string | null;
  transcript: string | null;
  transcript_status: "none" | "pending" | "done" | "failed" | null;
  handled_by_email: string | null;
  contacts?: CallContact | null;
}

type DirectionFilter = "all" | "inbound" | "outbound";
type StatusFilter =
  | "all"
  | "accepted"
  | "rejected"
  | "terminated"
  | "missed"
  | "failed";

const STATUS_META: Record<
  CallRow["status"],
  { label: string; tone: string; icon: typeof PhoneIncoming }
> = {
  ringing:    { label: "Ringing",   tone: "bg-amber-100 text-amber-700 ring-amber-200",       icon: PhoneIncoming },
  accepted:   { label: "Live",      tone: "bg-emerald-100 text-emerald-700 ring-emerald-200", icon: CheckCheck },
  rejected:   { label: "Declined",  tone: "bg-rose-100 text-rose-700 ring-rose-200",          icon: PhoneOff },
  terminated: { label: "Completed", tone: "bg-emerald-100 text-emerald-700 ring-emerald-200", icon: CheckCheck },
  missed:     { label: "Missed",    tone: "bg-rose-50 text-rose-700 ring-rose-200",           icon: PhoneMissed },
  failed:     { label: "Failed",    tone: "bg-rose-100 text-rose-800 ring-rose-300",          icon: AlertTriangle },
};

interface BusinessNumberLite {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
}

export function CallsView() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [numbers, setNumbers] = useState<Map<string, BusinessNumberLite>>(new Map());

  // Load business numbers once — used to render the friendly badge on
  // every call row (instead of the raw phone_number_id).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/business-numbers", { cache: "no-store" });
        const json = (await res.json()) as { numbers?: BusinessNumberLite[] };
        if (cancelled) return;
        const map = new Map<string, BusinessNumberLite>();
        for (const n of json.numbers ?? []) map.set(n.phone_number_id, n);
        setNumbers(map);
      } catch {
        /* non-fatal — falls back to raw ID */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  const debouncedQ = useDebounced(q, 280);

  const fetchPage = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "60");
        if (!reset && cursor) params.set("cursor", cursor);
        if (debouncedQ) params.set("q", debouncedQ);
        if (direction !== "all") params.set("direction", direction);
        if (status !== "all") params.set("status", status);
        const res = await fetch(`/api/whatsapp-call/list?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          calls?: CallRow[];
          next_cursor?: string | null;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (reset) {
          setCalls(json.calls ?? []);
          const first = (json.calls ?? [])[0];
          setSelectedId(first ? first.wa_call_id : null);
        } else {
          setCalls((prev) => [...prev, ...(json.calls ?? [])]);
        }
        setCursor(json.next_cursor ?? null);
        setHasMore(!!json.next_cursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [cursor, debouncedQ, direction, status],
  );

  useEffect(() => {
    setCursor(null);
    setHasMore(true);
    fetchPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, direction, status]);

  // Stats from the loaded slice. For an "all-time" number we'd run a
  // separate aggregate, but the visible page is what the operator
  // cares about anyway.
  const stats = useMemo(() => {
    const total = calls.length;
    const answered = calls.filter(
      (c) => c.status === "accepted" || c.status === "terminated",
    ).length;
    const missed = calls.filter(
      (c) => c.status === "missed" || c.status === "rejected" || c.status === "failed",
    ).length;
    const totalTalk = calls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0);
    const avgTalk = answered > 0 ? Math.round(totalTalk / answered) : 0;
    return { total, answered, missed, totalTalk, avgTalk };
  }, [calls]);

  const selected = useMemo(
    () => calls.find((c) => c.wa_call_id === selectedId) ?? null,
    [calls, selectedId],
  );

  // Group by calendar day for the list — section headers ("Today",
  // "Yesterday", "Wed, Feb 4") make a sparse log feel structured
  // even when only a couple of calls landed on a given day.
  const grouped = useMemo(() => groupByDay(calls), [calls]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-secondary/40 to-secondary/10">
      <PremiumHeader
        icon={PhoneCall}
        title="Call history"
        subtitle="Every WhatsApp call · recordings · transcripts · agent attribution."
        tone="emerald"
        right={
          <button
            type="button"
            onClick={() => fetchPage(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        }
      />

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 border-b bg-card/60 px-6 py-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard
          icon={PhoneCall}
          label="Total calls"
          value={String(stats.total)}
          tone="from-slate-500 to-slate-600"
        />
        <StatCard
          icon={CheckCheck}
          label="Answered"
          value={String(stats.answered)}
          tone="from-emerald-500 to-emerald-600"
        />
        <StatCard
          icon={PhoneMissed}
          label="Missed"
          value={String(stats.missed)}
          tone="from-rose-500 to-rose-600"
        />
        <StatCard
          icon={Timer}
          label="Talk time"
          value={fmtDuration(stats.totalTalk)}
          tone="from-violet-500 to-violet-600"
          mono
        />
        <StatCard
          icon={TrendingUp}
          label="Avg call"
          value={fmtDuration(stats.avgTalk)}
          tone="from-blue-500 to-blue-600"
          mono
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-6 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, number, agent or transcript…"
            className="h-8 w-72 rounded-md border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
        </div>
        <FilterChips
          value={direction}
          onChange={(v) => setDirection(v as DirectionFilter)}
          options={[
            { v: "all",      label: "All" },
            { v: "inbound",  label: "Inbound" },
            { v: "outbound", label: "Outbound" },
          ]}
        />
        <FilterChips
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={[
            { v: "all",        label: "Any status" },
            { v: "terminated", label: "Completed" },
            { v: "missed",     label: "Missed" },
            { v: "rejected",   label: "Declined" },
            { v: "failed",     label: "Failed" },
          ]}
        />
      </div>

      {error ? (
        <div className="border-b bg-rose-50 px-6 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {calls.length === 0 && !loading ? (
            <EmptyState />
          ) : (
            <div className="px-4 pb-6">
              {grouped.map((group) => (
                <section key={group.key} className="mt-4 first:mt-2">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-gradient-to-b from-secondary/40 to-secondary/10 px-2 py-1.5 backdrop-blur">
                    <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </h2>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {group.calls.length} {group.calls.length === 1 ? "call" : "calls"}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {group.calls.map((call) => (
                      <CallListItem
                        key={call.wa_call_id}
                        call={call}
                        active={call.wa_call_id === selectedId}
                        onClick={() => setSelectedId(call.wa_call_id)}
                        numbers={numbers}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {hasMore ? (
                <div className="flex items-center justify-center pt-4">
                  <button
                    type="button"
                    onClick={() => fetchPage(false)}
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
                  >
                    {loading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    Load more
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Detail */}
        <aside className="w-[440px] shrink-0 overflow-y-auto border-l bg-card">
          {selected ? (
            <CallDetail
              call={selected}
              numbers={numbers}
              onChanged={(patch) =>
                setCalls((prev) =>
                  prev.map((c) =>
                    c.wa_call_id === selected.wa_call_id ? { ...c, ...patch } : c,
                  ),
                )
              }
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center">
              <div className="text-xs text-muted-foreground">
                Pick a call from the left to see its recording, transcript and timeline.
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function CallListItem({
  call,
  active,
  onClick,
  numbers,
}: {
  call: CallRow;
  active: boolean;
  onClick: () => void;
  numbers: Map<string, BusinessNumberLite>;
}) {
  const meta = STATUS_META[call.status];
  const Icon = meta.icon;
  const DirIcon = call.direction === "inbound" ? ArrowDownLeft : ArrowUpRight;
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const name =
    call.contacts?.name?.trim() ||
    call.contacts?.profile_name?.trim() ||
    (call.contacts?.wa_id ? formatPhone(call.contacts.wa_id) : "Unknown caller");

  const wasAnswered = call.status === "terminated" || call.status === "accepted";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left shadow-sm transition",
          active
            ? "border-primary/40 ring-2 ring-primary/20"
            : "border-border hover:border-foreground/20 hover:bg-secondary/40",
        )}
      >
        <Avatar contact={call.contacts ?? null} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{maskName(name)}</span>
            {call.contacts?.wa_id &&
            (call.contacts.name?.trim() || call.contacts.profile_name?.trim()) ? (
              <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                {maskPhone(formatPhone(call.contacts.wa_id))}
              </span>
            ) : null}
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold ring-1 ring-inset",
                meta.tone,
              )}
            >
              <Icon className="h-3 w-3" />
              {meta.label}
            </span>
          </div>
          {/* Fixed-column meta strip — every row aligns the same fields at
              the same x-coordinate so the eye can scan the call log without
              jumping. Direction (90px) · Time (60px) · Duration (80px) ·
              Agent (flexible, truncates) · Business number pill (right). */}
          <div className="mt-0.5 grid grid-cols-[90px_60px_80px_minmax(0,1fr)_auto] items-center gap-x-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <DirIcon
                className={cn(
                  "h-3 w-3",
                  call.direction === "inbound" ? "text-emerald-600" : "text-blue-600",
                )}
              />
              {call.direction === "inbound" ? "Incoming" : "Outgoing"}
            </span>
            <span title={new Date(call.start_at).toLocaleString()} className="tabular-nums">
              {fmtTime(call.start_at)}
            </span>
            {wasAnswered && call.duration_seconds != null ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock className="h-3 w-3" />
                {fmtDuration(call.duration_seconds)}
              </span>
            ) : call.ring_seconds ? (
              <span className="inline-flex items-center gap-1 tabular-nums text-rose-700">
                <Clock className="h-3 w-3" />
                rang {fmtDuration(call.ring_seconds)}
              </span>
            ) : (
              <span className="text-muted-foreground/50">—</span>
            )}
            {call.handled_by_email ? (
              <span
                className="inline-flex min-w-0 items-center gap-1 truncate"
                title={call.handled_by_email}
              >
                <User className="h-3 w-3 shrink-0" />
                <span className="truncate">{agentLabel(call.handled_by_email)}</span>
              </span>
            ) : (
              <span className="text-muted-foreground/50">—</span>
            )}
            {(() => {
              const id = call.business_phone_number_id;
              if (!id) return <span />;
              const bn = numbers.get(id);
              const name = bn?.verified_name?.trim() || "";
              const phone = bn?.display_phone_number?.trim() || "";
              if (!name && !phone) return <span />;
              return (
                <span
                  className="justify-self-end inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700 ring-1 ring-violet-100"
                  title={`${call.direction === "inbound" ? "Came in on" : "Called from"} ${name || phone}`}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                  {name ? <span className="truncate max-w-[90px]">{name}</span> : null}
                  {phone ? (
                    <span className="font-mono tabular-nums text-violet-900/80">
                      {phone}
                    </span>
                  ) : null}
                </span>
              );
            })()}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {call.recording_url ? (
            <FileAudio
              className="h-4 w-4 text-emerald-600"
              aria-label="Recording available"
            />
          ) : null}
          {call.transcript ? (
            <Sparkles
              className="h-4 w-4 text-violet-600"
              aria-label="Transcript available"
            />
          ) : null}
        </div>
      </button>
    </li>
  );
}

function CallDetail({
  call,
  numbers,
  onChanged,
}: {
  call: CallRow;
  numbers: Map<string, BusinessNumberLite>;
  onChanged: (patch: Partial<CallRow>) => void;
}) {
  const meta = STATUS_META[call.status];
  const Icon = meta.icon;
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const name =
    call.contacts?.name?.trim() ||
    call.contacts?.profile_name?.trim() ||
    (call.contacts?.wa_id ? formatPhone(call.contacts.wa_id) : "Unknown caller");

  const [transcribing, setTranscribing] = useState(false);
  const [transcribeErr, setTranscribeErr] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  async function transcribe() {
    if (transcribing) return;
    setTranscribing(true);
    setTranscribeErr(null);
    try {
      const res = await fetch(
        `/api/whatsapp-call/${encodeURIComponent(call.wa_call_id)}/transcribe`,
        { method: "POST" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        transcript?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      onChanged({
        transcript: json.transcript ?? null,
        transcript_status: "done",
      });
    } catch (e) {
      setTranscribeErr(e instanceof Error ? e.message : "Transcription failed");
      onChanged({ transcript_status: "failed" });
    } finally {
      setTranscribing(false);
    }
  }

  async function copyTranscript() {
    if (!call.transcript) return;
    try {
      await navigator.clipboard.writeText(call.transcript);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1500);
    } catch {
      /* ignore */
    }
  }

  const wasAnswered = call.status === "terminated" || call.status === "accepted";

  return (
    <div className="flex h-full flex-col">
      {/* Hero card */}
      <div
        className={cn(
          "relative overflow-hidden border-b px-5 pb-5 pt-6",
          wasAnswered
            ? "bg-gradient-to-br from-emerald-50 via-card to-card"
            : "bg-gradient-to-br from-rose-50 via-card to-card",
        )}
      >
        <div className="flex items-start gap-3">
          <Avatar contact={call.contacts ?? null} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold leading-tight">
              {maskName(name)}
            </div>
            {call.contacts?.wa_id ? (
              <div className="font-mono text-xs text-muted-foreground">
                {maskPhone(formatPhone(call.contacts.wa_id))}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
                  meta.tone,
                )}
              >
                <Icon className="h-3 w-3" />
                {meta.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-foreground/80">
                {call.direction === "inbound" ? (
                  <ArrowDownLeft className="h-3 w-3 text-emerald-600" />
                ) : (
                  <ArrowUpRight className="h-3 w-3 text-blue-600" />
                )}
                {call.direction === "inbound" ? "Incoming" : "Outgoing"}
              </span>
            </div>
          </div>
        </div>

        {/* Big-number tiles: ring / talk / answered-by */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <BigTile
            icon={Timer}
            label="Rang for"
            value={call.ring_seconds != null ? fmtDuration(call.ring_seconds) : "—"}
            tone="text-amber-700"
          />
          <BigTile
            icon={Clock}
            label="Talk time"
            value={
              wasAnswered && call.duration_seconds != null
                ? fmtDuration(call.duration_seconds)
                : "—"
            }
            tone="text-emerald-700"
            primary
          />
          <BigTile
            icon={User}
            label="Handled by"
            value={call.handled_by_email ? agentLabel(call.handled_by_email) : "—"}
            tone="text-foreground"
            small
          />
        </div>
      </div>

      {/* Timeline */}
      <div className="border-b bg-card px-5 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timeline
        </div>
        <ol className="mt-2 space-y-1.5">
          <TimelineRow
            label="Started ringing"
            when={call.start_at}
            tone="text-amber-700"
          />
          {call.accepted_at ? (
            <TimelineRow
              label="Answered"
              when={call.accepted_at}
              tone="text-emerald-700"
            />
          ) : null}
          {call.end_at ? (
            <TimelineRow
              label={
                call.status === "rejected"
                  ? "Declined"
                  : call.status === "missed"
                    ? "Missed"
                    : "Ended"
              }
              when={call.end_at}
              tone="text-rose-700"
            />
          ) : null}
        </ol>
      </div>

      {/* Recording + Transcript */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <section>
          <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <FileAudio className="h-3 w-3" />
            Recording
          </div>
          {call.recording_url ? (
            <div className="rounded-xl border bg-gradient-to-br from-card to-secondary/30 p-3 shadow-sm">
              <DurationFixedAudio
                src={call.recording_url}
                fallbackSeconds={call.duration_seconds ?? null}
              />
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="font-mono">
                  {call.recording_mime ?? "audio/webm"}
                </span>
                <a
                  href={call.recording_url}
                  download
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 font-medium hover:bg-secondary"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed bg-secondary/40 p-4 text-center text-xs text-muted-foreground">
              {call.status === "missed" || call.status === "rejected"
                ? "Call was never answered — nothing to record."
                : "No recording yet. It may still be uploading from the operator's browser."}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              Transcript
            </span>
            <div className="flex items-center gap-1.5">
              {call.transcript ? (
                <button
                  type="button"
                  onClick={copyTranscript}
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-secondary"
                >
                  <Copy className="h-3 w-3" />
                  {copyOk ? "Copied" : "Copy"}
                </button>
              ) : null}
              {call.recording_url && !call.transcript ? (
                <button
                  type="button"
                  onClick={transcribe}
                  disabled={transcribing}
                  className="inline-flex items-center gap-1 rounded-md bg-gradient-to-br from-violet-500 to-violet-600 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-sm transition hover:from-violet-600 hover:to-violet-700 disabled:opacity-50"
                >
                  {transcribing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {transcribing ? "Transcribing…" : "Transcribe"}
                </button>
              ) : null}
            </div>
          </div>
          {call.transcript ? (
            <div className="rounded-xl border bg-card p-3 text-sm leading-relaxed text-foreground/90 shadow-sm">
              {call.transcript}
            </div>
          ) : transcribeErr ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              {transcribeErr}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed bg-secondary/40 p-4 text-center text-xs text-muted-foreground">
              {call.recording_url
                ? "Click Transcribe to run Whisper on this recording."
                : "A transcript needs a recording first."}
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <Meta label="Call ID" value={call.wa_call_id} mono />
          <Meta
            label={call.direction === "inbound" ? "Received on" : "Called from"}
            value={(() => {
              const id = call.business_phone_number_id;
              if (!id) return "—";
              const bn = numbers.get(id);
              if (!bn) return id;
              const name = bn.verified_name?.trim() || "";
              const phone = bn.display_phone_number?.trim() || "";
              if (name && phone) return `${name} · ${phone}`;
              return name || phone || id;
            })()}
          />
        </section>
      </div>
    </div>
  );
}

// MediaRecorder-produced webm/opus blobs come back with duration set
// to "live" (Infinity). The audio element shows 0:00 forever unless
// we force it to scrub to the end and back — that pass populates the
// real duration as a side effect. Falls back to the server-computed
// duration in the timeline label, so the operator always sees the
// right number even if the trick is blocked.
function DurationFixedAudio({
  src,
  fallbackSeconds,
}: {
  src: string;
  fallbackSeconds: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [fixed, setFixed] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || fixed) return;
    let triggered = false;

    const onLoaded = () => {
      if (triggered) return;
      // Live duration: yank to end so the browser scrubs through and
      // surfaces the real value.
      if (!Number.isFinite(el.duration) || el.duration === 0) {
        triggered = true;
        try {
          el.currentTime = 1e101;
        } catch {
          /* some browsers throw on absurd seek — ignore */
        }
      } else {
        setFixed(true);
      }
    };
    const onTimeUpdate = () => {
      if (!triggered) return;
      el.currentTime = 0;
      setFixed(true);
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("durationchange", onLoaded);
    el.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("durationchange", onLoaded);
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [src, fixed]);

  return (
    <div className="space-y-1">
      <audio
        ref={audioRef}
        key={src}
        src={src}
        controls
        preload="auto"
        className="w-full"
      />
      {fallbackSeconds != null && fallbackSeconds > 0 ? (
        <div className="text-right text-[10px] tabular-nums text-muted-foreground">
          length {fmtDuration(fallbackSeconds)} (server-measured)
        </div>
      ) : null}
    </div>
  );
}

function Avatar({
  contact,
  size = "md",
}: {
  contact: CallContact | null;
  size?: "md" | "lg";
}) {
  const cls = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-xs";
  const name =
    contact?.name?.trim() ||
    contact?.profile_name?.trim() ||
    (contact?.wa_id ? `+${contact.wa_id}` : "?");
  const initials =
    name
      .replace(/^\+/, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "?";
  if (contact?.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={contact.avatar_url}
        alt=""
        className={cn(
          "shrink-0 rounded-full object-cover ring-1 ring-border",
          cls,
        )}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-100 to-emerald-200 font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200",
        cls,
      )}
    >
      {initials}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  mono,
}: {
  icon: typeof PhoneCall;
  label: string;
  value: string;
  tone: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm">
      <span
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow",
          tone,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            "text-base font-semibold leading-tight",
            mono && "tabular-nums",
          )}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function BigTile({
  icon: Icon,
  label,
  value,
  tone,
  primary,
  small,
}: {
  icon: typeof PhoneCall;
  label: string;
  value: string;
  tone?: string;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2 shadow-sm",
        primary && "ring-2 ring-emerald-200",
      )}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-semibold tabular-nums",
          small ? "truncate text-xs" : "text-base",
          tone,
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function TimelineRow({
  label,
  when,
  tone,
}: {
  label: string;
  when: string;
  tone: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 text-xs">
      <span className={cn("inline-flex items-center gap-2", tone)}>
        <span
          className={cn("inline-block h-1.5 w-1.5 rounded-full", {
            "bg-amber-500": tone.includes("amber"),
            "bg-emerald-500": tone.includes("emerald"),
            "bg-rose-500": tone.includes("rose"),
          })}
        />
        <span className="font-medium">{label}</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {new Date(when).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </span>
    </li>
  );
}

function FilterChips({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; label: string }[];
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border bg-background">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "h-8 px-2.5 text-[11px] font-medium transition",
            value === o.v
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border bg-secondary/30 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("truncate text-[11px]", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-sm rounded-2xl border-2 border-dashed bg-card/50 px-8 py-12 text-center">
        <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
          <PhoneCall className="h-6 w-6" />
        </div>
        <div className="text-sm font-semibold">No calls yet</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Once a customer dials your business number on WhatsApp — or you call them — every leg shows up here with the recording, transcript and the agent who answered.
        </p>
      </div>
    </div>
  );
}

// ---------- helpers ----------

function fmtDuration(totalSec: number): string {
  if (!totalSec || totalSec < 0) return "0:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function agentLabel(email: string): string {
  return email.includes("@") ? email.split("@")[0] : email;
}

function groupByDay(calls: CallRow[]): {
  key: string;
  label: string;
  calls: CallRow[];
}[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups = new Map<string, { label: string; calls: CallRow[] }>();
  for (const c of calls) {
    const d = new Date(c.start_at);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groups.has(k)) {
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      let label: string;
      if (dayStart.getTime() === today.getTime()) label = "Today";
      else if (dayStart.getTime() === yesterday.getTime()) label = "Yesterday";
      else
        label = d.toLocaleDateString([], {
          weekday: "short",
          day: "2-digit",
          month: "short",
        });
      groups.set(k, { label, calls: [] });
    }
    groups.get(k)!.calls.push(c);
  }
  return Array.from(groups.entries()).map(([key, v]) => ({
    key,
    label: v.label,
    calls: v.calls,
  }));
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  const t = useRef<number | null>(null);
  useEffect(() => {
    if (t.current) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setDebounced(value), delay);
    return () => {
      if (t.current) window.clearTimeout(t.current);
    };
  }, [value, delay]);
  return debounced;
}
