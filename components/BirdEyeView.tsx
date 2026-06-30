"use client";

// Bird's-eye view — a live wall of phone-sized chat panels with the full inbox
// composer in each. Order stays STABLE across polls (so a chat you're working
// on doesn't jump), pinned chats sit first, and inbox-style filters scope the
// wall. Click a panel header to open the full chat.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Grid3x3, RefreshCcw, ExternalLink, Pin, PinOff, X, Search } from "lucide-react";
import { BirdEyeComposer } from "@/components/BirdEyeComposer";
import { LeadNumberBadge } from "@/components/LeadNumberBadge";
import { cn } from "@/lib/utils";

interface Msg {
  id: string;
  direction: "inbound" | "outbound";
  content: string | null;
  type: string | null;
  media_url: string | null;
  timestamp: string;
}
interface Chat {
  id: string;
  name: string;
  wa_id: string | null;
  avatar_url: string | null;
  last_message_at: string | null;
  unread_count: number;
  window_open: boolean;
  lsq_lead_number: string | null;
  assigned_to_email: string | null;
  business_phone_number_id: string | null;
  messages: Msg[];
}

const POLL_MS = 6000;
const PIN_KEY = "birdeye_pinned";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "closed", label: "Closed" },
  { key: "unread", label: "Unread" },
  { key: "unreplied", label: "Unreplied" },
  { key: "unassigned", label: "Unassigned" },
  { key: "mine", label: "Mine" },
  { key: "groups", label: "Groups" },
];

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });
}

function MessageBubble({ m, onImage }: { m: Msg; onImage: (url: string) => void }) {
  const k = (m.type ?? "").toLowerCase();
  const isImg = (k === "image" || k === "sticker") && m.media_url;
  const isVideo = k === "video" && m.media_url;
  const text = (m.content ?? "").trim();
  const label =
    text ||
    (k === "audio" ? "🎤 Voice" : k === "document" ? "📄 Document" : k === "interactive" || k === "button" ? "🔘 Buttons" : k && !isImg && !isVideo ? `[${k}]` : "");
  return (
    <div className={"flex " + (m.direction === "outbound" ? "justify-end" : "justify-start")}>
      <span
        className={
          "max-w-[85%] overflow-hidden rounded-lg text-[11px] leading-snug shadow-sm " +
          (m.direction === "outbound" ? "bg-[#d9fdd3] text-slate-800" : "bg-white text-slate-800")
        }
      >
        {isImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.media_url!} alt="" onClick={() => onImage(m.media_url!)} className="max-h-32 w-full cursor-zoom-in object-cover" />
        ) : isVideo ? (
          <video src={m.media_url!} onClick={() => onImage(m.media_url!)} className="max-h-32 w-full cursor-zoom-in object-cover" muted />
        ) : null}
        {label ? (
          <span className="block whitespace-pre-wrap break-words px-2 py-1">
            {label}
            <span className="ml-1 align-bottom text-[8px] text-slate-400">{hhmm(m.timestamp)}</span>
          </span>
        ) : (
          <span className="block px-1.5 pb-0.5 text-right text-[8px] text-slate-400">{hhmm(m.timestamp)}</span>
        )}
      </span>
    </div>
  );
}

function ChatPanel({ chat, pinned, onPin, onSent, onImage }: { chat: Chat; pinned: boolean; onPin: () => void; onSent: () => void; onImage: (url: string) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastId = chat.messages[chat.messages.length - 1]?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const initial = (chat.name || "?").trim().charAt(0).toUpperCase();
  return (
    // overflow-visible so the composer's template / quick-reply / emoji popovers
    // aren't clipped by the panel.
    <div className="flex h-full flex-col rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 rounded-t-2xl border-b bg-[#075e54] px-2.5 py-2 text-white">
        <Link href={`/dashboard?c=${chat.id}`} className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-90">
          <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-white/20 text-[11px] font-bold">
            {chat.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={chat.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              initial
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{chat.name}</span>
            <span className="block truncate text-[10px] text-white/70">
              {chat.wa_id ?? ""}
              {chat.assigned_to_email ? ` · ${chat.assigned_to_email.split("@")[0]}` : ""}
            </span>
          </span>
        </Link>
        <LeadNumberBadge leadNumber={chat.lsq_lead_number} className="shrink-0 bg-white/15 text-white" />
        {chat.unread_count > 0 ? (
          <span className="shrink-0 rounded-full bg-emerald-400 px-1.5 text-[9px] font-bold text-emerald-950">{chat.unread_count}</span>
        ) : null}
        <button type="button" onClick={onPin} title={pinned ? "Unpin" : "Pin"} className="shrink-0 rounded p-1 text-white/80 hover:bg-white/15">
          {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        <Link href={`/dashboard?c=${chat.id}`} className="shrink-0 rounded p-1 text-white/70 hover:bg-white/15">
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto bg-[#e6ddd4] px-2 py-2">
        {chat.messages.length === 0 ? (
          <div className="grid h-full place-items-center text-[10px] text-muted-foreground">No messages</div>
        ) : (
          chat.messages.map((m) => <MessageBubble key={m.id} m={m} onImage={onImage} />)
        )}
      </div>

      <div className="shrink-0 rounded-b-2xl border-t bg-card">
        <BirdEyeComposer
          contact={{ id: chat.id, wa_id: chat.wa_id, business_phone_number_id: chat.business_phone_number_id, window_open: chat.window_open }}
          onSent={onSent}
        />
      </div>
    </div>
  );
}

export function BirdEyeView() {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [count, setCount] = useState(12);
  const [cols, setCols] = useState(6); // columns per row (user-controlled grid)
  // Each row fills the visible wall height, so one row = one screenful and you
  // scroll for the next batch (instead of fixed-height panels peeking below).
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(620);
  useEffect(() => {
    const measure = () => {
      const h = gridScrollRef.current?.clientHeight;
      if (h) setRowH(Math.max(480, h - 24)); // minus p-3 padding
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const [filters, setFilters] = useState<string[]>([]); // empty = All
  const [sort, setSort] = useState<"new" | "old">("new");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const [paused, setPaused] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const orderRef = useRef<string[]>([]);

  // Load pinned ids once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PIN_KEY);
      if (raw) setPinned(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  // Merge fetched chats into the CURRENT display order so polling never
  // reshuffles a chat you're working on. Pinned chats float to the front.
  const merge = useCallback(
    (fetched: Chat[]): Chat[] => {
      const byId = new Map(fetched.map((c) => [c.id, c]));
      const kept = orderRef.current.filter((id) => byId.has(id));
      const keptSet = new Set(kept);
      const fresh = fetched.map((c) => c.id).filter((id) => !keptSet.has(id));
      let order = [...kept, ...fresh];
      order = [...order.filter((id) => pinnedSet.has(id)), ...order.filter((id) => !pinnedSet.has(id))];
      orderRef.current = order;
      return order.map((id) => byId.get(id)!).filter(Boolean);
    },
    [pinnedSet],
  );

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ n: String(count), sort });
      if (filters.length) params.set("filters", filters.join(","));
      if (qDebounced) params.set("q", qDebounced);
      const res = await fetch(`/api/bird-eye?${params.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as { chats?: Chat[] };
      setChats(merge(j.chats ?? []));
    } catch {
      /* keep last */
    }
  }, [count, filters, qDebounced, sort, merge]);

  // Reset display order when the filter/sort/search/count changes (fresh set).
  useEffect(() => {
    orderRef.current = [];
  }, [filters, sort, qDebounced, count]);

  useEffect(() => {
    load();
    if (paused) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, paused]);

  function togglePin(id: string) {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      // Re-float pinned to the front immediately.
      const set = new Set(next);
      orderRef.current = [...orderRef.current.filter((x) => set.has(x)), ...orderRef.current.filter((x) => !set.has(x))];
      setChats((cur) => {
        if (!cur) return cur;
        const byId = new Map(cur.map((c) => [c.id, c]));
        return orderRef.current.map((x) => byId.get(x)!).filter(Boolean);
      });
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* Compact header + filter strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-emerald-600" />
            <span className="text-sm font-semibold">Bird&apos;s Eye</span>
          </span>
          {/* Search by phone / lead number */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search number / lead #"
              className="h-7 w-44 rounded-full border bg-background pl-7 pr-2 text-xs outline-none focus:border-emerald-400"
            />
          </div>
          {/* Filters — multi-select (click to toggle); All clears. */}
          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((f) => {
              const active = f.key === "all" ? filters.length === 0 : filters.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() =>
                    f.key === "all"
                      ? setFilters([])
                      : setFilters((prev) => (prev.includes(f.key) ? prev.filter((x) => x !== f.key) : [...prev, f.key]))
                  }
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                    active ? "bg-emerald-600 text-white" : "border bg-background text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          {/* Sort — toggle oldest-first (default is newest-first) */}
          <button
            type="button"
            onClick={() => setSort((s) => (s === "old" ? "new" : "old"))}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
              sort === "old" ? "bg-amber-500 text-white" : "border bg-background text-muted-foreground hover:bg-secondary",
            )}
          >
            Old → New
          </button>
        </div>
        <div className="flex items-center gap-2">
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="rounded-md border bg-background px-2 py-1 text-xs outline-none">
            {[6, 12, 18, 24].map((n) => (
              <option key={n} value={n}>{n} chats</option>
            ))}
          </select>
          <select value={cols} onChange={(e) => setCols(Number(e.target.value))} className="rounded-md border bg-background px-2 py-1 text-xs outline-none" title="Screens per row">
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>{n} grid</option>
            ))}
          </select>
          <button type="button" onClick={() => setPaused((p) => !p)} className="rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-secondary">
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={load} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-auto p-3">
        {chats === null ? (
          <div className="grid h-40 place-items-center text-sm text-muted-foreground">Loading chats…</div>
        ) : chats.length === 0 ? (
          <div className="grid h-40 place-items-center text-sm text-muted-foreground">Is filter me koi chat nahi.</div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${rowH}px` }}>
            {chats.map((c) => (
              <ChatPanel key={c.id} chat={c} pinned={pinnedSet.has(c.id)} onPin={() => togglePin(c.id)} onSent={load} onImage={setLightbox} />
            ))}
          </div>
        )}
      </div>

      {/* Image / video lightbox */}
      {lightbox ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6" onClick={() => setLightbox(null)}>
          <button type="button" className="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white hover:bg-white/25" onClick={() => setLightbox(null)}>
            <X className="h-5 w-5" />
          </button>
          {/\.(mp4|webm|mov)(\?|$)/i.test(lightbox) ? (
            <video src={lightbox} controls autoPlay className="max-h-[90vh] max-w-[90vw] rounded-lg" onClick={(e) => e.stopPropagation()} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lightbox} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      ) : null}
    </div>
  );
}
