"use client";

// LSQ activity rendered inline in the chat thread, between WhatsApp
// messages and internal notes. Mirrors the LSQ Activity History card
// — header with icon + name + timestamp, primary preview, and a
// collapsible Field/Value table showing every Data key/value LSQ
// returned for this activity (so the agent never has to switch
// to LSQ to see the full record).

import { useState } from "react";
import {
  Activity,
  Bot,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  Edit3,
  Mail,
  MessageSquare,
  Phone,
  StickyNote,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface LsqActivity {
  id: string;
  event_code: number;
  event_name: string;
  note: string | null;
  created_on: string | null;
  created_by: string | null;
  data: Array<{ key: string; value: string }>;
}

export function LsqActivityBubble({ activity }: { activity: LsqActivity }) {
  const [expanded, setExpanded] = useState(false);
  const { Icon, tone } = iconForEvent(activity.event_name);
  const hasDetails = activity.data.length > 0;

  // Expandable when there's either a note or detail rows. Collapsed
  // view is intentionally minimal — title + time only — so the chat
  // thread isn't cluttered with one-line summaries that often just
  // repeat metadata. Click the row to reveal the note + full
  // Field/Value table.
  const canExpand = hasDetails || !!activity.note;

  return (
    <div className="my-1 flex justify-center">
      <div className="w-full max-w-[88%] overflow-hidden rounded-xl border border-violet-200 bg-violet-50/60 shadow-sm">
        {/* Header row — collapsed view is just the LSQ title + timestamp */}
        <button
          type="button"
          onClick={() => canExpand && setExpanded((e) => !e)}
          disabled={!canExpand}
          className={cn(
            "flex w-full items-center gap-2 px-4 py-2.5 text-left",
            canExpand ? "cursor-pointer hover:bg-violet-100/40" : "cursor-default",
          )}
          aria-expanded={expanded}
        >
          <Icon className={cn("h-4 w-4 shrink-0", tone)} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold uppercase tracking-wide text-violet-700">
            LSQ · {activity.event_name}
          </span>
          {activity.created_on ? (
            <time className="shrink-0 text-[10px] tabular-nums text-violet-700/70">
              {formatTime(activity.created_on)}
            </time>
          ) : null}
          {canExpand ? (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-violet-700/60 transition-transform",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </button>

        {expanded && canExpand ? (
          <div className="border-t border-violet-200/70 bg-white/50">
            {activity.note ? (
              <p className="break-words border-b border-violet-200/50 px-4 py-2 text-[13px] leading-snug text-foreground/90">
                {activity.note}
              </p>
            ) : null}
            {hasDetails ? (
              <table className="w-full text-[12px]">
                <tbody>
                  {activity.data.map((row, idx) => (
                    <DetailRow
                      key={`${row.key}-${idx}`}
                      fieldKey={row.key}
                      value={row.value}
                    />
                  ))}
                </tbody>
              </table>
            ) : null}
            {activity.created_by ? (
              <div className="border-t border-violet-200/50 px-4 py-1.5 text-[10px] text-violet-700/70">
                Added by {activity.created_by}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Renders one Field/Value row. Pretty-prints JSON-shaped values
// (LSQ packs OldData / NewData status snapshots as JSON strings) and
// formats timestamps into the operator's locale. Falls back to raw
// text for everything else.
function DetailRow({ fieldKey, value }: { fieldKey: string; value: string }) {
  const formatted = formatValue(fieldKey, value);
  return (
    <tr className="border-b border-violet-100/70 last:border-b-0">
      <td className="w-1/3 px-3 py-1.5 align-top text-[11px] font-medium text-violet-700/80">
        {humanizeKey(fieldKey)}
      </td>
      <td className="px-3 py-1.5 align-top text-[12px] text-foreground/90">
        {formatted}
      </td>
    </tr>
  );
}

function formatValue(key: string, value: string): React.ReactNode {
  const trimmed = value.trim();

  // Audio recording URLs — call activities ship the recording link in
  // a "Resource Url" / "Recording Url" / etc. field. Render an inline
  // HTML5 audio player so the agent can listen without leaving the
  // chat. Detection is two-pronged:
  //   1. Field name hints ("Resource Url", "Recording", "Audio")
  //   2. Filename extension (.mp3 / .wav / .m4a / .ogg / .aac)
  // both have to look "URL-like" for safety.
  const looksLikeUrl = /^https?:\/\//i.test(trimmed);
  const looksAudio =
    looksLikeUrl &&
    (/\.(mp3|wav|m4a|ogg|aac)(\?|$)/i.test(trimmed) ||
      /resource\s*url|recording|audio|call\s*recording/i.test(key));
  if (looksAudio) {
    return (
      <div className="space-y-1">
        <audio
          controls
          preload="none"
          src={trimmed}
          className="h-8 w-full max-w-md"
        />
        <a
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block break-all font-mono text-[10px] text-violet-700 hover:underline"
        >
          {trimmed}
        </a>
      </div>
    );
  }

  // Plain (non-audio) URLs — make them clickable.
  if (looksLikeUrl) {
    return (
      <a
        href={trimmed}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-mono text-[11px] text-violet-700 hover:underline"
      >
        {trimmed}
      </a>
    );
  }

  // Date/time-shaped strings — render localized for readability.
  // LSQ ships these as TZ-naive UTC ("yyyy-MM-dd HH:mm:ss"), so we
  // append Z before parsing to keep `toLocaleString` honest.
  if (/(date|time|on)$/i.test(key)) {
    const isoLike = value.replace(" ", "T");
    const withZ = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(isoLike) ? isoLike : `${isoLike}Z`;
    const d = new Date(withZ);
    if (!Number.isNaN(d.getTime())) {
      return (
        <span className="font-mono text-[11px] tabular-nums">
          {d.toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      );
    }
  }

  // JSON-shaped values (OldData / NewData / structured snapshots).
  // Pretty-print into a small key:value table for readability.
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-violet-50/80 px-2 py-1 font-mono text-[10px] text-foreground/80">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        );
      }
    } catch {
      // not actually JSON — fall through to raw render
    }
  }

  return <span className="break-words">{value}</span>;
}

// Cosmetic — convert "StatusDate" / "Display_Number" / "RawCallStatus"
// into "Status Date", "Display Number", "Raw Call Status".
function humanizeKey(k: string): string {
  return k
    .replace(/[_\s]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function iconForEvent(name: string): { Icon: typeof Activity; tone: string } {
  const n = name.toLowerCase();
  if (n.includes("whatsapp")) return { Icon: MessageSquare, tone: "text-emerald-600" };
  if (n.includes("call") || n.includes("phone")) return { Icon: Phone, tone: "text-blue-600" };
  if (n.includes("email")) return { Icon: Mail, tone: "text-violet-600" };
  if (n.includes("note")) return { Icon: StickyNote, tone: "text-amber-600" };
  if (n.includes("task")) return { Icon: CheckSquare, tone: "text-rose-600" };
  if (n.includes("modif") || n.includes("update")) return { Icon: Edit3, tone: "text-slate-600" };
  if (n.includes("workflow") || n.includes("automation")) return { Icon: Workflow, tone: "text-indigo-600" };
  if (n.includes("bot") || n.includes("system")) return { Icon: Bot, tone: "text-fuchsia-600" };
  return { Icon: ClipboardList, tone: "text-violet-600" };
}

function formatTime(iso: string): string {
  // Server normalises LSQ's TZ-naive `created_on` to ISO UTC. The
  // legacy `replace(" ", "T")` stays as a defensive fallback for any
  // raw LSQ string that slips past (e.g. detail-row date fields).
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
