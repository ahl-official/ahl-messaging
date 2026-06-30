"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerDownLeft,
  Database,
  LayoutGrid,
  Loader2,
  Search,
  Settings2,
  Tag,
} from "lucide-react";
import { LeadTableView } from "@/components/LeadTableView";
import { createBrowserClient } from "@/lib/supabase/client";
import { INBOX_TOPIC, INBOX_EVENT, type InboxBroadcast } from "@/lib/realtime-inbox";
import { interaktTemplatePreview } from "@/lib/interakt-format";
import { subscribeAvatarChanged } from "@/lib/avatar-events";
import { subscribeContactStatusChanged } from "@/lib/contact-status-events";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/RelativeTime";
import { LabelChips, useLabels } from "@/components/LabelChips";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  contactDisplayName,
  contactDisplayNameMasked,
  contactInitials,
  type BusinessNumber,
  type Contact,
} from "@/lib/types";
import { DEMO_MODE, demoStore } from "@/lib/demo";
import { CrmLookupModal } from "@/components/CrmLookupModal";
import { usePermissions } from "@/components/PermissionsContext";
import { useMembers } from "@/components/MembersContext";
import { toneForKey, toneForNumber, toneForStage } from "@/lib/chip-tones";
import { memberDisplayName } from "@/lib/team-types";
import { AnimatePresence, motion } from "motion/react";

// Real-time 24h-window check — pure age-based: if the chat has had
// ANY activity in the last 24h it's Open, otherwise it's Closed.
// Operator wanted a single simple rule across the whole UI so chats
// move from Open → Closed the moment they cross the line, without
// waiting for the 5-min auto-close sweeper to flip `contacts.status`.
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

function isContactWindowClosed(
  c: {
    status?: string | null;
    last_message_at?: string | null;
    last_message_direction?: "inbound" | "outbound" | null;
    last_inbound_at?: string | null;
  },
  // Current time in ms — pass a live value (after mount) for a real-time
  // 24h check; pass null on the server / first paint to use the stored
  // `status` instead, so SSR and the client's first render match (no
  // hydration mismatch from boundary-crossing contacts).
  now: number | null,
): boolean {
  if (now != null) {
    // The 24h window runs from the PATIENT's last inbound message. Prefer the
    // dedicated timestamp; fall back to last_message_at when the last message
    // itself was inbound. Open until exactly 24h elapse, then Closed.
    const lastInbound =
      c.last_inbound_at ??
      (c.last_message_direction === "inbound" ? c.last_message_at : null);
    if (lastInbound) {
      return now - new Date(lastInbound).getTime() >= WHATSAPP_WINDOW_MS;
    }
    // No inbound ever → the customer's 24h window was never opened, so the
    // chat is Closed regardless of `status`. An outbound-only contact (e.g. a
    // campaign template send) stays under "Closed"/"All" until the customer
    // replies, which sets last_inbound_at and flips it Open.
    return true;
  }
  // No live time, or no known inbound timestamp → trust the sweep-maintained
  // status field.
  return (c.status ?? "open") === "closed";
}

// Filter-chip keys + display labels. Used both for rendering the strip
// and for the gear-menu visibility toggles. Order here = order on screen.
const ALL_CHIP_KEYS = [
  "Groups",
  "All",
  "Open",
  "Closed",
  "Mine",
  "Unassigned",
  "Unread",
  "Unreplied",
  "OldFirst",
] as const;

// Display labels for chips whose on-screen name differs from the stored
// key. The key stays stable (persisted in visibility/order prefs); only
// the label the operator sees changes. "Open" reads as "Active".
const CHIP_LABEL: Record<string, string> = {
  Open: "Active",
  OldFirst: "Old → New",
};

interface Props {
  initialContacts: Contact[];
  selectedId: string | null;
  onSelect: (contact: Contact) => void;
  currentUserId: string | null;
  /** The caller's email — used to match LSQ-owned leads (lsq_owner_email)
   *  under the "Mine" filter, alongside dashboard assignment (assigned_to). */
  currentUserEmail?: string | null;
  /** phone_number_id → business number row, used to render the small
   *  number-badge on every chat card. */
  businessNumbersById?: Map<string, BusinessNumber>;
  /** LSQ lead-stage filter from the colour strip above the inbox.
   *  null = no stage filter. */
  stageFilter?: string | null;
}

type StatusFilter = "all" | "open" | "closed";
type AssigneeFilter = "all" | "mine" | "unassigned";

// Filter strip uses the same tinted-tone palette as LabelChips so the
// chip design reads identically wherever a label appears (chat header,
// inbox row, filter strip). Two states:
//   • IDLE   — soft fill, Tag icon, label name. Hover = ring-2.
//   • ACTIVE — same fill, ring-2 (always), trailing ✓.
const LABEL_FILTER_TONE: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  sky:     "bg-sky-50 text-sky-800 ring-sky-200",
  violet:  "bg-violet-50 text-violet-800 ring-violet-200",
  amber:   "bg-amber-50 text-amber-800 ring-amber-200",
  rose:    "bg-rose-50 text-rose-800 ring-rose-200",
  teal:    "bg-teal-50 text-teal-800 ring-teal-200",
  slate:   "bg-slate-100 text-slate-700 ring-slate-200",
};
const LABEL_FILTER_ICON: Record<string, string> = {
  emerald: "text-emerald-600",
  sky:     "text-sky-600",
  violet:  "text-violet-600",
  amber:   "text-amber-600",
  rose:    "text-rose-600",
  teal:    "text-teal-600",
  slate:   "text-slate-500",
};
const LABEL_FILTER_ACTIVE_RING: Record<string, string> = {
  emerald: "ring-2 ring-emerald-400 ring-offset-1 ring-offset-card",
  sky:     "ring-2 ring-sky-400 ring-offset-1 ring-offset-card",
  violet:  "ring-2 ring-violet-400 ring-offset-1 ring-offset-card",
  amber:   "ring-2 ring-amber-400 ring-offset-1 ring-offset-card",
  rose:    "ring-2 ring-rose-400 ring-offset-1 ring-offset-card",
  teal:    "ring-2 ring-teal-400 ring-offset-1 ring-offset-card",
  slate:   "ring-2 ring-slate-400 ring-offset-1 ring-offset-card",
};

/** Merge incoming contacts into the existing list — update by id, add
 *  new, keep the rest — then sort newest-activity first. Lets the 10s
 *  poll refresh recent rows without dropping infinite-scrolled older
 *  pages. */
function mergeContacts(prev: Contact[], incoming: Contact[]): Contact[] {
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort(
    (a, b) =>
      new Date(b.last_message_at ?? 0).getTime() -
      new Date(a.last_message_at ?? 0).getTime(),
  );
}

/** A contact is "Mine" when I'm the dashboard assignee (assigned_to = my auth
 *  id) OR the LSQ lead owner (lsq_owner_email = my email). Most leads sync from
 *  LSQ already owned and are never dashboard-assigned, so assigned_to alone
 *  showed almost nothing under "Mine". emailLower must be pre-lower-cased. */
function contactIsMine(c: Contact, userId: string | null, emailLower: string): boolean {
  if (userId && c.assigned_to === userId) return true;
  if (emailLower && (c.lsq_owner_email ?? "").trim().toLowerCase() === emailLower) return true;
  return false;
}

export function ContactList({ initialContacts, selectedId, onSelect, currentUserId, currentUserEmail = null, businessNumbersById, stageFilter = null }: Props) {
  // Normalised once — "Mine" matches the LSQ lead owner by lower-cased email.
  const myEmail = (currentUserEmail ?? "").trim().toLowerCase();
  const perms = usePermissions();
  const members = useMembers();
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  // False during SSR + the first client paint, true after mount. Gates any
  // live `Date.now()`-based rendering so it can't differ between the
  // server HTML and the client's hydration pass.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Infinite scroll — the list pulls the next 200 as the operator
  // scrolls down, instead of loading every chat at once.
  const [hasMore, setHasMore] = useState(initialContacts.length >= 200);
  const [loadingMore, setLoadingMore] = useState(false);
  // Real count of conversations this operator has access to (server-
  // reported, all permission filters applied) — for the footer count.
  const [totalAccessible, setTotalAccessible] = useState<number | null>(null);
  // Server-side LSQ-stage filtering. When a stage chip is active the
  // client-side filter can't be trusted — it only sees the loaded page,
  // so it misses matches further down the 10k-row list. Instead we pull
  // EVERY contact in the selected stage straight from the server.
  const [stageContacts, setStageContacts] = useState<Contact[] | null>(null);
  const [stageLoading, setStageLoading] = useState(false);
  // Same idea for "Unreplied" — the loaded page only has a handful of
  // unanswered chats, but there can be thousands. Pull the whole set from
  // the server so the count + list are real, not page-limited.
  const [unrepliedContacts, setUnrepliedContacts] = useState<Contact[] | null>(null);
  const [unrepliedLoading, setUnrepliedLoading] = useState(false);
  // Same idea for "Mine" — pull every chat assigned to this user from the
  // server, not just whatever's in the loaded page.
  const [mineContacts, setMineContacts] = useState<Contact[] | null>(null);
  const [mineLoading, setMineLoading] = useState(false);
  // Same idea as "Mine" — the loaded page only carries a handful of
  // unassigned rows, but there can be thousands. Pull the full
  // server-filtered set so the count + list cover every unassigned chat.
  const [unassignedContacts, setUnassignedContacts] = useState<Contact[] | null>(
    null,
  );
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  // Set for one syncDelta tick after a user "load more" so the page
  // append isn't mistaken for a live backfill ("Syncing… +N").
  const userLoadRef = useRef(false);
  // Sync-activity indicator. When the contacts list grows rapidly (typical
  // of an Evolution `syncFullHistory` backfill firing messages.upsert in
  // bulk after a QR re-scan) we surface "Syncing… +N new" in the footer
  // so the operator knows old chats are still arriving and doesn't refresh
  // mid-stream. Decays back to "Up to date" after 30s of no growth.
  const [syncDelta, setSyncDelta] = useState<{ count: number } | null>(null);
  const prevLenRef = useRef<number>(initialContacts.length);
  useEffect(() => {
    const cur = contacts.length;
    const prev = prevLenRef.current;
    if (userLoadRef.current) {
      // Operator scrolled to load an older page — not a live backfill.
      userLoadRef.current = false;
    } else if (cur > prev) {
      setSyncDelta((s) => ({ count: (s?.count ?? 0) + (cur - prev) }));
    }
    prevLenRef.current = cur;
  }, [contacts.length]);

  // Fetch the next page when the operator scrolls near the bottom.
  const loadMore = useCallback(async () => {
    if (DEMO_MODE || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/contacts?offset=${contacts.length}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        contacts?: Contact[];
        hasMore?: boolean;
        total?: number;
      };
      if (json.contacts && json.contacts.length > 0) {
        userLoadRef.current = true;
        setContacts((prev) => mergeContacts(prev, json.contacts!));
      }
      setHasMore(!!json.hasMore);
      if (typeof json.total === "number") setTotalAccessible(json.total);
    } catch {
      /* keep current list — next scroll retries */
    } finally {
      setLoadingMore(false);
    }
  }, [contacts.length, loadingMore, hasMore]);

  // Pull the full stage-filtered set whenever the strip selection
  // changes. Walks pages so stages with >200 contacts come back whole.
  useEffect(() => {
    if (DEMO_MODE || !stageFilter) {
      setStageContacts(null);
      setStageLoading(false);
      return;
    }
    let cancelled = false;
    setStageLoading(true);
    setStageContacts(null);
    (async () => {
      const all: Contact[] = [];
      for (let off = 0; off < 40000; off += 200) {
        const res = await fetch(
          `/api/contacts?stage=${encodeURIComponent(stageFilter)}&offset=${off}`,
          { cache: "no-store" },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          contacts?: Contact[];
          hasMore?: boolean;
        };
        if (cancelled) return;
        const batch = json.contacts ?? [];
        all.push(...batch);
        if (!json.hasMore || batch.length === 0) break;
      }
      if (!cancelled) {
        setStageContacts(all);
        setStageLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stageFilter]);


  // Pull every WhatsApp group from Evolution into the inbox, then
  // refresh the list so they show under the Groups filter.
  const syncGroups = useCallback(async () => {
    setSyncingGroups(true);
    try {
      const res = await fetch("/api/evolution/sync-groups", { method: "POST" });
      if (!res.ok) return;
      const r = await fetch("/api/contacts", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { contacts?: Contact[] };
      if (j.contacts) {
        userLoadRef.current = true;
        setContacts((prev) => mergeContacts(prev, j.contacts!));
      }
    } catch {
      /* silent — operator can retry */
    } finally {
      setSyncingGroups(false);
    }
  }, []);

  useEffect(() => {
    if (!syncDelta) return;
    const t = setTimeout(() => setSyncDelta(null), 30_000);
    return () => clearTimeout(t);
  }, [syncDelta]);
  const [query, setQuery] = useState("");
  // Server-search fallback. The inbox sidebar only holds ~200 contacts
  // at a time; without this, searching for a phone number that isn't
  // in the loaded slice returned "No contacts match" even though the
  // contact existed in the DB. We debounce a /api/contacts/search call
  // and surface those rows as a second pool that the filter unions
  // against, so any contact in the workspace (the user has access to)
  // is findable from the search box.
  const [serverSearchResults, setServerSearchResults] = useState<Contact[]>([]);
  const [serverSearching, setServerSearching] = useState(false);
  // When set, the cross-CRM lookup modal is open for this query.
  const [crmLookupQuery, setCrmLookupQuery] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  // Render only the most-recent slice first so the inbox paints instantly;
  // scrolling reveals older rows (then fetches the next server page when the
  // loaded set runs out). Sorted by recency, so this is "latest 15, load more
  // by time" as the operator scrolls.
  const INITIAL_VISIBLE = 15;
  const VISIBLE_STEP = 15;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  // "Unreplied" — customer's last message was inbound and we haven't
  // replied yet. Used to triage patients who are still waiting.
  const [unrepliedOnly, setUnrepliedOnly] = useState(false);
  // "Old → New" — sort the visible list oldest-last-message first (FIFO),
  // so the longest-waiting unreplied chats surface at the top.
  const [oldestFirst, setOldestFirst] = useState(false);

  // Pull the full "Unreplied" set (last message inbound, any window) from the
  // server when the chip is on — walks pages like the stage fetch above so
  // the count + list cover every unanswered chat, not just the loaded page.
  useEffect(() => {
    if (DEMO_MODE || !unrepliedOnly) {
      setUnrepliedContacts(null);
      setUnrepliedLoading(false);
      return;
    }
    let cancelled = false;
    setUnrepliedLoading(true);
    setUnrepliedContacts([]);
    (async () => {
      const all: Contact[] = [];
      for (let off = 0; off < 40000; off += 200) {
        const res = await fetch(`/api/contacts?unreplied=1&offset=${off}`, { cache: "no-store" });
        if (!res.ok) break;
        const json = (await res.json()) as { contacts?: Contact[]; hasMore?: boolean };
        if (cancelled) return;
        const batch = json.contacts ?? [];
        all.push(...batch);
        // Progressive — surface each page as it arrives so the list fills up
        // instead of staying empty until the whole walk finishes.
        setUnrepliedContacts([...all]);
        if (!json.hasMore || batch.length === 0) break;
      }
      if (!cancelled) setUnrepliedLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [unrepliedOnly]);

  // Pull every chat assigned to this user when the "Mine" chip is on — walks
  // pages so it covers all assigned leads, not just the loaded slice.
  useEffect(() => {
    if (DEMO_MODE || assigneeFilter !== "mine") {
      setMineContacts(null);
      setMineLoading(false);
      return;
    }
    let cancelled = false;
    setMineLoading(true);
    setMineContacts([]);
    (async () => {
      const all: Contact[] = [];
      for (let off = 0; off < 40000; off += 200) {
        const res = await fetch(`/api/contacts?mine=1&offset=${off}`, { cache: "no-store" });
        if (!res.ok) break;
        const json = (await res.json()) as { contacts?: Contact[]; hasMore?: boolean };
        if (cancelled) return;
        const batch = json.contacts ?? [];
        all.push(...batch);
        setMineContacts([...all]);
        if (!json.hasMore || batch.length === 0) break;
      }
      if (!cancelled) setMineLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [assigneeFilter]);
  // Pull every unassigned chat when the "Unassigned" chip is on — walks
  // pages so the list + count cover all unassigned leads, not just the
  // loaded slice. Server applies the same permission scope.
  useEffect(() => {
    if (DEMO_MODE || assigneeFilter !== "unassigned") {
      setUnassignedContacts(null);
      setUnassignedLoading(false);
      return;
    }
    let cancelled = false;
    setUnassignedLoading(true);
    setUnassignedContacts([]);
    (async () => {
      const all: Contact[] = [];
      for (let off = 0; off < 40000; off += 200) {
        const res = await fetch(`/api/contacts?unassigned=1&offset=${off}`, {
          cache: "no-store",
        });
        if (!res.ok) break;
        const json = (await res.json()) as { contacts?: Contact[]; hasMore?: boolean };
        if (cancelled) return;
        const batch = json.contacts ?? [];
        all.push(...batch);
        setUnassignedContacts([...all]);
        if (!json.hasMore || batch.length === 0) break;
      }
      if (!cancelled) setUnassignedLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [assigneeFilter]);
  // While "Unassigned" stays open, silently re-pull the set every 15s. The
  // background owner-sync sweep keeps writing each lead's real LSQ owner onto
  // contacts.lsq_owner_email; the server then stops returning it as
  // unassigned. So a lead that turns out to be already owned drops from this
  // list on the next refresh — no manual reload. Silent: we swap the data in
  // place (no loading flash), so the list just shrinks as owners resolve.
  useEffect(() => {
    if (DEMO_MODE || assigneeFilter !== "unassigned") return;
    let cancelled = false;
    const refresh = async () => {
      const all: Contact[] = [];
      for (let off = 0; off < 40000; off += 200) {
        const res = await fetch(`/api/contacts?unassigned=1&offset=${off}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { contacts?: Contact[]; hasMore?: boolean };
        const batch = json.contacts ?? [];
        all.push(...batch);
        if (!json.hasMore || batch.length === 0) break;
      }
      if (!cancelled) setUnassignedContacts(all);
    };
    const id = setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [assigneeFilter]);
  // Tick every 30s so the stale-unreplied highlight + the 24h window
  // check pick up the moment a row crosses each threshold without the
  // operator needing to refresh. State value itself isn't used; the
  // re-render is what matters.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Live clock for the real-time 24h-window check. Null until mounted so the
  // server render + client first paint agree (then the effect above keeps it
  // fresh every 30s, flipping a chat to Closed the moment its window expires).
  const now = mounted ? nowTs : null;

  // Filter-chip visibility + order — operator toggles which chips show
  // via the gear menu, and drags chips in the strip to reorder them.
  // Both persisted per-browser; defaults: all visible in declaration order.
  const [visibleChips, setVisibleChips] = useState<Set<string>>(
    () => new Set(ALL_CHIP_KEYS),
  );
  const [chipOrder, setChipOrder] = useState<string[]>(() => [...ALL_CHIP_KEYS]);
  const [chipMenuOpen, setChipMenuOpen] = useState(false);
  // Inline "edit filters" checklist inside the expanded panel.
  const [editChips, setEditChips] = useState(false);
  // When the strip overflows, the right-side chevron toggles a wrap-grid
  // panel below that shows every chip. Selecting any chip collapses back.
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [tableOpen, setTableOpen] = useState(false); // CRM-style lead table
  const dragChipRef = useRef<string | null>(null);
  const [dragOverChip, setDragOverChip] = useState<string | null>(null);
  useEffect(() => {
    try {
      const allowed = new Set<string>(ALL_CHIP_KEYS);
      // Order first — it also tells us which chips this user has ALREADY
      // seen/configured. Anything not in here is a newly-added filter.
      let savedOrder: string[] | null = null;
      const rawOrder = localStorage.getItem("qht.contactList.chipOrder.v2");
      if (rawOrder) {
        const arr = JSON.parse(rawOrder) as string[];
        if (Array.isArray(arr)) savedOrder = arr.filter((k) => allowed.has(k));
      }
      if (savedOrder) {
        // Keep only known keys; append any newly-added keys at the end so a
        // future chip addition doesn't disappear for users with an old order.
        const missing = ALL_CHIP_KEYS.filter((k) => !savedOrder!.includes(k));
        setChipOrder([...savedOrder, ...missing]);
      }
      const seen = new Set(savedOrder ?? []); // chips present when last configured
      const rawVis = localStorage.getItem("qht.contactList.chips.v2");
      if (rawVis) {
        const arr = JSON.parse(rawVis) as string[];
        if (Array.isArray(arr)) {
          const vis = new Set(arr.filter((k) => allowed.has(k)));
          // Newly-added chips (never seen by this user) default to VISIBLE —
          // otherwise a new filter silently disappears for existing users who
          // saved a visibility config before that filter existed.
          for (const k of ALL_CHIP_KEYS) if (!seen.has(k)) vis.add(k);
          setVisibleChips(vis);
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);
  function toggleChipVisible(key: string) {
    setVisibleChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(
          "qht.contactList.chips.v2",
          JSON.stringify(Array.from(next)),
        );
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
  }
  function reorderChips(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    setChipOrder((prev) => {
      const next = prev.slice();
      const from = next.indexOf(fromKey);
      const to = next.indexOf(toKey);
      if (from < 0 || to < 0) return prev;
      next.splice(from, 1);
      next.splice(to, 0, fromKey);
      try {
        localStorage.setItem("qht.contactList.chipOrder.v2", JSON.stringify(next));
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
  }
  // "Groups" filter — when on, the list shows only WhatsApp groups;
  // when off, groups are hidden from every other view.
  const [groupsView, setGroupsView] = useState(false);
  const [syncingGroups, setSyncingGroups] = useState(false);
  // AND-semantics label filter: contact must carry every selected label
  // to stay in the list. Empty set = no filter.
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<string>>(() => new Set());
  const labels = useLabels();
  // Workspace-level "show/hide this number" state. /api/contacts already
  // filters by is_active server-side, but realtime inserts bypass that —
  // a message on a hidden number would briefly show in the inbox until
  // the next poll/refetch (the "2-4 second glitch"). Tracking the active
  // set client-side and filtering in the memo makes hidden numbers
  // invisible the instant the realtime payload arrives.
  // Bootstrap the active set synchronously from initialContacts so the
  // very first realtime payload is already gated. The fetch later
  // replaces this with the authoritative set (covering active numbers
  // that happened to have no contacts at SSR time).
  const [activeNumberIds, setActiveNumberIds] = useState<Set<string> | null>(
    () => {
      if (DEMO_MODE) return null;
      // Seed from the contacts we're about to render so the very first
      // paint shows them (their numbers are active by definition). The
      // /api/business-numbers fetch later trims any number the operator
      // has toggled off.
      const seed = new Set<string>();
      for (const c of initialContacts) {
        if (c.business_phone_number_id) seed.add(c.business_phone_number_id);
      }
      return seed;
    },
  );
  // Gate: stays false until the first /api/business-numbers fetch
  // settles. Without it, refresh briefly shows the SSR-allowed payload
  // before the workspace-active filter trims it — operators see a
  // "flash of other chats" each page load.
  const [filterHydrated, setFilterHydrated] = useState(DEMO_MODE);
  // Mirror activeNumberIds in a ref so the realtime callback can read
  // the latest set without re-subscribing on every state change. The
  // realtime listener uses this to drop inserts on hidden numbers
  // BEFORE they hit state — eliminating the "2-4 second flicker".
  const activeNumberIdsRef = useRef<Set<string> | null>(activeNumberIds);
  useEffect(() => {
    activeNumberIdsRef.current = activeNumberIds;
  }, [activeNumberIds]);

  // Permission allow-list (per-user, set from PermissionsProvider on
  // mount). Realtime callbacks ALSO need to gate on this — otherwise
  // a customer chat on a number this operator isn't allowed to see
  // can be pushed into the inbox by Postgres realtime, and the
  // operator briefly sees it until the filtered render hides it. Bug
  // surfaced when an admin restricted a teammate to just one number
  // but the teammate still saw all chats. Captured in a ref the same
  // way activeNumberIdsRef is so the closure reads the latest value
  // without re-subscribing.
  const allowedNumberIdsRef = useRef<string[] | null>(
    perms.allowed_number_ids,
  );
  useEffect(() => {
    allowedNumberIdsRef.current = perms.allowed_number_ids;
  }, [perms.allowed_number_ids]);

  // Latest selected id for the refresh closure below (empty-dep effect).
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Refetch active number set + contacts. Triggered on mount and
  // whenever the operator toggles a connected number on/off in the
  // user-menu. Two-step:
  //   1. Pull /api/business-numbers to know which bpids are visible.
  //   2. Pull /api/contacts (server-filters by is_active too).
  // With activeNumberIds populated, realtime inserts on hidden numbers
  // get filtered out at the memo before they can flicker into view.
  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    async function refreshNumbersAndContacts() {
      try {
        const numbersRes = await fetch("/api/business-numbers", {
          cache: "no-store",
        });
        if (numbersRes.ok) {
          const j = (await numbersRes.json()) as {
            numbers?: Array<{ phone_number_id: string; is_active: boolean }>;
          };
          const next = new Set(
            (j.numbers ?? [])
              .filter((n) => n.is_active)
              .map((n) => n.phone_number_id),
          );
          if (!cancelled) setActiveNumberIds(next);
        }
      } catch {
        /* keep current set on error — better stale than empty */
      } finally {
        // Flip the hydration gate as soon as the authoritative active
        // set is in hand (or the request failed) so the list paint
        // never gets ahead of the filter.
        if (!cancelled) setFilterHydrated(true);
      }
      try {
        const res = await fetch("/api/contacts", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          contacts?: Contact[];
          total?: number;
        };
        if (!cancelled && json.contacts) {
          const fresh = json.contacts;
          // Keep the open chat's row even when it falls outside the first
          // page (e.g. the embed's ?wa= deep link prepends an older
          // contact) — a full replace would drop its highlighted row.
          setContacts((prev) => {
            const sel = selectedIdRef.current;
            if (sel && !fresh.some((c) => c.id === sel)) {
              const keep = prev.find((c) => c.id === sel);
              if (keep) return [keep, ...fresh];
            }
            return fresh;
          });
        }
        if (!cancelled && typeof json.total === "number") {
          setTotalAccessible(json.total);
        }
      } catch {
        /* keep current list on error */
      }
    }
    void refreshNumbersAndContacts();
    window.addEventListener("business-numbers-changed", refreshNumbersAndContacts);
    return () => {
      cancelled = true;
      window.removeEventListener(
        "business-numbers-changed",
        refreshNumbersAndContacts,
      );
    };
  }, []);

  useEffect(() => {
    if (DEMO_MODE) {
      setContacts(demoStore.getContacts());
      return demoStore.subscribe(() => setContacts(demoStore.getContacts()));
    }

    const supabase = createBrowserClient();
    const channel = supabase
      .channel("contacts-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        (payload) => {
          setContacts((current) => {
            if (payload.eventType === "DELETE") {
              return current.filter((c) => c.id !== (payload.old as Contact).id);
            }
            const next = payload.new as Contact;
            // Drop inserts on hidden numbers BEFORE they reach state.
            // Without this guard, toggling a number off in the user
            // menu still let a new message on that number flicker into
            // the inbox for 2-4 seconds until the next poll filtered
            // it out. The ref reads the latest active set so this
            // closure stays correct without re-subscribing.
            const active = activeNumberIdsRef.current;
            if (
              active &&
              next.business_phone_number_id &&
              !active.has(next.business_phone_number_id)
            ) {
              return current;
            }
            // Permission gate — drop realtime inserts on numbers this
            // operator isn't allowed to see (per-member override or
            // role default). Without this the filtered render hides
            // the row from view but the chat audibly pings via the
            // notification watcher.
            const allowed = allowedNumberIdsRef.current;
            if (
              allowed !== null &&
              next.business_phone_number_id &&
              !allowed.includes(next.business_phone_number_id)
            ) {
              return current;
            }
            const without = current.filter((c) => c.id !== next.id);
            return [next, ...without].sort(
              (a, b) =>
                new Date(b.last_message_at ?? 0).getTime() -
                new Date(a.last_message_at ?? 0).getTime(),
            );
          });
        },
      )
      .subscribe();

    // Polling fallback — realtime can be blocked by RLS / Realtime
    // Authorization. Poll every 4s to keep the sidebar fresh; ping
    // sound + toasts come from GlobalInboundWatcher.
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/contacts", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          contacts?: Contact[];
          total?: number;
        };
        if (cancelled || !json.contacts) return;

        // Sidebar refresh only — sound/toast/desktop notification now
        // live in GlobalInboundWatcher (dashboard layout) so they fire
        // on every page, not just the inbox.
        //
        // Merge (not replace) so infinite-scrolled older pages survive
        // the poll — it only refreshes the recent 200.
        const incoming = json.contacts;
        setContacts((prev) => mergeContacts(prev, incoming));
        if (typeof json.total === "number") setTotalAccessible(json.total);
      } catch {
        // Silent — next tick will retry.
      }
    }
    // 10s poll — realtime subs catch the immediate case; this is just
    // the eventual-consistency fallback. With 100 operators the old 4s
    // cadence hammered Supabase (1,500 req/min just from this one
    // route) and tanked dashboard responsiveness.
    const interval = setInterval(poll, 10_000);

    // Instant push: every provider's webhook broadcasts on the `inbox` topic
    // the moment a message lands (lib/realtime-inbox), independent of the
    // RLS-gated postgres_changes above. Debounce a burst of messages into a
    // single refetch so the sidebar refreshes in ~0.4s instead of waiting up
    // to 10s for the poll. Gate on the operator's active/allowed numbers so a
    // chat they can't see doesn't trigger a needless refetch.
    let inboxDebounce: ReturnType<typeof setTimeout> | null = null;
    const inboxChannel = supabase
      .channel(INBOX_TOPIC)
      .on("broadcast", { event: INBOX_EVENT }, ({ payload }) => {
        const bpid = (payload as InboxBroadcast)?.business_phone_number_id ?? null;
        const active = activeNumberIdsRef.current;
        if (active && bpid && !active.has(bpid)) return;
        const allowed = allowedNumberIdsRef.current;
        if (allowed !== null && bpid && !allowed.includes(bpid)) return;
        if (inboxDebounce) clearTimeout(inboxDebounce);
        inboxDebounce = setTimeout(() => void poll(), 400);
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (inboxDebounce) clearTimeout(inboxDebounce);
      supabase.removeChannel(channel);
      supabase.removeChannel(inboxChannel);
    };
  }, []);

  // Listen for in-tab avatar mutations so the row swaps to the new
  // avatar (or initials, on remove) in the same frame as the click —
  // realtime + 4s polling are the eventual-consistency fallbacks but
  // can lag noticeably on slow networks.
  useEffect(() => {
    return subscribeAvatarChanged(({ contactId, avatarUrl }) => {
      setContacts((cur) =>
        cur.map((c) =>
          c.id === contactId ? { ...c, avatar_url: avatarUrl } : c,
        ),
      );
    });
  }, []);

  // Sidebar row instantly reflects open ↔ closed flips from the
  // Contact Details button. Without this, the row stays in the Open
  // tab until the next 10s poll catches up.
  useEffect(() => {
    return subscribeContactStatusChanged(({ contactId, status }) => {
      setContacts((cur) =>
        cur.map((c) => (c.id === contactId ? { ...c, status } : c)),
      );
    });
  }, []);

  // Debounced server-search fallback. The sidebar pages 200 contacts
  // at a time; without this, typing a phone number that isn't in the
  // loaded slice returns "No contacts match" even though the row
  // exists in the DB. We hit /api/contacts/search whenever the query
  // is 3+ chars and merge the results into the displayed list.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || DEMO_MODE) {
      setServerSearchResults([]);
      setServerSearching(false);
      return;
    }
    setServerSearching(true);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/contacts/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        if (!res.ok) {
          setServerSearchResults([]);
          return;
        }
        const j = (await res.json()) as { contacts?: Contact[] };
        setServerSearchResults(j.contacts ?? []);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setServerSearchResults([]);
      } finally {
        setServerSearching(false);
      }
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // Backfill WhatsApp profile pics for any visible Evolution contacts
  // that don't have one cached yet. One-shot per browser session — the
  // sessionStorage flag stops us from re-firing on every contacts
  // refresh (polling tick or label switch). Server gates the per-bpid
  // Evolution / Meta logic + concurrency.
  // Tracks contact IDs we've already asked the server about during this
  // tab's lifetime so we don't keep re-fetching the same misses on every
  // polling tick. Server-side gates concurrency; this is purely a
  // client-side dedupe.
  const avatarAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const attempted = avatarAttemptedRef.current;
    const queue = contacts
      .filter(
        (c) =>
          !c.avatar_url &&
          !attempted.has(c.id) &&
          typeof c.business_phone_number_id === "string" &&
          c.business_phone_number_id.startsWith("evo:"),
      )
      .map((c) => c.id);
    if (queue.length === 0) return;
    // Mark every queued id as attempted up-front so subsequent renders
    // (which fire while these requests are still in flight) don't
    // re-enqueue them.
    for (const id of queue) attempted.add(id);

    // Walk the queue in 50-id chunks. The server already throttles
    // per-bpid concurrency; we just need to chunk so the request body
    // stays modest.
    void (async () => {
      const CHUNK = 50;
      for (let i = 0; i < queue.length; i += CHUNK) {
        const slice = queue.slice(i, i + CHUNK);
        try {
          const r = await fetch("/api/contacts/refresh-avatars", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_ids: slice }),
          });
          if (!r.ok) continue;
          const j = (await r.json()) as { updated?: Record<string, string> };
          if (!j.updated) continue;
          setContacts((cur) =>
            cur.map((c) =>
              j.updated && j.updated[c.id]
                ? { ...c, avatar_url: j.updated[c.id] }
                : c,
            ),
          );
        } catch {
          /* keep going — next chunk / next tick will retry on its own */
        }
      }
    })();
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "#432029" → "432029" so a hashed lead-id query matches the bare digits
    // stored in the column.
    const qNoHash = q.startsWith("#") ? q.slice(1) : q;
    const qDigits = q.replace(/\D/g, "");
    const allowedNumbers = perms.allowed_number_ids;
    // Build a name lookup once per render so the search can match label
    // names without scanning the labels list per-contact.
    const labelNameById = new Map((labels ?? []).map((l) => [l.id, l.name.toLowerCase()]));
    // With a stage chip active, filter the server-fetched stage set
    // (every match, not just the loaded page). Demo mode has no server,
    // so it keeps filtering the local list client-side.
    let source: Contact[];
    if (unrepliedOnly && !DEMO_MODE) {
      // Overlay the server-fetched unreplied set with the LIVE rows from the
      // loaded list (which carry realtime updates). The moment the agent
      // replies, the live row's last_message_direction flips to "outbound"
      // and the inbound-only filter below drops it — so a chat leaves
      // Unreplied (into Open) immediately, without a re-fetch.
      const liveById = new Map(contacts.map((c) => [c.id, c]));
      source = (unrepliedContacts ?? []).map((c) => liveById.get(c.id) ?? c);
    } else if (stageFilter && !DEMO_MODE) {
      source = stageContacts ?? [];
    } else if (assigneeFilter === "mine" && !DEMO_MODE) {
      // Server-fetched "assigned to me" set, overlaid with live rows so a
      // reassignment away drops the chat immediately (the predicate below
      // still gates on assigned_to === currentUserId).
      const liveById = new Map(contacts.map((c) => [c.id, c]));
      source = (mineContacts ?? []).map((c) => liveById.get(c.id) ?? c);
    } else if (assigneeFilter === "unassigned" && !DEMO_MODE) {
      // Server-fetched unassigned set, overlaid with live rows so a chat
      // that just got assigned drops immediately (the predicate below
      // still gates on !assigned_to).
      const liveById = new Map(contacts.map((c) => [c.id, c]));
      source = (unassignedContacts ?? []).map((c) => liveById.get(c.id) ?? c);
    } else {
      source = contacts;
    }
    // Union in server-search hits when the operator has typed a query.
    // Dedupe by id; local rows win because they may carry richer
    // optimistic state the search endpoint doesn't return.
    if (q && serverSearchResults.length > 0) {
      const seen = new Set(source.map((c) => c.id));
      const extras = serverSearchResults.filter((c) => !seen.has(c.id));
      if (extras.length > 0) source = [...source, ...extras];
    }
    const out = source.filter((c) => {
      // Permission: only show conversations on numbers this user can access.
      if (allowedNumbers !== null) {
        if (!c.business_phone_number_id) return false;
        if (!allowedNumbers.includes(c.business_phone_number_id)) return false;
      }
      // Workspace toggle (user-menu on/off switches): hide contacts on
      // numbers flipped to inactive. While the toggle state is still
      // loading (null), DROP everything — showing the unfiltered list
      // for a few hundred ms looks like "contacts from other numbers
      // flashed through" to the operator. A blank pane briefly is the
      // smaller surprise.
      if (activeNumberIds === null) return false;
      if (c.business_phone_number_id) {
        if (!activeNumberIds.has(c.business_phone_number_id)) return false;
      }
      // Groups vs 1:1 split — groups (WhatsApp @g.us chats) only ever
      // show under the "Groups" filter; every other view hides them.
      if (groupsView !== Boolean(c.is_group)) return false;

      // Exact-identifier search — a full phone / lead number / prospect id
      // typed in the box is a deliberate "find THIS lead". It must surface
      // even when the active status / unread / unreplied / stage / label
      // filters would otherwise hide it (e.g. a closed lead while on the
      // Open tab). Permission + workspace-active + groups gating above still
      // applies; only the view filters + fuzzy-search rejection are skipped.
      const exactHit =
        q.length > 0 &&
        ((qDigits.length >= 6 &&
          !!c.wa_id &&
          (c.wa_id === qDigits || c.wa_id.endsWith(qDigits))) ||
          ((c.lsq_lead_number ?? "").toLowerCase() === qNoHash) ||
          ((c.lsq_prospect_id ?? "").toLowerCase() === q));
      if (exactHit) return true;

      // The status / assignee / unread / stage / label filters apply to
      // the normal chat views only — groups are a flat read-only list.
      if (!groupsView) {
        // Status — a real-time window check overrides the stored
        // `c.status` so chats whose 24h window just expired land in
        // "Closed" immediately, not 5 minutes later when the auto-
        // close sweeper next runs.
        if (statusFilter !== "all") {
          const closed = isContactWindowClosed(c, now);
          const effective = closed ? "closed" : "open";
          if (effective !== statusFilter) return false;
        }
        // Assignee
        if (assigneeFilter === "mine") {
          if (!contactIsMine(c, currentUserId, myEmail)) return false;
        } else if (assigneeFilter === "unassigned") {
          if (c.assigned_to) return false;
        }
        // Unread only — exclude window-closed chats (real-time check,
        // not just stored status) so 24h-expired threads never appear
        // here. They surface under the Closed tab only.
        if (unreadOnly) {
          if ((c.unread_count ?? 0) <= 0) return false;
          if (isContactWindowClosed(c, now)) return false;
        }
        // Unreplied — the customer's last message is still unanswered.
        // ANY window (closed ones just need a Magic Message) — the agent
        // wants to see every patient who's waiting, not only the few whose
        // 24h window happens to be open.
        if (unrepliedOnly) {
          if (c.last_message_direction !== "inbound") return false;
        }
        // LSQ lead-stage filter — from the colour strip above the inbox.
        if (stageFilter) {
          if (
            (c.lsq_stage ?? "").trim().toLowerCase() !==
            stageFilter.trim().toLowerCase()
          ) {
            return false;
          }
        }
        // Label filter — AND semantics. Contact must carry EVERY selected
        // label to stay. Empty set short-circuits.
        if (selectedLabelIds.size > 0) {
          const ids = new Set(c.label_ids ?? []);
          for (const wanted of selectedLabelIds) {
            if (!ids.has(wanted)) return false;
          }
        }
      }
      // Search — matches across multiple haystacks so the agent can find a
      // chat by typing any of: name, phone, tag, label name, LSQ lead
      // number, or LSQ stage. Lead number matches both "432029" and
      // "#432029" naturally because the stored value is digits-only and
      // we lowercase the query (no special handling needed).
      if (q) {
        const name = contactDisplayName(c).toLowerCase();
        const tagHit = (c.tags ?? []).some((t) => t.toLowerCase().includes(q));
        const labelHit = (c.label_ids ?? []).some((id) =>
          (labelNameById.get(id) ?? "").includes(q),
        );
        const leadNumber = (c.lsq_lead_number ?? "").toLowerCase();
        const stage = (c.lsq_stage ?? "").toLowerCase();
        const owner = (c.lsq_owner_name ?? "").toLowerCase();
        if (
          !name.includes(q) &&
          !(c.wa_id ?? "").includes(q) &&
          !tagHit &&
          !labelHit &&
          !leadNumber.includes(qNoHash) &&
          !stage.includes(q) &&
          !owner.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
    // Default is newest-first (source order). "Old → New" flips to oldest
    // last-message first — useful for clearing unreplied chats FIFO.
    return oldestFirst
      ? [...out].sort((a, b) => new Date(a.last_message_at ?? 0).getTime() - new Date(b.last_message_at ?? 0).getTime())
      : out;
  }, [contacts, unrepliedContacts, stageContacts, mineContacts, unassignedContacts, serverSearchResults, query, statusFilter, assigneeFilter, unreadOnly, unrepliedOnly, oldestFirst, groupsView, stageFilter, selectedLabelIds, labels, activeNumberIds, currentUserId, myEmail, perms.allowed_number_ids, now]);

  // Reset the visible window to the first slice whenever the filter
  // criteria change, so narrowing/searching always starts at the top.
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [query, statusFilter, assigneeFilter, unreadOnly, unrepliedOnly, groupsView, stageFilter, selectedLabelIds]);

  // The rows actually rendered — the most-recent `visibleCount` of the
  // filtered set. Capped client-side; scrolling grows it / fetches more.
  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  // A query that looks like a phone / lead number → offer the
  // cross-CRM lookup (digits, ≥4 of them, ignoring #/+/spaces).
  const lookupQuery = (() => {
    const t = query.trim();
    const cleaned = t.replace(/[#\s+()-]/g, "");
    return cleaned.length >= 6 && /^\d+$/.test(cleaned) ? t : null;
  })();

  // Auto cross-CRM lookup: a lead-id / phone search that matches NO local
  // contact (e.g. an un-synced lead, or a stale local lead number) resolves
  // straight from LSQ instead of dead-ending on "no contacts". Fires once the
  // typing settles and only when the local + server search came up empty.
  const autoLookedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lookupQuery) {
      autoLookedRef.current = null;
      return;
    }
    if (serverSearching || filtered.length > 0 || crmLookupQuery) return;
    if (autoLookedRef.current === lookupQuery) return;
    const t = setTimeout(() => {
      autoLookedRef.current = lookupQuery;
      setCrmLookupQuery(lookupQuery);
    }, 900);
    return () => clearTimeout(t);
  }, [lookupQuery, serverSearching, filtered.length, crmLookupQuery]);

  // All chip counts in ONE pass, memoized. Previously these were 8 separate
  // contacts.filter()/reduce() scans recomputed on every render (keystroke,
  // 10s poll, 30s nowTick, every realtime payload) = ~8× the contact count
  // in iterations per render — the biggest per-render CPU cost at 2829
  // chats. isContactWindowClosed (real-time 24h check) is now called once
  // per contact instead of up to 4×. Counts mirror the filter logic above
  // so the badges match what clicking the chip shows.
  const {
    openCount,
    closedCount,
    mineCount,
    unassignedCount,
    unreadContactCount,
    unrepliedCount,
    groupCount,
    unreadTotal,
  } = useMemo(() => {
    let open = 0,
      closed = 0,
      mine = 0,
      unassigned = 0,
      unreadContacts = 0,
      unreplied = 0,
      groups = 0,
      unreadSum = 0;
    for (const c of contacts) {
      const windowClosed = isContactWindowClosed(c, now);
      if (windowClosed) closed++;
      else open++;
      if (contactIsMine(c, currentUserId, myEmail)) mine++;
      if (!c.assigned_to) unassigned++;
      const unread = c.unread_count ?? 0;
      if (unread > 0 && !windowClosed) unreadContacts++;
      if (c.last_message_direction === "inbound") unreplied++;
      if (c.is_group) groups++;
      unreadSum += unread;
    }
    return {
      openCount: open,
      closedCount: closed,
      mineCount: mine,
      unassignedCount: unassigned,
      unreadContactCount: unreadContacts,
      unrepliedCount: unreplied,
      groupCount: groups,
      unreadTotal: unreadSum,
    };
  }, [contacts, currentUserId, myEmail, now]);

  const hasFilters =
    statusFilter !== "all" ||
    assigneeFilter !== "all" ||
    unreadOnly ||
    unrepliedOnly ||
    oldestFirst ||
    !!query ||
    selectedLabelIds.size > 0;

  // Scroll hint for the chip strip — only show fade + arrow on the side(s)
  // that actually have hidden content.
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 4);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  function scrollChips(dir: "left" | "right") {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === "right" ? 120 : -120, behavior: "smooth" });
  }

  // Single source of truth for chip rendering — used both in the
  // single-row strip and in the wrap-grid that drops down when the
  // operator clicks the overflow chevron. When `collapseAfter` is true,
  // selecting a chip also closes the dropdown.
  function renderChip(key: string, collapseAfter: boolean): React.ReactNode {
    const wrap = (fn: () => void) =>
      collapseAfter
        ? () => {
            fn();
            setChipsExpanded(false);
          }
        : fn;
    switch (key) {
      case "Groups":
        return (
          <Chip
            label="Groups"
            count={groupCount}
            active={groupsView}
            onClick={wrap(() => setGroupsView((v) => !v))}
          />
        );
      case "All":
        return (
          <Chip
            label="All"
            count={contacts.length}
            active={statusFilter === "all"}
            onClick={wrap(() => setStatusFilter("all"))}
          />
        );
      case "Open":
        return (
          <Chip
            label="Active"
            count={openCount}
            active={statusFilter === "open"}
            onClick={wrap(() =>
              setStatusFilter(statusFilter === "open" ? "all" : "open"),
            )}
          />
        );
      case "Closed":
        return (
          <Chip
            label="Closed"
            count={closedCount}
            active={statusFilter === "closed"}
            onClick={wrap(() =>
              setStatusFilter(statusFilter === "closed" ? "all" : "closed"),
            )}
          />
        );
      case "Mine":
        return (
          <Chip
            label="Mine"
            // When the chip is on, show the real server-walked total (not the
            // loaded-slice count) so the badge matches the list. While the walk
            // is still loading, fall back to the slice count.
            count={
              assigneeFilter === "mine" && mineContacts
                ? mineContacts.length
                : mineCount
            }
            active={assigneeFilter === "mine"}
            onClick={wrap(() =>
              setAssigneeFilter(assigneeFilter === "mine" ? "all" : "mine"),
            )}
            disabled={!currentUserId && !DEMO_MODE}
          />
        );
      case "Unassigned":
        return (
          <Chip
            label="Unassigned"
            // When the chip is on, show the full server-walked total (not
            // the loaded-slice count) so the badge matches the list.
            count={
              assigneeFilter === "unassigned"
                ? unassignedContacts
                  ? unassignedContacts.length
                  : unassignedLoading
                    ? undefined
                    : unassignedCount
                : unassignedCount
            }
            active={assigneeFilter === "unassigned"}
            onClick={wrap(() =>
              setAssigneeFilter(
                assigneeFilter === "unassigned" ? "all" : "unassigned",
              ),
            )}
          />
        );
      case "Unread":
        return (
          <Chip
            label="Unread"
            count={unreadContactCount}
            active={unreadOnly}
            onClick={wrap(() => setUnreadOnly((v) => !v))}
            highlight
          />
        );
      case "Unreplied":
        return (
          <Chip
            label="Unreplied"
            // Once the chip is on we have the full server-fetched set — show
            // its real total; otherwise fall back to the loaded-page estimate.
            count={
              unrepliedOnly && unrepliedContacts
                ? unrepliedContacts.length
                : unrepliedLoading
                  ? undefined
                  : unrepliedCount
            }
            active={unrepliedOnly}
            onClick={wrap(() => setUnrepliedOnly((v) => !v))}
            highlight
          />
        );
      case "OldFirst":
        return (
          <Chip
            label="Old → New"
            active={oldestFirst}
            // Triage view — turning it on also filters to Unreplied so the
            // longest-waiting UNanswered chats surface first (not replied ones).
            onClick={wrap(() =>
              setOldestFirst((v) => {
                const next = !v;
                if (next) setUnrepliedOnly(true);
                return next;
              }),
            )}
            highlight
          />
        );
      default:
        return null;
    }
  }

  return (
    <aside
      className="relative flex h-full w-full md:w-[280px] lg:w-[300px] xl:w-[340px] flex-col bg-card shrink-0"
      style={{
        // Premium soft drop-shadow on the right edge — gives subtle depth
        // between the contact panel and the chat area, replacing the hard
        // 1px border. This is the pattern Linear/Notion/Intercom use to
        // separate panels without harsh dividers.
        boxShadow:
          "1px 0 0 hsl(var(--border) / 0.6), 8px 0 24px -12px rgba(15, 23, 42, 0.08), 4px 0 8px -4px rgba(15, 23, 42, 0.04)",
      }}
    >
      <div className="border-b p-3 space-y-2.5">
        {/* Label filter — sits ABOVE the search box, single horizontal
            row with overflow-x scroll + right-arrow drag to reveal more
            labels when the strip can't fit them all. Operator preference:
            workflow labels deserve the most discoverable position. */}
        {labels && labels.length > 0 ? (
          <LabelFilterStrip
            labels={labels}
            selected={selectedLabelIds}
            onToggle={(id) =>
              setSelectedLabelIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onClear={() => setSelectedLabelIds(new Set())}
          />
        ) : null}

        {/* Search */}
        <label className="topbar-search flex h-9 w-full items-center gap-2 rounded-full border border-input bg-secondary/60 px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, number, tag, lead # or stage"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <span className="text-base leading-none">×</span>
            </button>
          ) : null}
          {/* CRM-style lead table (Manage Leads) — opens a full-screen grid. */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setTableOpen(true);
            }}
            className="ml-1 text-muted-foreground hover:text-emerald-700"
            title="CRM list view"
            aria-label="Open lead table"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </label>

        {tableOpen ? <LeadTableView onClose={() => setTableOpen(false)} /> : null}

        {/* Cross-CRM lookup — appears when the query is a phone / lead
            number. Opens a modal probing both LeadSquared accounts. */}
        {lookupQuery && !DEMO_MODE ? (
          <button
            type="button"
            onClick={() => setCrmLookupQuery(lookupQuery)}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-[12px] font-semibold text-violet-700 transition hover:bg-violet-100"
          >
            <Database className="h-3.5 w-3.5" />
            Look up &ldquo;{lookupQuery}&rdquo; in both CRMs
          </button>
        ) : null}

        {crmLookupQuery ? (
          <CrmLookupModal
            query={crmLookupQuery}
            onClose={() => setCrmLookupQuery(null)}
          />
        ) : null}

        {/* Filter chips — single-line scroll strip with smart fade/arrow hints.
            Each chip is wrapped in a draggable handle so the operator can
            reorder the strip; order persists via localStorage. */}
        <div className="relative">
          <div ref={stripRef} className="chip-strip">
            {chipOrder.filter((k) => visibleChips.has(k)).map((key) => {
              const chip = renderChip(key, false);
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={(e) => {
                    dragChipRef.current = key;
                    e.dataTransfer.effectAllowed = "move";
                    // Required by Firefox to actually start the drag.
                    e.dataTransfer.setData("text/plain", key);
                  }}
                  onDragEnd={() => {
                    dragChipRef.current = null;
                    setDragOverChip(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragChipRef.current) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverChip !== key) setDragOverChip(key);
                  }}
                  onDragLeave={() => {
                    if (dragOverChip === key) setDragOverChip(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragChipRef.current;
                    if (from) reorderChips(from, key);
                    dragChipRef.current = null;
                    setDragOverChip(null);
                  }}
                  className={cn(
                    "shrink-0 cursor-grab active:cursor-grabbing transition",
                    dragOverChip === key && dragChipRef.current && dragChipRef.current !== key
                      ? "ring-2 ring-emerald-400 ring-offset-1 rounded-full"
                      : "",
                  )}
                  title="Drag to reorder"
                >
                  {chip}
                </div>
              );
            })}
            {/* Gear — opens the chip-visibility menu */}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setChipMenuOpen((v) => !v)}
                aria-label="Customise filter chips"
                title="Customise filters"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground transition"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
              {chipMenuOpen ? (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setChipMenuOpen(false)}
                    className="fixed inset-0 z-40"
                  />
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-lg border bg-card shadow-lg">
                    <div className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Show filters
                    </div>
                    <ul className="py-1">
                      {ALL_CHIP_KEYS.map((key) => (
                        <li key={key}>
                          <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary">
                            <input
                              type="checkbox"
                              checked={visibleChips.has(key)}
                              onChange={() => toggleChipVisible(key)}
                              className="h-3.5 w-3.5 accent-emerald-600"
                            />
                            <span>{CHIP_LABEL[key] ?? key}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* Left scroll hint */}
          {canScrollLeft ? (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent" />
              <button
                type="button"
                onClick={() => scrollChips("left")}
                aria-label="Scroll filters left"
                className="absolute left-0 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground transition"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}

          {/* Right-edge overflow chevron — collapses the row into a
              wrap-grid panel below instead of horizontal scroll. Stays
              visible whenever the strip is in a collapsed state with
              overflow content, OR whenever the expanded panel is open
              (so the operator can re-collapse). */}
          {canScrollRight || chipsExpanded ? (
            <>
              <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent" />
              <button
                type="button"
                onClick={() => setChipsExpanded((v) => !v)}
                aria-label={chipsExpanded ? "Hide extra filters" : "Show all filters"}
                aria-expanded={chipsExpanded}
                className="absolute right-0 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground transition"
              >
                {chipsExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </>
          ) : null}
        </div>

        {/* Expanded panel — all visible chips in a wrap-grid below the
            strip. Selecting any chip closes the panel automatically. */}
        {chipsExpanded ? (
          <div className="border-t bg-card px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {chipOrder
              .filter((k) => visibleChips.has(k))
              .map((key) => (
                <div
                  key={key}
                  draggable
                  onDragStart={(e) => {
                    dragChipRef.current = key;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", key);
                  }}
                  onDragEnd={() => {
                    dragChipRef.current = null;
                    setDragOverChip(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragChipRef.current) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverChip !== key) setDragOverChip(key);
                  }}
                  onDragLeave={() => {
                    if (dragOverChip === key) setDragOverChip(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragChipRef.current;
                    if (from) reorderChips(from, key);
                    dragChipRef.current = null;
                    setDragOverChip(null);
                  }}
                  title="Drag to reorder · gear se hide/show"
                  className={cn(
                    "shrink-0 cursor-grab active:cursor-grabbing transition",
                    dragOverChip === key && dragChipRef.current && dragChipRef.current !== key
                      ? "ring-2 ring-emerald-400 ring-offset-1 rounded-full"
                      : "",
                  )}
                >
                  {renderChip(key, true)}
                </div>
              ))}
            {/* Edit-filters toggle — reveals the add/remove checklist below. */}
            <button
              type="button"
              onClick={() => setEditChips((v) => !v)}
              title="Add / remove filters"
              className={cn(
                "ml-1 inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold transition",
                editChips
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "bg-card text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Settings2 className="h-3.5 w-3.5" /> Edit
            </button>
          </div>

          {/* Add / remove filters — tick the chips you want to keep. */}
          {editChips ? (
            <div className="mt-2 rounded-lg border bg-secondary/30 p-2">
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Filters dikhao / hatao
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 sm:grid-cols-3">
                {ALL_CHIP_KEYS.map((key) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-card">
                    <input
                      type="checkbox"
                      checked={visibleChips.has(key)}
                      onChange={() => toggleChipVisible(key)}
                      className="h-3.5 w-3.5 accent-emerald-600"
                    />
                    <span>{CHIP_LABEL[key] ?? key}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          </div>
        ) : null}

        {/* Counts + Clear */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="font-semibold text-foreground">{filtered.length}</span>
            <span>of {totalAccessible ?? contacts.length} conversations</span>
            {unreadTotal > 0 ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-200">
                {unreadTotal} unread
              </span>
            ) : null}
          </span>
          {hasFilters ? (
            <button
              type="button"
              onClick={() => {
                setStatusFilter("all");
                setAssigneeFilter("all");
                setUnreadOnly(false);
                setUnrepliedOnly(false);
                setOldestFirst(false);
                setQuery("");
                setSelectedLabelIds(new Set());
              }}
              className="font-medium text-primary hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="inbox-scroll flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          // Within 320px of the bottom → reveal more. First grow the
          // client-side window over rows already loaded; only once it's
          // exhausted do we pull the next server page. Skipped under a
          // stage filter — that view is loaded whole upfront.
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) {
            if (visibleCount < filtered.length) {
              setVisibleCount((n) => n + VISIBLE_STEP);
            } else if (!stageFilter && !unrepliedOnly && assigneeFilter !== "mine") {
              // Mine/stage/unreplied are fully server-walked already — don't
              // page the unfiltered list under them.
              void loadMore();
            }
          }
        }}
      >
        {stageFilter && stageLoading ? (
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            Loading {stageFilter}…
          </div>
        ) : unrepliedOnly && unrepliedLoading && filtered.length === 0 ? (
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading unreplied…
            </span>
          </div>
        ) : assigneeFilter === "mine" && mineLoading && filtered.length === 0 ? (
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your chats…
            </span>
          </div>
        ) : assigneeFilter === "unassigned" && unassignedLoading ? (
          // Hold the WHOLE list until every page is fetched — the server
          // resolves the real LSQ owner (assigned vs unassigned) per page, so
          // a half-loaded list would briefly show leads that are actually
          // already owned. Wait for the complete, accurate set.
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading unassigned…
            </span>
          </div>
        ) : (!filterHydrated || activeNumberIds === null) &&
          (DEMO_MODE || contacts.length === 0) ? (
          // First-paint guard, but ONLY when there's nothing to show yet.
          // The active-number filter is seeded from the cached authoritative
          // set (or initialContacts), so when we already have rows we render
          // them immediately — no "Loading inbox…" → "No contacts" → chats
          // flash on refresh. The async /api/business-numbers fetch can only
          // trim a stale toggled-off number, not reveal a broader payload.
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            Loading inbox…
          </div>
        ) : query.trim().length >= 3 && serverSearching && filtered.length === 0 ? (
          // Searching the full DB for a number/name not in the loaded slice —
          // show a spinner instead of a premature "No contacts match".
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid h-40 place-items-center px-4 text-center text-sm text-muted-foreground">
            {groupsView ? (
              <div className="space-y-3">
                <p>No groups synced yet.</p>
                <button
                  type="button"
                  onClick={syncGroups}
                  disabled={syncingGroups}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {syncingGroups ? "Syncing…" : "Sync groups from WhatsApp"}
                </button>
              </div>
            ) : contacts.length === 0 ? (
              "No conversations yet. Send a message to start one."
            ) : filterHydrated ? (
              "No contacts match your filters."
            ) : (
              // Pre-hydration with rows present but transiently filtered to
              // zero (active-number set swapping in) — stay blank, don't
              // flash a misleading "No contacts match".
              ""
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/40 pb-1">
            {/* Server-search still in flight but we already have local
                matches — a thin top bar signals more results are loading. */}
            {query.trim().length >= 3 && serverSearching ? (
              <li className="flex items-center justify-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching all conversations…
              </li>
            ) : null}
            {/* AnimatePresence + layout: a chat that gets a new message
                smoothly slides to the top instead of jump-cutting, and
                genuinely new rows fade in. initial={false} means the
                first paint of the existing list does NOT animate — only
                subsequent inserts — so a 200-row inbox doesn't shimmer
                on every poll. */}
            <AnimatePresence initial={false}>
            {visible.map((c) => {
              const active = c.id === selectedId;
              const name = contactDisplayNameMasked(c, perms.mask_phone_numbers);
              const isClosed = (c.status ?? "open") === "closed";
              const isMine = contactIsMine(c, currentUserId, myEmail);
              const hasUnread = c.unread_count > 0 && !active;
              // Show "Unknown" subtitle when the only thing we know about
              // the contact is their phone number (no real name + no
              // WhatsApp profile name on file).
              const isAnonymous = !c.name?.trim() && !c.profile_name?.trim();
              // Awaiting a reply from us — last message was inbound and
              // hasn't been read in the dashboard. Drives the "Reply" CTA
              // chip on the right side of the row.
              const awaitingReply =
                c.last_message_direction === "inbound" && hasUnread;
              // Stale-unreplied — customer's last message is inbound, the
              // 24h window is still open, AND it's been more than 10
              // minutes. Triggers a pulsing highlight on the row so
              // operators can't miss replies that are timing out.
              const staleUnreplied =
                mounted &&
                c.last_message_direction === "inbound" &&
                !isContactWindowClosed(c, now) &&
                !!c.last_message_at &&
                Date.now() - new Date(c.last_message_at).getTime() > 10 * 60 * 1000;
              return (
                <motion.li
                  key={c.id}
                  layout
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(c)}
                    className={cn(
                      "relative flex w-full items-start gap-3 px-4 py-3.5 text-left transition md:gap-2.5 md:px-3 md:py-3",
                      active ? "contact-active" : "hover:bg-secondary/60",
                      isClosed && !active && "opacity-70",
                      staleUnreplied && !active && "stale-unreplied",
                    )}
                  >
                    <div className="relative shrink-0">
                      {/* Manually fork on avatar_url so the initials
                          render instantly after a "Remove photo" or
                          a "Set as profile" toggle. Letting Radix
                          Avatar handle both states leaves a stale
                          loaded-image-context that suppresses the
                          fallback for ~600ms — long enough that the
                          ContactList row visibly lags the panel. */}
                      {c.avatar_url ? (
                        <Avatar
                          key={c.avatar_url}
                          className={cn("h-11 w-11 md:h-9 md:w-9", active && "ring-2 ring-white shadow-sm")}
                        >
                          <AvatarImage src={c.avatar_url} alt="" />
                          <AvatarFallback className="text-sm md:text-xs">
                            {contactInitials(c)}
                          </AvatarFallback>
                        </Avatar>
                      ) : (
                        <div
                          className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700 md:h-9 md:w-9 md:text-xs",
                            active && "ring-2 ring-white shadow-sm",
                          )}
                        >
                          {contactInitials(c)}
                        </div>
                      )}
                      {hasUnread ? (
                        <span
                          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-600 text-white text-[9px] font-semibold flex items-center justify-center ring-2 ring-card"
                          aria-label={`${c.unread_count} unread`}
                        >
                          {c.unread_count > 99 ? "99+" : c.unread_count}
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            "flex items-center gap-1 min-w-0 text-[15px] md:text-sm",
                            hasUnread ? "font-semibold text-foreground" : "font-medium",
                          )}
                        >
                          {/* Name truncates on its own so a long name can
                              never clip the closed-check or the stage chip
                              — those stay whole as shrink-0 siblings. */}
                          <span className="truncate min-w-0">{name}</span>
                          {isClosed ? (
                            <Check className="h-3 w-3 text-emerald-600 shrink-0" aria-label="Closed" />
                          ) : null}
                          {/* LSQ stage chip — comes from contacts.lsq_stage,
                              which is mirrored from LeadSquared whenever the
                              contact-details panel fetches the lead. Sits
                              right after the name so the agent sees pipeline
                              stage at a glance without opening the chat. */}
                          {c.lsq_stage ? (
                            (() => {
                              const t = toneForStage(c.lsq_stage);
                              return (
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                                    t.bg,
                                    t.text,
                                    t.ring,
                                  )}
                                  title={`LSQ stage${c.lsq_lead_number ? ` · #${c.lsq_lead_number}` : ""}`}
                                >
                                  {c.lsq_stage}
                                </span>
                              );
                            })()
                          ) : null}
                          {/* Bot auto-blocked (off-topic / app guidelines) —
                              red flag so the agent knows the bot is muted here
                              and they must handle it manually. */}
                          {c.bot_blocked_at ? (
                            <span
                              className="inline-flex shrink-0 items-center rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200"
                              title="Bot blocked — off-topic / app guidelines. Reply manually or unblock in the chat."
                            >
                              Bot blocked
                            </span>
                          ) : null}
                        </span>
                        <RelativeTime
                          iso={c.last_message_at}
                          className={cn(
                            "shrink-0 text-xs tabular-nums whitespace-nowrap leading-none md:text-[11px]",
                            hasUnread
                              ? "font-bold text-emerald-700"
                              : "font-semibold text-muted-foreground",
                          )}
                        />
                      </div>
                      {isAnonymous ? (
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                          Unknown
                        </div>
                      ) : null}
                      <div className="flex items-center gap-1.5 min-w-0">
                        {/* Outbound delivery indicator — sits before the
                            preview so the agent can see at a glance whether
                            the customer has read the last reply. */}
                        {c.last_message_direction === "outbound" ? (
                          <PreviewTick status={c.last_message_status ?? null} />
                        ) : null}
                        <span
                          className={cn(
                            "truncate text-[13px] flex-1 min-w-0 md:text-xs",
                            hasUnread ? "text-foreground/85" : "text-muted-foreground",
                          )}
                        >
                          {c.last_message_preview ? interaktTemplatePreview(c.last_message_preview) : "—"}
                        </span>
                        {awaitingReply ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-100"
                            title="Customer is waiting for a reply"
                          >
                            <CornerDownLeft className="h-3 w-3" />
                            Reply
                          </span>
                        ) : hasUnread ? (
                          <Badge>{c.unread_count}</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 pt-0.5">
                        {c.assigned_to_email ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
                              isMine
                                ? "bg-brand-50 text-brand-700 ring-brand-100"
                                : "bg-secondary text-muted-foreground ring-border",
                            )}
                            title={`Assigned to ${c.assigned_to_email}`}
                          >
                            {isMine
                              ? "You"
                              : memberDisplayName(
                                  members.byEmail.get(
                                    c.assigned_to_email.toLowerCase(),
                                  ) ?? null,
                                ) ?? shortEmail(c.assigned_to_email)}
                          </span>
                        ) : c.lsq_owner_name ? (
                          // No internal assignee, but the LSQ lead has an
                          // owner — show that name so the inbox mirrors who
                          // owns the lead in the CRM. Each owner gets a
                          // stable colour (hashed off their email) so the
                          // operator can tell agents apart at a glance.
                          (() => {
                            const t = toneForKey(
                              c.lsq_owner_email || c.lsq_owner_name,
                            );
                            return (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                                  t.bg,
                                  t.text,
                                  t.ring,
                                )}
                                title={`LSQ lead owner: ${c.lsq_owner_name}`}
                              >
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    t.dot,
                                  )}
                                />
                                {c.lsq_owner_name}
                              </span>
                            );
                          })()
                        ) : (
                          <span className="inline-flex rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                            Unassigned
                          </span>
                        )}
                        {(() => {
                          const bn =
                            c.business_phone_number_id && businessNumbersById
                              ? businessNumbersById.get(c.business_phone_number_id)
                              : null;
                          if (!bn) return null;
                          const name =
                            bn.nickname?.trim() || bn.verified_name?.trim() || "";
                          const phone = bn.display_phone_number?.trim() || "";
                          if (!name && !phone) return null;
                          // Per-number tone hashed off the bpid so each
                          // business number gets its own stable colour
                          // — operator can spot "this chat is on the
                          // Sales number" without reading the label.
                          const t = toneForNumber(c.business_phone_number_id);
                          return (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
                                t.bg,
                                t.text,
                                t.ring,
                              )}
                              title={`On ${name || phone}`}
                            >
                              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} />
                              {name ? <span className="truncate max-w-[140px]">{name}</span> : null}
                              {phone ? (
                                <span className="font-mono tabular-nums opacity-80">
                                  {phone}
                                </span>
                              ) : null}
                            </span>
                          );
                        })()}
                        {(c.tags ?? []).slice(0, 2).map((t) => (
                          <span
                            key={t}
                            className="inline-flex rounded-full bg-brand-50/70 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-100"
                          >
                            {t}
                          </span>
                        ))}
                        {(c.tags ?? []).length > 2 ? (
                          <span className="text-[10px] text-muted-foreground">
                            +{(c.tags ?? []).length - 2}
                          </span>
                        ) : null}
                        <LabelChips labelIds={c.label_ids} size="xs" />
                      </div>
                    </div>
                  </button>
                </motion.li>
              );
            })}
            </AnimatePresence>
          </ul>
        )}

        {/* Infinite-scroll footer — pulls the next page as the operator
            nears the bottom. */}
        {loadingMore ? (
          <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading more chats…
          </div>
        ) : !hasMore && contacts.length > 0 ? (
          <div className="py-3 text-center text-[11px] text-muted-foreground/60">
            That&apos;s every conversation.
          </div>
        ) : null}
      </div>

      {/* Sticky bottom footer — pinned to the panel edge (always visible)
          with a frosted/blur background so anything that scrolls beneath it
          fades softly instead of cutting off. Common premium-app pattern. */}
      <footer className="shrink-0 border-t border-border/60 bg-card/80 backdrop-blur-md px-4 py-2.5">
        <div className="flex items-center justify-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground">
          {syncDelta && syncDelta.count >= 3 ? (
            <>
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
              </span>
              <span className="uppercase text-amber-700">Syncing</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-amber-700">+{syncDelta.count} new</span>
            </>
          ) : (
            <>
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-50" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              <span className="uppercase">Up to date</span>
              <span className="text-muted-foreground/60">·</span>
              <span>
                {filtered.length}
                {(() => {
                  const total = totalAccessible ?? contacts.length;
                  return filtered.length !== total ? `/${total}` : "";
                })()}
              </span>
            </>
          )}
        </div>
      </footer>
    </aside>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
  disabled,
  highlight,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  highlight?: boolean;
}) {
  const showCount = typeof count === "number" && count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition",
        active
          ? highlight
            ? "border-amber-500 bg-amber-500 text-white"
            : "border-primary bg-primary text-primary-foreground"
          : highlight && showCount
            ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
            : "border-input bg-background text-foreground hover:bg-secondary",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {label}
      {showCount ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0 text-[10px] font-semibold",
            active
              ? "bg-white/20"
              : highlight
                ? "bg-amber-200 text-amber-900"
                : "bg-secondary text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function shortEmail(email: string): string {
  const [local] = email.split("@");
  return local.length > 10 ? local.slice(0, 10) + "…" : local;
}

// Tiny tick indicator that prefixes the message preview when the latest
// message is outbound. Mirrors WhatsApp's tick semantics:
//   - failed     → red triangle
//   - read       → emerald ✓✓ (customer saw it)
//   - delivered  → muted ✓✓
//   - sent       → muted ✓
function PreviewTick({ status }: { status: Contact["last_message_status"] }) {
  if (status === "failed") {
    return (
      <AlertTriangle
        className="h-3 w-3 shrink-0 text-rose-600"
        aria-label="Failed to send"
      />
    );
  }
  if (status === "read") {
    return (
      <CheckCheck
        className="h-3 w-3 shrink-0 text-emerald-600"
        aria-label="Read"
        strokeWidth={2.6}
      />
    );
  }
  if (status === "delivered") {
    return (
      <CheckCheck
        className="h-3 w-3 shrink-0 text-muted-foreground"
        aria-label="Delivered"
      />
    );
  }
  if (status === "sent") {
    return (
      <Check
        className="h-3 w-3 shrink-0 text-muted-foreground"
        aria-label="Sent"
      />
    );
  }
  return null;
}

// Label filter strip — single horizontal row above the search box.
// Pills overflow horizontally; a right-arrow button slides the strip
// when content exceeds the visible width. Arrow auto-hides when there's
// nothing left to scroll.
function LabelFilterStrip({
  labels,
  selected,
  onToggle,
  onClear,
}: {
  labels: Array<{ id: string; name: string; color: string | null }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function update() {
      if (!el) return;
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [labels.length]);

  // Wheel: translate vertical scroll into horizontal so mouse-wheel/trackpad
  // moves the strip sideways. Only intercept when there's somewhere to go,
  // otherwise let the event bubble up to the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      const max = el.scrollWidth - el.clientWidth;
      const next = el.scrollLeft + dx;
      if ((dx < 0 && el.scrollLeft <= 0) || (dx > 0 && el.scrollLeft >= max)) return;
      e.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, next));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [labels.length]);

  // Drag-to-scroll: press anywhere on the strip background and drag to pan.
  // We skip the drag when the press starts on a button so chip clicks still
  // toggle the filter normally.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let dragging = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;
    function onDown(e: PointerEvent) {
      if (!el) return;
      if ((e.target as HTMLElement).closest("button")) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    }
    function onMove(e: PointerEvent) {
      if (!dragging || !el) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = startLeft - dx;
    }
    function onUp(e: PointerEvent) {
      if (!el) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = "";
      // Swallow the click that follows a real drag so we don't accidentally
      // toggle the chip the pointer lifted over.
      if (moved) {
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
          el.removeEventListener("click", swallow, true);
        };
        el.addEventListener("click", swallow, true);
      }
    }
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [labels.length]);

  function nudgeLeft() {
    scrollRef.current?.scrollBy({ left: -160, behavior: "smooth" });
  }
  function nudgeRight() {
    scrollRef.current?.scrollBy({ left: 160, behavior: "smooth" });
  }

  return (
    <div className="flex items-center gap-1">
      {/* min-w-0 is the critical bit — without it the flex child refuses
          to shrink and the chip strip overflows the inbox panel
          (breaking BOTH the clipping AND the arrow-visibility math). */}
      <div className="relative min-w-0 flex-1">
        {/* Left arrow + fade — show only when scrolled past the start. */}
        {canScrollLeft ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-card to-transparent"
            />
            <button
              type="button"
              onClick={nudgeLeft}
              className="absolute left-0 top-1/2 z-20 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground"
              title="Scroll labels left"
              aria-label="Scroll labels left"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        <div
          ref={scrollRef}
          className="no-scrollbar flex items-center gap-1 overflow-x-auto cursor-grab select-none"
          style={{ scrollbarWidth: "none" }}
        >
        {labels.map((l) => {
          const isOn = selected.has(l.id);
          const c = l.color ?? "slate";
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onToggle(l.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold transition shadow-[inset_0_-1px_0_rgba(0,0,0,0.04)]",
                LABEL_FILTER_TONE[c] ?? LABEL_FILTER_TONE.slate,
                isOn
                  ? LABEL_FILTER_ACTIVE_RING[c] ?? LABEL_FILTER_ACTIVE_RING.slate
                  : "ring-1 ring-inset hover:brightness-95",
              )}
              title={isOn ? `Remove ${l.name} filter` : `Filter by ${l.name}`}
            >
              <Tag
                className={cn(
                  "h-2.5 w-2.5 shrink-0",
                  LABEL_FILTER_ICON[c] ?? LABEL_FILTER_ICON.slate,
                )}
              />
              {l.name}
              {isOn ? (
                <Check
                  className={cn(
                    "h-2.5 w-2.5 shrink-0",
                    LABEL_FILTER_ICON[c] ?? LABEL_FILTER_ICON.slate,
                  )}
                />
              ) : null}
            </button>
          );
        })}
        {selected.size > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-1 shrink-0 text-[10px] font-medium text-primary hover:underline"
          >
            Clear
          </button>
        ) : null}
        </div>
        {/* Right arrow + fade — show only when there's more to scroll. */}
        {canScrollRight ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-card to-transparent"
            />
            <button
              type="button"
              onClick={nudgeRight}
              className="absolute right-0 top-1/2 z-20 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground"
              title="Scroll labels right"
              aria-label="Scroll labels right"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
