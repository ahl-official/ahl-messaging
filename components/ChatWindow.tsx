"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Archive, CheckCheck, ChevronLeft, ClipboardCheck, Clock, Eye, EyeOff, Loader2, MessageCircle, PanelRight, RotateCcw, ShieldAlert, ShieldCheck, Tag, WandSparkles } from "lucide-react";
import { BookingDialog } from "@/components/BookingDialog";
import { isAtLeast } from "@/lib/team-types";
import { CreateTaskModal } from "@/components/CreateTaskModal";
import { emitTasksChanged } from "@/lib/use-my-tasks";
import { LabelChips, LabelPicker } from "@/components/LabelChips";
import { createBrowserClient } from "@/lib/supabase/client";
import { INBOX_TOPIC, INBOX_EVENT, type InboxBroadcast } from "@/lib/realtime-inbox";
import { cn, imageFromClipboard } from "@/lib/utils";
import { compressImageFile } from "@/lib/image-compress";
import { emitContactStatusChanged } from "@/lib/contact-status-events";
import { formatPhone } from "@/lib/phone";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageBubble } from "@/components/MessageBubble";
import { MessageInput } from "@/components/MessageInput";
import type { QuickReply } from "@/components/QuickRepliesManager";
import { AutomationStatusPill } from "@/components/AutomationStatusPill";
import { LsqActivityBubble } from "@/components/LsqActivityBubble";
import { CallBubble, type ChatCall } from "@/components/CallBubble";
import { useLsqActivities, type LsqActivity } from "@/components/contact-panel/useLsqActivities";
import { useLsqActivitiesInChat } from "@/components/contact-panel/useLsqActivitiesInChat";
import { ChatToolbar } from "@/components/ChatToolbar";
import { LeadNumberBadge } from "@/components/LeadNumberBadge";
import type { ComposerMode } from "@/components/ComposerTabs";
import { NoteBubble } from "@/components/NoteBubble";
import {
  addContactNoteAction,
  deleteContactNoteAction,
  setContactStatusAction,
} from "@/app/(dashboard)/actions";
import type { ContactNote } from "@/lib/types";
import type { TemplateSummary } from "@/components/TemplatePicker";
import { TemplateSendDialog } from "@/components/TemplateSendDialog";
import { MagicMessageDialog } from "@/components/MagicMessageDialog";
import { MagicMessageTextDialog } from "@/components/MagicMessageTextDialog";
import { MagicMessageImageDialog } from "@/components/MagicMessageImageDialog";
import {
  businessNumberLabel,
  contactDisplayNameMasked,
  contactInitials,
  type BusinessNumber,
  type Contact,
  type Message,
} from "@/lib/types";
import { usePermissions, usePhoneMasker } from "@/components/PermissionsContext";
import { useMembers } from "@/components/MembersContext";
import { DEMO_MODE, demoStore } from "@/lib/demo";
import { loadCachedMessages, saveCachedMessages } from "@/lib/message-cache";
import { playMessagePing } from "@/lib/notification";
import { formatTimeLeft, getWindowState, WHATSAPP_WINDOW_HOURS } from "@/lib/whatsapp-window";

interface Props {
  contact: Contact | null;
  businessNumber?: BusinessNumber | null;
  currentUserId?: string | null;
  /** Mobile only — return to the conversation list. */
  onBack?: () => void;
  /** Tablet/mobile only — open the contact-details panel as a drawer. */
  onOpenPanel?: () => void;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  // A null/undefined/malformed date must never crash the timeline render
  // (toLocaleDateString throws "Invalid Date" in WebKit, toISOString in V8).
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

type TimelineItem =
  | { kind: "message"; at: string; message: Message }
  | { kind: "note"; at: string; note: ContactNote }
  | { kind: "lsq"; at: string; activity: LsqActivity }
  | { kind: "call"; at: string; call: ChatCall };

type LiveStatus = "idle" | "connecting" | "live" | "error" | "closed";

function LiveStatusPill({ status }: { status: LiveStatus }) {
  if (status === "idle") return null;
  const styles: Record<LiveStatus, { label: string; cls: string; pulse: boolean }> = {
    idle:       { label: "",                cls: "",                                                   pulse: false },
    connecting: { label: "Connecting…",     cls: "bg-amber-50 text-amber-800 ring-amber-200",          pulse: true },
    live:       { label: "Live",            cls: "bg-primary/10 text-primary ring-primary/25",    pulse: true },
    error:      { label: "Reconnecting…",   cls: "bg-rose-50 text-rose-800 ring-rose-200",             pulse: true },
    closed:     { label: "Offline",         cls: "bg-slate-100 text-slate-700 ring-slate-200",         pulse: false },
  };
  const s = styles[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${s.cls}`}
      title={`Realtime channel status: ${status}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {s.pulse ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {s.label}
    </span>
  );
}

export function ChatWindow({
  contact,
  businessNumber,
  currentUserId = null,
  onBack,
  onOpenPanel,
}: Props) {
  const perms = usePermissions();
  const maskPhone = usePhoneMasker();
  // Resolve the operator's email up-front so optimistic message rows
  // can stamp sent_by_user_id + sent_by_email immediately. Without
  // this the bubble's sender resolver falls back to the generic "WA"
  // badge until the server row arrives a few hundred ms later — the
  // visible flicker the operator complained about.
  const { byUserId } = useMembers();
  const currentUserEmail = currentUserId
    ? (byUserId.get(currentUserId)?.email ?? null)
    : null;
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  // WhatsApp calls for this contact — rendered inline in the timeline.
  const [calls, setCalls] = useState<ChatCall[]>([]);
  // Quoted-reply state — when set, the composer shows a preview banner
  // and the next send carries Meta `context.message_id` so the
  // customer's phone renders it as a swipe-reply thread.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // CRM activity timeline merged inline. Read prospect_id from the
  // contact row (cached locally by /api/lsq/lead) so we don't need to
  // round-trip through the LSQ lookup before activities can render.
  // Operator's "show LSQ activities in chat" toggle (lives in this
  // chat header). When OFF, we pass `null` to `useLsqActivities` so the
  // hook short-circuits to empty + skips polling entirely — no API
  // calls, no LSQ load. Flipping ON re-arms the prospect_id and the
  // hook fires its first fetch immediately.
  const lsq = useLsqActivitiesInChat();
  const lsqHookProspectId =
    DEMO_MODE || !lsq.enabled ? null : contact?.lsq_prospect_id ?? null;
  const { activities: lsqActivitiesRaw, phase: lsqPhase } = useLsqActivities(
    lsqHookProspectId,
  );
  const lsqInChat = lsq.enabled;
  // Belt-and-braces: hard-clamp the activities array to [] whenever
  // the toggle is OFF, regardless of what the hook's internal state
  // reads. This makes the OFF state deterministic — a stale fetch
  // resolving after the toggle flips can't sneak bubbles back into
  // the chat thread.
  const lsqActivities = lsq.enabled ? lsqActivitiesRaw : [];
  // Show a spinner inside the chat thread while activities are being
  // fetched after the toggle is flipped ON. Without this, clicking ON
  // gave no visible feedback for ~1-2s (until LSQ responded), and
  // operators ended up double-clicking thinking the button "didn't
  // work".
  const lsqLoading = lsq.enabled && lsqPhase === "loading";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode>("reply");
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stable wrapper around message content — observed by ResizeObserver below
  // so a single subscription survives loading→loaded swaps and catches height
  // changes from lazy-loaded images anywhere in the timeline (not just the
  // first day group).
  const contentRef = useRef<HTMLDivElement>(null);
  // Stable contact id used across effects so they only re-fire on actual
  // contact switches (not on tag/name updates).
  const contactId = contact?.id ?? null;

  // Reset and reload messages + notes whenever contact changes
  useEffect(() => {
    if (!contact) {
      setMessages([]);
      setNotes([]);
      setCalls([]);
      return;
    }

    if (DEMO_MODE) {
      setLoading(false);
      setError(null);
      setNotes([]);
      setLiveStatus("live");
      demoStore.clearUnread(contact.id);
      setMessages(demoStore.getMessages(contact.id));
      return demoStore.subscribe(() => setMessages(demoStore.getMessages(contact.id)));
    }

    let cancelled = false;
    const supabase = createBrowserClient();
    // Stale-while-revalidate: paint cached messages instantly (no spinner)
    // on reopen / refresh, then let the live fetch below overwrite them.
    const cached = loadCachedMessages(contact.id);
    if (cached && cached.length) {
      setMessages(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    setLiveStatus("connecting");

    (async () => {
      // Clear unread badge
      await supabase.from("contacts").update({ unread_count: 0 }).eq("id", contact.id);

      const [msgRes, noteRes, callRes] = await Promise.all([
        supabase
          .from("messages")
          .select("*")
          .eq("contact_id", contact.id)
          // Fetch the LATEST 500 (DESC + reverse below). Earlier the
          // query ordered ASC with LIMIT 500, which silently chopped
          // off recent sends on chats with >500 messages — the
          // operator would send a Magic Message, get a 200, but the
          // bubble never rendered because the row was past index 500.
          .order("timestamp", { ascending: false })
          .limit(500),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: true })
          .limit(200),
        supabase
          .from("whatsapp_calls")
          .select("id, direction, status, start_at, duration_seconds")
          .eq("contact_id", contact.id)
          .order("start_at", { ascending: true })
          .limit(200),
      ]);

      if (cancelled) return;
      if (msgRes.error) {
        setError(msgRes.error.message);
      } else {
        // Server returned DESC for the LIMIT-500 cap; reverse so the
        // timeline renders oldest → newest like the rest of the UI
        // expects.
        const rows = ((msgRes.data ?? []) as Message[]).slice().reverse();
        setMessages(rows);
        saveCachedMessages(contact.id, rows);
      }
      setNotes((noteRes.data ?? []) as ContactNote[]);
      setCalls((callRes.data ?? []) as ChatCall[]);
      setLoading(false);

      // Group with no local history yet — pull past messages from
      // Evolution once (the Groups sync only created the contact row).
      const msgRows = (msgRes.data ?? []) as Message[];
      if (contact.is_group && msgRows.length === 0) {
        try {
          const res = await fetch("/api/evolution/group-history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactId: contact.id }),
          });
          if (!cancelled && res.ok) {
            const r2 = await supabase
              .from("messages")
              .select("*")
              .eq("contact_id", contact.id)
              .order("timestamp", { ascending: false })
              .limit(500);
            if (!cancelled && r2.data) {
              setMessages((r2.data as Message[]).slice().reverse());
            }
          }
        } catch {
          /* silent — webhook will still catch live group messages */
        }
      }
    })();

    // Realtime: messages + notes
    const channel = supabase
      .channel(`chat-${contact.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const m = payload.new as Message;
          setMessages((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev;
            // Replace a matching outbound optimistic (tmp-) bubble instead of
            // appending — otherwise the optimistic row and this realtime row
            // briefly coexist as two bubbles (e.g. an image + a blank one)
            // until the send response reconciles them. Matched on
            // direction + type + content + a 60s window, same as the poller.
            if (m.direction === "outbound") {
              const idx = prev.findIndex(
                (p) =>
                  p.id.startsWith("tmp-") &&
                  p.direction === "outbound" &&
                  p.type === m.type &&
                  (p.content ?? "") === (m.content ?? "") &&
                  Math.abs(
                    new Date(p.timestamp).getTime() - new Date(m.timestamp).getTime(),
                  ) < 60_000,
              );
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = m;
                return next;
              }
            }
            return [...prev, m];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const m = payload.new as Message;
          setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "contact_notes",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const n = payload.new as ContactNote;
          setNotes((prev) => (prev.some((x) => x.id === n.id) ? prev : [...prev, n]));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "contact_notes",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const n = payload.old as ContactNote;
          setNotes((prev) => prev.filter((x) => x.id !== n.id));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "whatsapp_calls",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const c = payload.new as ChatCall;
          setCalls((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "whatsapp_calls",
          filter: `contact_id=eq.${contact.id}`,
        },
        (payload) => {
          const c = payload.new as ChatCall;
          setCalls((prev) =>
            prev.some((x) => x.id === c.id)
              ? prev.map((x) => (x.id === c.id ? { ...x, ...c } : x))
              : [...prev, c],
          );
        },
      )
      .subscribe((status) => {
        // Surface websocket state to the UI + console.
        // SUBSCRIBED → live; CHANNEL_ERROR / TIMED_OUT → error; CLOSED → closed.
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log(`[realtime chat-${contact.id}]`, status);
        }
        if (cancelled) return;
        if (status === "SUBSCRIBED") setLiveStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setLiveStatus("error");
        else if (status === "CLOSED") setLiveStatus("closed");
      });

    // Polling fallback — realtime broadcasts can be silently blocked by RLS /
    // Realtime Authorization even when the channel reports SUBSCRIBED.
    //
    // For each row Meta has in the DB we either:
    //   (a) update an existing message in state if status / error / media
    //       changed (this is what makes ✓✓ blue ticks appear when Meta sends
    //       a 'read' status update),
    //   (b) replace an optimistic bubble (tmp-…) by content + close
    //       timestamp so failed sends don't visually duplicate, or
    //   (c) append as a brand-new message (and chime, if inbound).
    async function pollMessages() {
      if (cancelled || !contact) return;
      const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("contact_id", contact.id)
        // Recurring fallback poll (every 4s + on each realtime broadcast) only
        // needs the recent tail: new inbound always lands here, and status
        // flips (delivered→read) only happen on recent outbound. 80 instead of
        // 500 cuts this poll's payload ~6× with no correctness loss — older
        // messages never change. The one-time initial load below still pulls
        // the deeper history.
        .order("timestamp", { ascending: false })
        .limit(80);
      if (cancelled || !data) return;
      const incoming = (data as Message[]).slice().reverse();
      setMessages((prev) => {
        const next = [...prev];
        const indexById = new Map(next.map((m, i) => [m.id, i]));
        let modified = false;
        let newInbound = false;

        for (const m of incoming) {
          const existingIdx = indexById.get(m.id);
          if (existingIdx !== undefined) {
            const existing = next[existingIdx];
            // Update only if a relevant field actually changed — keeps the
            // setMessages reference stable when nothing's new.
            if (
              existing.status !== m.status ||
              existing.error_message !== m.error_message ||
              existing.media_url !== m.media_url ||
              existing.wa_message_id !== m.wa_message_id
            ) {
              next[existingIdx] = { ...existing, ...m };
              modified = true;
            }
            continue;
          }

          // Match against an outbound optimistic bubble.
          const optimisticIdx = next.findIndex(
            (p) =>
              p.id.startsWith("tmp-") &&
              p.direction === "outbound" &&
              m.direction === "outbound" &&
              p.type === m.type &&
              (p.content ?? "") === (m.content ?? "") &&
              Math.abs(
                new Date(p.timestamp).getTime() - new Date(m.timestamp).getTime(),
              ) < 60_000,
          );
          if (optimisticIdx >= 0) {
            next[optimisticIdx] = m;
            indexById.set(m.id, optimisticIdx);
            modified = true;
            continue;
          }

          next.push(m);
          indexById.set(m.id, next.length - 1);
          modified = true;
          if (m.direction === "inbound") newInbound = true;
        }

        if (!modified) return prev;
        if (newInbound) playMessagePing();
        return next.slice().sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
      });
    }
    // Fallback poll. Realtime INSERT/UPDATE subs handle the instant case
    // (new messages + read-receipt status flips); this catches what
    // RLS-blocked realtime silently drops — which is exactly the "inbound
    // shows up late" symptom. 8s was a deliberate throttle back when ~100
    // operators were online (2.5s × 100 = ~40 selects/sec tanked Supabase).
    // At the current ~15 active operators 4s is well within budget and
    // halves worst-case inbound latency. `if (!modified) return prev` above
    // keeps an unchanged poll from re-rendering, so the only cost is the
    // (indexed, per-open-chat) select. Revisit upward if operator count
    // grows a lot, or move to broadcast-via-trigger to kill the poll.
    const pollInterval = setInterval(pollMessages, 4000);

    // Instant push for the OPEN thread: every provider's webhook broadcasts on
    // the `inbox` topic the moment a message lands (lib/realtime-inbox). When
    // it's for this contact, refetch right away instead of waiting up to 4s —
    // and independent of the RLS-gated postgres_changes channel above (this is
    // the "broadcast-via-trigger to kill the poll" path noted above).
    let msgDebounce: ReturnType<typeof setTimeout> | null = null;
    const inboxChannel = supabase
      .channel(INBOX_TOPIC)
      .on("broadcast", { event: INBOX_EVENT }, ({ payload }) => {
        if ((payload as InboxBroadcast)?.contact_id !== contact?.id) return;
        if (msgDebounce) clearTimeout(msgDebounce);
        msgDebounce = setTimeout(() => void pollMessages(), 150);
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      if (msgDebounce) clearTimeout(msgDebounce);
      supabase.removeChannel(channel);
      supabase.removeChannel(inboxChannel);
    };
    // ID-only dep — depending on the whole `contact` object meant
    // every realtime update from DashboardView (different reference,
    // even when only CRM stage / avatar changed) tore down this
    // effect, set loading=true, refetched messages, and rebuilt the
    // realtime channel. Visible result: the entire chat thread and
    // notes panel "blinked" empty then re-populated. Switching to
    // `contact?.id` means we only reload when the operator actually
    // opens a different chat.
  }, [contact?.id]);

  // Keep the message cache current as realtime appends, edits, and sends
  // mutate `messages` — so the next reopen / refresh paints the freshest
  // thread, not just the snapshot from the initial fetch. Debounced inside
  // the cache module; skipped while loading so we never persist a half-state.
  useEffect(() => {
    if (DEMO_MODE || !contact?.id || loading) return;
    saveCachedMessages(contact.id, messages);
  }, [contact?.id, messages, loading]);

  // Silently fetch the WhatsApp profile picture for Evolution contacts
  // that don't have one cached yet. Baileys gives us the picture URL
  // via /chat/fetchProfilePictureUrl; we cache it on contacts.avatar_url
  // so the next open already shows it. Skips Meta contacts (Cloud API
  // doesn't expose contact pics) and contacts that already have a pic.
  useEffect(() => {
    if (!contact?.id) return;
    if (contact.avatar_url) return;
    const bpid = contact.business_phone_number_id;
    if (!bpid || !bpid.startsWith("evo:")) return;
    void fetch(`/api/contacts/${contact.id}/refresh-avatar`, {
      method: "POST",
    }).catch(() => {});
  }, [contact?.id, contact?.avatar_url, contact?.business_phone_number_id]);

  // "Stick to bottom" tracker — true while the user is at (or very near) the
  // latest message. Stored in a ref so the ResizeObserver below can read the
  // current value without re-subscribing.
  const stickToBottomRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
  }, []);

  // Reset stickiness whenever the contact switches so a fresh open always
  // lands at the bottom regardless of where the previous chat was scrolled.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [contactId]);

  // Auto-scroll on new message / note (only while pinned to bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, notes]);

  // Snap helper — used by every code path that wants to land at the latest
  // message. Reading scrollHeight/scrollTop after assignment ensures we land
  // even if a sibling RAF flushes the DOM in between.
  const snapToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  // Force-pin entry point — used after the user sends/saves something. We
  // unconditionally re-arm the sticky flag and snap, because the user clearly
  // wants to see the message they just produced even if they happened to be
  // scrolled up beforehand.
  const forcePinToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    // Two RAFs: first lets React commit the optimistic bubble, second lets
    // layout settle before we measure scrollHeight.
    requestAnimationFrame(() => {
      requestAnimationFrame(snapToBottom);
    });
  }, [snapToBottom]);

  // Re-pin to bottom whenever content height changes — handles the case where
  // the chat opens while tall media (template header images, photos, video
  // posters) is still loading. Without this the initial scroll lands at what's
  // currently `scrollHeight`, then the image finishes loading and pushes the
  // bottom further down, stranding the view mid-chat.
  //
  // We use FOUR mechanisms together, because no single one is reliable:
  //   1. ResizeObserver on the message wrapper — fires when ANY descendant
  //      resizes (image load, etc.). Survives loading→loaded swaps.
  //   2. Image `load` events captured at the scroll container — belt &
  //      suspenders for the rare case where the RO fires before the
  //      scrollHeight has been recomputed for a freshly-loaded image.
  //   3. A short polling burst right after `contactId` change — catches the
  //      first few hundred ms where lazy images are still being kicked off
  //      and `stickToBottomRef` could otherwise get tripped to `false` by a
  //      browser scroll-anchor adjustment before the RO callback runs.
  //   4. The auto-scroll-on-messages effect above.
  useEffect(() => {
    const target = contentRef.current;
    const scrollEl = scrollRef.current;
    if (!target || !scrollEl) return;

    const repin = () => {
      if (!stickToBottomRef.current) return;
      snapToBottom();
    };

    const ro = new ResizeObserver(repin);
    ro.observe(target);

    // Capture-phase image load listener — `load` doesn't bubble, so capture is
    // the only way a single ancestor listener catches every nested <img>.
    const onLoadCapture = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "IMG" || t.tagName === "VIDEO")) repin();
    };
    scrollEl.addEventListener("load", onLoadCapture, true);

    // Polling burst: fire `repin` every 80ms for the first ~2.5s after open.
    // Stops early if the user scrolls up (stick flag flips off) — we never
    // fight the user's intent. After the burst the RO + load listeners take
    // over for any subsequent late-loading media.
    const burstStart = Date.now();
    const burst = setInterval(() => {
      if (Date.now() - burstStart > 2500) {
        clearInterval(burst);
        return;
      }
      if (!stickToBottomRef.current) {
        clearInterval(burst);
        return;
      }
      snapToBottom();
    }, 80);

    return () => {
      ro.disconnect();
      scrollEl.removeEventListener("load", onLoadCapture, true);
      clearInterval(burst);
    };
  }, [contactId, snapToBottom]);

  // 24-hour customer service window state. Re-computed every minute via the
  // `now` tick below so a window that expires during an open session updates
  // the banner + composer without a refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const windowState = useMemo(() => {
    // `now` is in the dep list so this recomputes on every minute tick.
    void now;
    // Evolution (Baileys) numbers don't have Meta's 24-hour customer-
    // service window — Baileys lets you message any chat at any time,
    // exactly like the WhatsApp app. Force the window-open state for
    // evo:* contacts so the "Window closed — use Magic Message" banner
    // + composer lock never fire on unofficial threads.
    const isEvolutionContact =
      typeof contact?.business_phone_number_id === "string" &&
      contact.business_phone_number_id.startsWith("evo:");
    if (isEvolutionContact) {
      return {
        isOpen: true,
        neverOpened: false,
        closingSoon: false,
        hoursRemaining: Infinity,
        lastInboundAt: null,
      };
    }
    return getWindowState(messages);
  }, [messages, now, contact?.business_phone_number_id]);

  // NOTE: previously had a reactive auto-close effect here that closed any
  // open chat whose 24h window had expired. That was hostile when an agent
  // manually clicked "Reopen" — the effect re-fired on the status change and
  // closed it again ("baar baar"). Auto-close is now ONLY done by:
  //   1. The bulk action that runs on dashboard mount (one-shot per session)
  //   2. The webhook auto-reopens whenever a fresh inbound lands
  // Agent's manual Reopen sticks until they manually close OR a new inbound.

  // Auto mark-as-read — fires once when chat opens AND every time a new
  // inbound message arrives while the chat is still open. Meta's read receipt
  // covers all messages up to & including the marked one, so we only re-mark
  // when the latest inbound's wa_message_id changes.
  const lastMarkedReadRef = useRef<string | null>(null);

  // Reset the dedupe key whenever the user switches conversations.
  useEffect(() => {
    lastMarkedReadRef.current = null;
  }, [contactId]);

  useEffect(() => {
    if (!contactId || DEMO_MODE) return;

    // Pick the most recent inbound message that has a wa_message_id (i.e.
    // came via Meta — not an optimistic / outbound row).
    let latestWaId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.direction === "inbound" && m.wa_message_id) {
        latestWaId = m.wa_message_id;
        break;
      }
    }
    if (!latestWaId) return;
    if (lastMarkedReadRef.current === latestWaId) return;

    lastMarkedReadRef.current = latestWaId;
    fetch("/api/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, typing: false }),
    }).catch(() => {
      /* best-effort — failure is silent (e.g. token expired). */
    });
  }, [contactId, messages]);

  // Throttled typing indicator. Two parallel side-effects:
  //   1. Meta's "typing…" bubble on the customer's WhatsApp (~25s window),
  //      so we throttle the Meta call to once per 20s.
  //   2. Our internal AI-pause heartbeat — bumps contacts.last_human_typing_at
  //      so the auto-reply pipeline holds back while the agent composes.
  //      Throttled to once per 5s — finer-grained so the pause window
  //      tracks the agent closely without hammering the DB.
  const lastTypingAtRef = useRef<number>(0);
  const lastBotPauseAtRef = useRef<number>(0);
  const handleTyping = useCallback(() => {
    if (!contactId || DEMO_MODE) return;
    const now = Date.now();
    // 1. Meta "typing…" — heavy throttle.
    if (now - lastTypingAtRef.current >= 20_000) {
      lastTypingAtRef.current = now;
      fetch("/api/mark-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, typing: true }),
      }).catch(() => {});
    }
    // 2. AI-pause heartbeat — lighter throttle.
    if (now - lastBotPauseAtRef.current >= 5_000) {
      lastBotPauseAtRef.current = now;
      fetch(`/api/contacts/${contactId}/typing`, { method: "POST" }).catch(() => {});
    }
  }, [contactId]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!contact) return;

      if (DEMO_MODE) {
        demoStore.appendOutbound(contact.id, text);
        return;
      }

      // Optimistic bubble — also strip any prior failed-optimistic with the
      // same content so retries don't pile up duplicate red bubbles.
      const optimisticId = `tmp-${Date.now()}`;
      // Snapshot the reply context before clearing — used in both the
      // optimistic bubble and the API payload below.
      const replyCtx = replyingTo;
      const optimistic: Message = {
        id: optimisticId,
        contact_id: contact.id,
        wa_message_id: null,
        direction: "outbound",
        type: "text",
        content: text,
        media_url: null,
        media_mime_type: null,
        status: "sent",
        error_message: null,
        timestamp: new Date().toISOString(),
        reply_to_wa_message_id: replyCtx?.wa_message_id ?? null,
        reply_to_content: replyCtx?.content ?? null,
        reply_to_direction: replyCtx?.direction ?? null,
        // Stamp sender now so the bubble's avatar / initials resolve
        // to the operator (KH) on frame 1 — server replace below ships
        // an identical row, no visible swap.
        sent_by_user_id: currentUserId,
        sent_by_email: currentUserEmail,
      };
      setMessages((prev) => [
        ...prev.filter(
          (m) =>
            !(
              m.id.startsWith("tmp-") &&
              m.status === "failed" &&
              m.direction === "outbound" &&
              (m.content ?? "") === text
            ),
        ),
        optimistic,
      ]);
      // Sending = explicit intent to be at the bottom. Force-pin even if the
      // user happened to be scrolled up reading older history.
      forcePinToBottom();

      try {
        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: contact.id,
            wa_id: contact.wa_id,
            text,
            reply_to_wa_message_id: replyCtx?.wa_message_id ?? null,
            reply_to_content: replyCtx?.content ?? null,
            reply_to_direction: replyCtx?.direction ?? null,
          }),
        });
        // Clear the reply context once we've handed it off — even if
        // the send fails the operator probably wants a clean composer.
        setReplyingTo(null);
        const json = await res.json();
        if (!res.ok) {
          // Server may have returned the saved failed row — replace optimistic
          // with it so polling doesn't later add it as a duplicate.
          const serverRow = json.message as Message | undefined;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticId
                ? serverRow ?? {
                    ...m,
                    status: "failed",
                    error_message: json.error ?? "Send failed",
                  }
                : m,
            ),
          );
          throw new Error(json.error ?? "Send failed");
        }
        const real = json.message as Message;
        // Race-safe replace: if realtime / polling already inserted the real
        // row before this resolved, drop the optimistic instead of mapping
        // (otherwise both versions stay in state → React duplicate-key warn).
        setMessages((prev) => {
          if (prev.some((m) => m.id === real.id)) {
            return prev.filter((m) => m.id !== optimisticId);
          }
          return prev.map((m) => (m.id === optimisticId ? real : m));
        });
      } catch (e) {
        // Bubble already marked failed above
        throw e;
      }
    },
    [contact, forcePinToBottom, replyingTo, currentUserId, currentUserEmail],
  );

  // Rich quick reply — media header + text + URL button, sent as a WhatsApp
  // interactive cta_url / media message (not insertable into the textarea).
  const handleSendRich = useCallback(
    async (q: QuickReply) => {
      if (!contact || DEMO_MODE) return;
      const optimisticId = `tmp-${Date.now()}`;
      const isVideo = q.media_kind === "video";
      const optimistic: Message = {
        id: optimisticId,
        contact_id: contact.id,
        wa_message_id: null,
        direction: "outbound",
        type: q.media_url ? (isVideo ? "video" : "image") : "text",
        content: q.body,
        media_url: q.media_url ?? null,
        media_mime_type: q.media_url ? (isVideo ? "video/mp4" : "image/jpeg") : null,
        status: "sent",
        error_message: null,
        timestamp: new Date().toISOString(),
        sent_by_user_id: currentUserId,
        sent_by_email: currentUserEmail,
      };
      setMessages((prev) => [...prev, optimistic]);
      forcePinToBottom();
      try {
        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "rich",
            contact_id: contact.id,
            wa_id: contact.wa_id,
            text: q.body,
            media_url: q.media_url ?? undefined,
            media_kind: q.media_kind ?? undefined,
            rich_buttons: q.buttons ?? undefined,
            button_text: q.button_text ?? undefined,
            button_url: q.button_url ?? undefined,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          const serverRow = json.message as Message | undefined;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticId
                ? serverRow ?? { ...m, status: "failed", error_message: json.error ?? "Send failed" }
                : m,
            ),
          );
          return;
        }
        const real = json.message as Message;
        setMessages((prev) =>
          prev.some((m) => m.id === real.id)
            ? prev.filter((m) => m.id !== optimisticId)
            : prev.map((m) => (m.id === optimisticId ? real : m)),
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === optimisticId ? { ...m, status: "failed", error_message: "Send failed" } : m)),
        );
      }
    },
    [contact, forcePinToBottom, currentUserId, currentUserEmail],
  );

  // Bubble action handlers. Reply just stages the message in the
  // composer. Edit prompts inline for new text + calls the API. Delete
  // hits DELETE → marks the row deleted (Meta + DB). State refreshes
  // via realtime / polling so we don't have to manually splice.
  const handleReplyTo = useCallback((msg: Message) => {
    setReplyingTo(msg);
  }, []);

  const handleSaveNote = useCallback(
    async (text: string) => {
      if (!contact || DEMO_MODE) return;
      const result = await addContactNoteAction(contact.id, text);
      if ("error" in result) throw new Error(result.error);
      // Realtime will deliver the server row; optimistic-add for snappiness
      setNotes((prev) =>
        prev.some((n) => n.id === result.id)
          ? prev
          : [
              ...prev,
              {
                id: result.id,
                contact_id: contact.id,
                body: text,
                created_by: currentUserId,
                created_by_email: null,
                created_at: new Date().toISOString(),
              },
            ],
      );
    },
    [contact, currentUserId],
  );

  const handleDeleteNote = useCallback(async (noteId: string) => {
    let removed: ContactNote | undefined;
    setNotes((prev) => {
      removed = prev.find((n) => n.id === noteId);
      return prev.filter((n) => n.id !== noteId);
    });
    const result = await deleteContactNoteAction(noteId);
    if ("error" in result && removed) {
      // Revert — server rejected the delete.
      setNotes((prev) => (prev.some((n) => n.id === noteId) ? prev : [...prev, removed!]));
    }
  }, []);

  const handleSendFile = useCallback(
    async (rawFile: File, caption: string) => {
      if (!contact || DEMO_MODE) return;

      // Show the optimistic bubble INSTANTLY from the raw file, THEN compress +
      // upload in the background — the image appears the moment Send is hit
      // (WhatsApp-style), not after the in-browser compression finishes.
      const localPreview = URL.createObjectURL(rawFile);
      const guessedKind: Message["type"] = rawFile.type.startsWith("image/")
        ? "image"
        : rawFile.type.startsWith("video/")
          ? "video"
          : rawFile.type.startsWith("audio/")
            ? "audio"
            : "document";

      // Unique id — several files can be sent in the SAME tick (parallel), so
      // Date.now() alone would collide and break the optimistic replace / keys.
      const optimisticId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Message = {
        id: optimisticId,
        contact_id: contact.id,
        wa_message_id: null,
        direction: "outbound",
        type: guessedKind,
        // Caption only for image/video/audio (empty if none). Documents show
        // their filename in the bubble, so keep it there — mirrors the server.
        content: caption || (guessedKind === "document" ? rawFile.name : ""),
        media_url: localPreview,
        media_mime_type: rawFile.type,
        status: "sent",
        error_message: null,
        timestamp: new Date().toISOString(),
        sent_by_user_id: currentUserId,
        sent_by_email: currentUserEmail,
      };
      setMessages((prev) => [...prev, optimistic]);
      forcePinToBottom();

      try {
        // Shrink images in-browser before upload (downscale + JPEG) so the
        // upload to our server + Meta stays fast. Non-images / failures pass
        // through untouched.
        const file = await compressImageFile(rawFile).catch(() => rawFile);
        // 1. Upload to Meta via our proxy (also stores in Supabase Storage)
        const uploadForm = new FormData();
        uploadForm.append("file", file);
        const phoneNumberIdParam = contact.business_phone_number_id
          ? `?phone_number_id=${encodeURIComponent(contact.business_phone_number_id)}`
          : "";
        const upRes = await fetch(`/api/upload-media${phoneNumberIdParam}`, {
          method: "POST",
          body: uploadForm,
        });
        const upJson = await upRes.json();
        if (!upRes.ok) throw new Error(upJson.error ?? "Upload failed");

        // 2. Send message using returned media_id + URL
        const sendRes = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "media",
            contact_id: contact.id,
            wa_id: contact.wa_id,
            media_id: upJson.media_id,
            media_url: upJson.media_url,
            media_kind: upJson.kind,
            media_mime: upJson.mime,
            caption: caption || undefined,
            filename: upJson.filename,
          }),
        });
        const sendJson = await sendRes.json();
        if (!sendRes.ok) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticId
                ? { ...m, status: "failed", error_message: sendJson.error ?? "Send failed" }
                : m,
            ),
          );
          throw new Error(sendJson.error ?? "Send failed");
        }
        const real = sendJson.message as Message;
        // Race-safe replace: if realtime / polling already inserted the real
        // row before this resolved, drop the optimistic instead of mapping
        // (otherwise both versions stay in state → React duplicate-key warn).
        setMessages((prev) => {
          if (prev.some((m) => m.id === real.id)) {
            return prev.filter((m) => m.id !== optimisticId);
          }
          return prev.map((m) => (m.id === optimisticId ? real : m));
        });
        // Real media URL is now in state; release the local blob.
        URL.revokeObjectURL(localPreview);
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId
              ? { ...m, status: "failed", error_message: (e as Error).message }
              : m,
          ),
        );
        // Failed bubbles still show the preview, so don't revoke immediately.
        // Revoke after a delay long enough for the user to see the error.
        setTimeout(() => URL.revokeObjectURL(localPreview), 60_000);
        throw e;
      }
    },
    [contact, forcePinToBottom, currentUserId, currentUserEmail],
  );

  // Voice note — recorded in the composer. Stored via /api/voice-note (Supabase
  // only, no Meta) → public URL → /api/send-message (kind=media, audio), which
  // dispatches to Evolution sendWhatsAppAudio / Meta audio / Interakt.
  const handleSendVoice = useCallback(
    async (file: File) => {
      if (!contact || DEMO_MODE) return;
      const localPreview = URL.createObjectURL(file);
      const optimisticId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Message = {
        id: optimisticId,
        contact_id: contact.id,
        wa_message_id: null,
        direction: "outbound",
        type: "audio",
        content: "",
        media_url: localPreview,
        media_mime_type: file.type,
        status: "sent",
        error_message: null,
        timestamp: new Date().toISOString(),
        sent_by_user_id: currentUserId,
        sent_by_email: currentUserEmail,
      };
      setMessages((prev) => [...prev, optimistic]);
      forcePinToBottom();
      try {
        const fd = new FormData();
        fd.append("file", file);
        const upRes = await fetch("/api/voice-note", { method: "POST", body: fd });
        const upJson = await upRes.json();
        if (!upRes.ok) throw new Error(upJson.error ?? "Voice upload failed");
        const sendRes = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "media",
            contact_id: contact.id,
            wa_id: contact.wa_id,
            media_url: upJson.media_url,
            media_kind: "audio",
            media_mime: upJson.mime,
          }),
        });
        const sendJson = await sendRes.json();
        if (!sendRes.ok) {
          setMessages((prev) =>
            prev.map((m) => (m.id === optimisticId ? { ...m, status: "failed", error_message: sendJson.error ?? "Send failed" } : m)),
          );
          throw new Error(sendJson.error ?? "Send failed");
        }
        const real = sendJson.message as Message;
        setMessages((prev) =>
          prev.some((m) => m.id === real.id) ? prev.filter((m) => m.id !== optimisticId) : prev.map((m) => (m.id === optimisticId ? real : m)),
        );
        URL.revokeObjectURL(localPreview);
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) => (m.id === optimisticId ? { ...m, status: "failed", error_message: (e as Error).message } : m)),
        );
        setTimeout(() => URL.revokeObjectURL(localPreview), 60_000);
      }
    },
    [contact, forcePinToBottom, currentUserId, currentUserEmail],
  );

  const [pendingTemplate, setPendingTemplate] = useState<TemplateSummary | null>(null);
  const [magicOpen, setMagicOpen] = useState(false);
  const [magicTextOpen, setMagicTextOpen] = useState(false);
  const [magicImageOpen, setMagicImageOpen] = useState(false);
  // Image pasted while the 24h window is closed — pre-fills the Magic
  // Message image dialog (the only way out once free-form is locked).
  const [magicImageFile, setMagicImageFile] = useState<File | null>(null);
  const [assigningTask, setAssigningTask] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  // Drag-and-drop file sharing — drop image/video files onto the chat to stage
  // them in the composer (WhatsApp-style). Only active when the composer can
  // actually accept files (reply mode + open 24h window), so the overlay never
  // invites a drop that would be silently discarded.
  const [dragActive, setDragActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const canDropFiles = !DEMO_MODE && mode !== "note" && windowState.isOpen;

  const hasDragFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  function onDragOver(e: React.DragEvent) {
    if (!canDropFiles || !hasDragFiles(e)) return;
    e.preventDefault(); // required to allow the drop
    if (!dragActive) setDragActive(true);
  }
  function onDragLeave(e: React.DragEvent) {
    // Only clear when the cursor actually left the chat (not when it moved
    // onto a child element — relatedTarget then stays inside currentTarget).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }
  function onDrop(e: React.DragEvent) {
    if (!canDropFiles || !hasDragFiles(e)) return;
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) setDroppedFiles(files);
  }

  // Safety net: a drag cancelled with Escape or released outside the window
  // doesn't fire dragleave/drop on the section, so clear the overlay globally.
  useEffect(() => {
    const clear = () => setDragActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  const [closingStatus, setClosingStatus] = useState(false);
  const [blockingBot, setBlockingBot] = useState(false);
  const [botBlocked, setBotBlocked] = useState<boolean>(false);
  useEffect(() => {
    setBotBlocked(!!contact?.bot_blocked_at);
  }, [contact?.id, contact?.bot_blocked_at]);

  // Paste-to-Magic-Message: when the 24h window is closed the composer
  // textarea is disabled, so an image paste can't land there. Catch it at
  // the document level and open the Magic Message image dialog pre-filled.
  // (Window-open paste goes straight to a media send via MessageInput;
  //  an already-open dialog handles its own paste.)
  useEffect(() => {
    if (DEMO_MODE) return;
    function onPaste(e: ClipboardEvent) {
      if (!contact || windowState.isOpen) return;
      if (magicOpen || magicTextOpen || magicImageOpen) return;
      const f = imageFromClipboard(e.clipboardData);
      if (!f) return;
      e.preventDefault();
      setMagicImageFile(f);
      setMagicImageOpen(true);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [contact, windowState.isOpen, magicOpen, magicTextOpen, magicImageOpen]);

  const doSendTemplate = useCallback(
    async (
      t: TemplateSummary,
      components: unknown[],
      renderedBody: string,
      mediaUrl?: string,
    ) => {
      if (!contact) return;
      // Diagnostic — proves whether the dialog actually passed a media URL.
      // eslint-disable-next-line no-console
      console.log("[doSendTemplate]", {
        templateName: t.name,
        headerFormat: t.header_format,
        hasMediaUrl: !!mediaUrl,
        mediaUrl: mediaUrl ?? null,
        componentsCount: components.length,
      });

      // Header media kind drives whether the bubble renders <img> or <video>.
      const headerMime =
        t.header_format === "VIDEO"
          ? "video/mp4"
          : t.header_format === "DOCUMENT"
            ? "application/pdf"
            : "image/*";

      const optimisticId = `tmp-${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        contact_id: contact.id,
        wa_message_id: null,
        direction: "outbound",
        type: "template",
        content: renderedBody || t.body || `[template: ${t.name}]`,
        // Show the uploaded header media immediately on the optimistic bubble.
        media_url: mediaUrl ?? null,
        media_mime_type: mediaUrl ? headerMime : null,
        status: "sent",
        error_message: null,
        timestamp: new Date().toISOString(),
        sent_by_user_id: currentUserId,
        sent_by_email: currentUserEmail,
      };
      setMessages((prev) => [...prev, optimistic]);
      forcePinToBottom();

      const res = await fetch("/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "template",
          contact_id: contact.id,
          wa_id: contact.wa_id,
          template_name: t.name,
          template_language: t.language,
          template_body_preview: renderedBody || t.body,
          template_components: components.length > 0 ? components : undefined,
          template_media_url: mediaUrl,
          template_media_mime: mediaUrl ? headerMime : undefined,
          // Persist template card metadata so the dashboard bubble can render
          // the same footer + buttons the customer sees on WhatsApp.
          template_footer: t.footer ?? null,
          template_buttons: t.buttons ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId
              ? { ...m, status: "failed", error_message: json.error ?? "Send failed" }
              : m,
          ),
        );
        throw new Error(json.error ?? "Template send failed");
      }
      const real = json.message as Message;
      setMessages((prev) => prev.map((m) => (m.id === optimisticId ? real : m)));
    },
    [contact, forcePinToBottom, currentUserId, currentUserEmail],
  );

  const handleSendTemplate = useCallback(
    async (t: TemplateSummary) => {
      if (!contact || DEMO_MODE) return;
      const bodyVars = (t.body.match(/\{\{(\d+)\}\}/g) ?? []).length;
      const needsMedia =
        t.header_format === "IMAGE" || t.header_format === "VIDEO" || t.header_format === "DOCUMENT";
      if (bodyVars === 0 && !needsMedia) {
        await doSendTemplate(t, [], t.body);
        return;
      }
      setPendingTemplate(t);
    },
    [contact, doSendTemplate],
  );

  if (!contact) {
    return (
      <div className="hidden md:flex flex-1 items-center justify-center bg-secondary">
        <div className="text-center text-muted-foreground">
          <MessageCircle className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">Select a conversation to start chatting</p>
        </div>
      </div>
    );
  }

  // Merge messages + notes + (optionally) LSQ activities into one
  // sorted timeline. The LSQ-in-chat toggle in ContactDetailsPanel
  // controls whether activities show inline — when off, they're still
  // visible in the right-rail timeline, just not interleaved here.
  const timeline: TimelineItem[] = [
    ...messages.map<TimelineItem>((m) => ({ kind: "message", at: m.timestamp, message: m })),
    ...notes.map<TimelineItem>((n) => ({ kind: "note", at: n.created_at, note: n })),
    ...calls.map<TimelineItem>((c) => ({
      kind: "call",
      at: c.start_at || new Date().toISOString(),
      call: c,
    })),
    ...(lsqInChat
      ? lsqActivities.map<TimelineItem>((a) => {
          // LSQ timestamps are normalised to ISO UTC (with Z) on the server.
          // Guard against a missing/malformed CreatedOn — toISOString on an
          // Invalid Date throws and would crash the whole thread.
          const d = a.created_on ? new Date(a.created_on) : null;
          return {
            kind: "lsq" as const,
            at:
              d && !Number.isNaN(d.getTime())
                ? d.toISOString()
                : new Date().toISOString(),
            activity: a,
          };
        })
      : []),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Group by day for separators
  const grouped: { dayKey: string; label: string; items: TimelineItem[] }[] = [];
  for (const item of timeline) {
    const k = dayKey(item.at);
    const last = grouped[grouped.length - 1];
    if (last && last.dayKey === k) last.items.push(item);
    else grouped.push({ dayKey: k, label: dayLabel(item.at), items: [item] });
  }

  return (
    <section
      className="relative flex flex-1 flex-col min-w-0 chat-wallpaper border-r border-black/10"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-40 m-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/40 bg-primary/20 backdrop-blur-sm">
          <div className="rounded-xl bg-white/90 px-5 py-3 text-sm font-semibold text-primary shadow">
            Drop image / video to send
          </div>
        </div>
      ) : null}
      {/* Top bar */}
      <header className="flex h-14 items-center gap-2 border-b bg-card px-2.5 shrink-0 sm:gap-3">
        {/* Mobile back button — returns to the conversation list. */}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary md:hidden"
            aria-label="Back to conversations"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        {/* Same fork as ContactList — Radix's fallback context lags
            after AvatarImage is removed, so we manually pick the
            render path. Keys the Avatar on avatar_url so a swap
            (Set-as-profile or upload) forces a clean remount instead
            of trying to reconcile through a stale Image context. */}
        {contact.avatar_url ? (
          <Avatar key={contact.avatar_url} className="h-9 w-9">
            <AvatarImage src={contact.avatar_url} alt="" />
            <AvatarFallback>{contactInitials(contact)}</AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">
            {contactInitials(contact)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-x-2">
            <span className="truncate text-sm font-semibold">
              {contactDisplayNameMasked(contact, perms.mask_phone_numbers)}
            </span>
            {!DEMO_MODE && windowState.closingSoon ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-200"
                title="The 24-hour customer service window is about to close"
              >
                <Clock className="h-3 w-3" />
                {formatTimeLeft(windowState.hoursRemaining)}
              </span>
            ) : null}
            {/* Labels — sit inline with the contact name so they're the
                first thing the operator sees on conversation switch.
                Max 3 enforced by the API; picker opens an inline
                manage view so teammates never need Settings access. */}
            {!DEMO_MODE && contact ? (
              <span className="inline-flex items-center gap-1 shrink min-w-0">
                <LabelChips labelIds={contact.label_ids} size="sm" />
                <LabelPicker
                  contactId={contact.id}
                  current={contact.label_ids ?? []}
                  onChanged={(next) => {
                    // Optimistic local mutate so the chip strip
                    // updates immediately; the next contact-refresh
                    // tick will reconcile from the server.
                    contact.label_ids = next;
                  }}
                  trigger={({ onClick, open }) => (
                    <button
                      type="button"
                      onClick={onClick}
                      className={`inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2 text-[10px] font-semibold transition ${
                        open
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                      }`}
                      title="Manage labels (max 3)"
                    >
                      <Tag className="h-2.5 w-2.5" />
                      {(contact.label_ids ?? []).length === 0
                        ? "Add label"
                        : "Edit"}
                    </button>
                  )}
                />
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 truncate text-xs text-muted-foreground">
            <span className="truncate">{maskPhone(formatPhone(contact.wa_id))}</span>
            <LeadNumberBadge leadNumber={contact.lsq_lead_number} />
          </div>
        </div>

        {/* LSQ-in-chat toggle. ON → activity bubbles render inline AND
            the hook polls LSQ for fresh activities. OFF → no inline
            bubbles AND no polling/network calls (the hook receives
            null prospect_id). Per-operator preference, persists via
            localStorage. */}
        {!DEMO_MODE ? (
          <button
            type="button"
            onClick={lsq.toggle}
            className={`shrink-0 hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
              lsq.enabled
                ? "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
                : "border-border bg-background text-muted-foreground hover:bg-secondary"
            }`}
            aria-pressed={lsq.enabled}
            title={
              lsq.enabled
                ? "LSQ activities ON — click to hide & stop fetching"
                : "LSQ activities OFF — click to show & start fetching"
            }
          >
            {lsq.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            <span className="hidden min-[1700px]:inline">
              LSQ {lsq.enabled ? `On (${lsqActivities.length})` : "Off"}
            </span>
          </button>
        ) : null}

        {/* Assign-task button — admin+ only. Opens the create-task modal
            pre-filled with this contact + number so the assignee sees
            a deep link back to the chat in their task queue. */}
        {!DEMO_MODE && isAtLeast(perms.role, "admin") ? (
          <button
            type="button"
            onClick={() => setAssigningTask(true)}
            className="shrink-0 hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15"
            title="Assign a task for this chat"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            <span className="hidden min-[1700px]:inline">Assign task</span>
          </button>
        ) : null}

        <ChatToolbar
          contact={contact}
          currentUserId={currentUserId}
          windowOpen={DEMO_MODE ? true : windowState.isOpen}
        />

        {/* Block / Unblock bot — mutes the AI auto-reply for this chat.
            Blocked: bot stays silent, the agent handles it manually; the
            composer + contact list also flag it. Toggles instantly. */}
        {!DEMO_MODE && contact ? (
          <button
            type="button"
            onClick={async () => {
              if (blockingBot) return;
              const next = !botBlocked;
              setBlockingBot(true);
              setBotBlocked(next); // optimistic
              try {
                const res = await fetch(`/api/contacts/${contact.id}/automation-status`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: next ? "block" : "unblock" }),
                });
                if (!res.ok) setBotBlocked(!next); // revert on failure
                else contact.bot_blocked_at = next ? new Date().toISOString() : null;
              } catch {
                setBotBlocked(!next);
              } finally {
                setBlockingBot(false);
              }
            }}
            disabled={blockingBot}
            className={cn(
              "shrink-0 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50",
              botBlocked
                ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
                : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
            )}
            title={botBlocked ? "Bot is blocked — click to unblock (resume AI replies)" : "Block the AI bot for this chat (handle manually)"}
          >
            {blockingBot ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : botBlocked ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" />
            )}
            <span className="hidden min-[1700px]:inline">{botBlocked ? "Unblock bot" : "Block bot"}</span>
          </button>
        ) : null}

        {/* Close / Reopen chat — sits right of the call control. Closes
            the conversation (status='closed'), which routes it to the
            Closed chip in the contact list and suppresses the 10-min
            stale-unreplied blink. Toggles to Reopen when already closed. */}
        {!DEMO_MODE && contact ? (
          <button
            type="button"
            onClick={async () => {
              if (closingStatus) return;
              const next = (contact.status ?? "open") === "closed" ? "open" : "closed";
              setClosingStatus(true);
              try {
                await setContactStatusAction(contact.id, next);
                // Optimistic local update + broadcast — ContactList
                // listens for `contact-status-changed` and patches its
                // row immediately so the chat moves between Open/Closed
                // chips without waiting for the 5-min poll cycle.
                contact.status = next;
                emitContactStatusChanged({ contactId: contact.id, status: next });
              } finally {
                setClosingStatus(false);
              }
            }}
            disabled={closingStatus}
            className={cn(
              "shrink-0 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50",
              (contact.status ?? "open") === "closed"
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
            )}
            title={
              (contact.status ?? "open") === "closed"
                ? "Reopen this chat"
                : "Mark this chat as closed"
            }
          >
            {closingStatus ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (contact.status ?? "open") === "closed" ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            )}
            <span className="hidden min-[1700px]:inline">
              {(contact.status ?? "open") === "closed" ? "Reopen" : "Close chat"}
            </span>
          </button>
        ) : null}

        {/* Tablet/mobile — open the contact-details panel as a drawer.
            On lg+ the panel is always docked, so this is hidden. */}
        {onOpenPanel ? (
          <button
            type="button"
            onClick={onOpenPanel}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary lg:hidden"
            aria-label="Contact details"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        ) : null}
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto px-2.5 py-2.5"
      >
        {/* LSQ activities are being fetched after the toggle was just
            flipped ON. Floating pill so it doesn't shift the layout —
            disappears as soon as activities resolve. */}
        {lsqLoading ? (
          <div className="pointer-events-none sticky top-2 z-20 flex justify-center">
            <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50/95 px-3 py-1.5 text-[12px] font-medium text-violet-700 shadow-sm backdrop-blur">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading LSQ activities…</span>
            </div>
          </div>
        ) : null}
        {/* Force-remount the timeline subtree on every toggle flip.
            React throws the old DOM nodes away and rebuilds from
            scratch — bulletproof against any stale-state edge case
            from the LSQ hook, fast-refresh, or HMR. */}
        <div
          ref={contentRef}
          key={`timeline-${contactId ?? "none"}-lsq-${lsqInChat ? "on" : "off"}`}
          className="space-y-3"
        >
          {loading ? (
            // No "Loading messages…" placeholder — cached chats already
            // painted instantly; for an uncached first-open we keep the
            // pane blank so messages just stream in without a flash.
            <div className="h-full" />
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : timeline.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              No messages yet. Say hello.
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.dayKey} className="space-y-1.5">
                <div className="sticky top-0 z-10 flex justify-center py-1">
                  <span className="day-chip rounded-full px-3 py-1 text-[11px] font-medium text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                <AnimatePresence initial={false}>
                  {group.items.map((item) => {
                    const key =
                      item.kind === "message"
                        ? `m-${item.message.id}`
                        : item.kind === "note"
                          ? `n-${item.note.id}`
                          : item.kind === "call"
                            ? `call-${item.call.id}`
                            : `lsq-${item.activity.id}`;
                    return (
                      <motion.div
                        key={key}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                      >
                        {item.kind === "message" ? (
                          <MessageBubble
                            message={item.message}
                            onReply={handleReplyTo}
                            contactImported={contact.imported ?? false}
                            businessNumberName={businessNumberLabel(businessNumber)}
                          />
                        ) : item.kind === "note" ? (
                          <NoteBubble
                            note={item.note}
                            canDelete={!!currentUserId && item.note.created_by === currentUserId}
                            onDelete={handleDeleteNote}
                          />
                        ) : item.kind === "call" ? (
                          <CallBubble call={item.call} />
                        ) : (
                          <LsqActivityBubble activity={item.activity} />
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 24-hour window expired banner — Meta blocks free-form replies past
          24h since the customer's last inbound. Surfaces Magic Message as
          the primary CTA — that's how we punch through the closed window
          using the magic_message utility template. */}
      {!DEMO_MODE && !windowState.isOpen && !windowState.neverOpened ? (
        <div className="border-t border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] sm:py-3">
          <div className="flex items-center gap-2 sm:items-start">
            <Clock className="h-4 w-4 shrink-0 text-amber-700 sm:mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-amber-900">
                Window closed — use Magic Message
              </div>
              <div className="hidden text-amber-800 sm:block">
                Free-form replies are no longer allowed. Send a Magic Message
                to reach this customer — once they reply, a fresh{" "}
                {WHATSAPP_WINDOW_HOURS}-hour window opens.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMagicOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-fuchsia-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-fuchsia-700"
            >
              <WandSparkles className="h-3.5 w-3.5" />
              Magic Message
            </button>
          </div>
        </div>
      ) : null}
      {!DEMO_MODE && windowState.neverOpened ? (
        <div className="border-t border-sky-200 bg-sky-50 px-2.5 py-3 text-[12px]">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sky-900">
                No customer message yet
              </div>
              <div className="text-sky-800">
                You can only start this conversation with a Magic Message.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMagicOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-fuchsia-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-fuchsia-700"
            >
              <WandSparkles className="h-3.5 w-3.5" />
              Magic Message
            </button>
          </div>
        </div>
      ) : null}

      {DEMO_MODE ? null : (
        <AutomationStatusPill
          contactId={contact?.id ?? null}
          contactStatus={contact?.status ?? null}
        />
      )}

      <MessageInput
        mode={mode}
        onModeChange={setMode}
        onSend={handleSend}
        onSaveNote={handleSaveNote}
        onSendRich={DEMO_MODE ? undefined : handleSendRich}
        onSendTemplate={DEMO_MODE ? undefined : handleSendTemplate}
        onSendFile={DEMO_MODE ? undefined : handleSendFile}
        onSendVoice={
          DEMO_MODE || !contact?.business_phone_number_id?.startsWith("evo:")
            ? undefined
            : handleSendVoice
        }
        onMagicMessage={DEMO_MODE ? undefined : () => setMagicOpen(true)}
        onDateAlign={
          DEMO_MODE || !perms.can_align_dates ? undefined : () => setBookingOpen(true)
        }
        onTyping={DEMO_MODE ? undefined : handleTyping}
        windowOpen={DEMO_MODE ? true : windowState.isOpen}
        phoneNumberId={contact?.business_phone_number_id ?? null}
        contactId={DEMO_MODE ? null : contact?.id ?? null}
        replyingTo={
          replyingTo
            ? {
                content: replyingTo.content,
                direction: replyingTo.direction,
              }
            : null
        }
        onCancelReply={() => setReplyingTo(null)}
        incomingFiles={droppedFiles}
        onIncomingFilesConsumed={() => setDroppedFiles(null)}
      />

      {pendingTemplate ? (
        <TemplateSendDialog
          template={pendingTemplate}
          phoneNumberId={contact.business_phone_number_id ?? null}
          isInterakt={contact.business_phone_number_id?.startsWith("interakt:") ?? false}
          onClose={() => setPendingTemplate(null)}
          onSend={(components, rendered, mediaUrl) =>
            doSendTemplate(pendingTemplate, components, rendered, mediaUrl)
          }
        />
      ) : null}

      {magicOpen ? (
        <MagicMessageDialog
          onClose={() => setMagicOpen(false)}
          onPickText={() => {
            setMagicOpen(false);
            setMagicTextOpen(true);
          }}
          onPickImage={() => {
            setMagicOpen(false);
            setMagicImageOpen(true);
          }}
        />
      ) : null}

      {assigningTask && contact ? (
        <CreateTaskModal
          defaultContactId={contact.id}
          defaultBusinessPhoneNumberId={
            contact.business_phone_number_id ?? null
          }
          contactLabel={
            contactDisplayNameMasked(contact, perms.mask_phone_numbers) ||
            contact.wa_id ||
            "this chat"
          }
          onClose={() => setAssigningTask(false)}
          onCreated={() => {
            setAssigningTask(false);
            emitTasksChanged();
          }}
        />
      ) : null}

      {bookingOpen && contact ? (
        <BookingDialog
          contactId={contact.id}
          contactName={
            contactDisplayNameMasked(contact, perms.mask_phone_numbers) ||
            contact.name ||
            null
          }
          onClose={() => setBookingOpen(false)}
        />
      ) : null}

      {magicTextOpen && contact ? (
        <MagicMessageTextDialog
          contactId={contact.id}
          waId={contact.wa_id}
          contactName={contactDisplayNameMasked(contact, perms.mask_phone_numbers)}
          defaultBusinessPhoneNumberId={contact.business_phone_number_id}
          onClose={() => setMagicTextOpen(false)}
          onSent={() => {
            // Polling will pick up the new row, but force-pin so the agent
            // sees their own message instantly.
            forcePinToBottom();
          }}
        />
      ) : null}

      {magicImageOpen && contact ? (
        <MagicMessageImageDialog
          contactId={contact.id}
          waId={contact.wa_id}
          contactName={contactDisplayNameMasked(contact, perms.mask_phone_numbers)}
          initialFile={magicImageFile}
          onClose={() => {
            setMagicImageOpen(false);
            setMagicImageFile(null);
          }}
          onSent={() => {
            forcePinToBottom();
          }}
        />
      ) : null}
    </section>
  );
}
