"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { ContactList } from "@/components/ContactList";
import { ChatWindow } from "@/components/ChatWindow";
import { ContactDetailsPanel } from "@/components/ContactDetailsPanel";
import { LeadStageStrip } from "@/components/LeadStageStrip";
import { StageListView } from "@/components/StageListView";
import { createBrowserClient } from "@/lib/supabase/client";
import { subscribeAvatarChanged } from "@/lib/avatar-events";
import type { BusinessNumber, Contact } from "@/lib/types";
import { DEMO_MODE } from "@/lib/demo";
import { autoCloseStaleConversationsAction } from "@/app/(dashboard)/actions";

interface Props {
  initialContacts: Contact[];
  businessNumbers: BusinessNumber[];
  currentUserId: string | null;
  currentUserEmail: string | null;
}

const URL_PARAM = "c";

/** Read the contact id from the URL query string (?c=<uuid>). On the
 *  server we'd see no `window`; the initial state falls back to null
 *  and the post-mount effect hydrates from the URL. */
function readContactIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(URL_PARAM);
}

export function DashboardView({ initialContacts, businessNumbers, currentUserId, currentUserEmail }: Props) {
  const [selected, setSelected] = useState<Contact | null>(null);
  // When a ?c=<uuid> param is present at mount time we don't render
  // the empty inbox state — operator sees a centred spinner until the
  // contact resolves from initialContacts or Supabase. Defaults to
  // true only when the URL actually carries a contact id; without one
  // we fall through to the regular empty state immediately.
  const [hydrating, setHydrating] = useState<boolean>(() =>
    Boolean(readContactIdFromUrl()),
  );
  const [numbers, setNumbers] = useState<BusinessNumber[]>(businessNumbers);
  // Tablet/mobile only — the contact-details panel slides in as a drawer.
  // On lg+ the panel is always docked and this is ignored.
  const [panelOpen, setPanelOpen] = useState(false);
  // LSQ lead-stage filter from the colour strip above the inbox.
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  // Stage list-view modal — the strip's "Open in list view" choice.
  // `listStage` = which stage's modal is up; `listMinimized` parks it
  // as a bottom-right pill.
  const [listStage, setListStage] = useState<string | null>(null);
  const [listMinimized, setListMinimized] = useState(false);

  // Hydrate the selected contact from `?c=<uuid>` on first mount so a
  // page refresh / direct link lands the operator back on the same
  // chat. We match against `initialContacts` first (no extra fetch);
  // if the contact isn't in the initial slice (e.g. it's older /
  // archived) we fetch the row directly.
  //
  // Runs ONCE on mount only — re-firing on `selected` change would
  // race the URL-sync effect below: pressing the mobile back arrow
  // calls setSelected(null), and if this hydrator runs before the URL
  // is cleared, it reads the stale ?c=… and re-selects the contact —
  // making the back button look broken.
  useEffect(() => {
    const id = readContactIdFromUrl();
    if (!id) {
      setHydrating(false);
      return;
    }
    const inMemory = initialContacts.find((c) => c.id === id);
    if (inMemory) {
      setSelected(inMemory);
      setHydrating(false);
      return;
    }
    if (DEMO_MODE) {
      setHydrating(false);
      return;
    }
    const supabase = createBrowserClient();
    void supabase
      .from("contacts")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setSelected(data as Contact);
        setHydrating(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the selected contact into the URL using replaceState so we
  // don't litter the browser back-stack with one entry per chat the
  // operator clicks through. Refresh restores from the URL (above).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selected) {
      url.searchParams.set(URL_PARAM, selected.id);
    } else {
      url.searchParams.delete(URL_PARAM);
    }
    window.history.replaceState(null, "", url.toString());
  }, [selected]);

  // Wrapper around setSelected so callers don't have to know about
  // the URL sync behaviour.
  const handleSelect = useCallback((c: Contact | null) => {
    setSelected(c);
  }, []);

  // Switching/closing a chat dismisses the mobile details drawer.
  useEffect(() => {
    setPanelOpen(false);
  }, [selected?.id]);

  // Auto-close — sweeps conversations whose 24-hour customer-service window
  // has expired and flips them back to "closed". Runs:
  //   1. Once on every dashboard mount (no sessionStorage gate — needs to
  //      catch chats that got reopened mid-session by Magic Message sends,
  //      manual Reopen clicks, etc.)
  //   2. Then every 5 minutes while the dashboard is open, so a chat whose
  //      window expires DURING the session gets tidied up without needing a
  //      page reload.
  //
  // Webhook auto-reopens on a fresh inbound (sets status='open'), so the
  // natural reopen cycle when the customer replies still works.
  useEffect(() => {
    if (DEMO_MODE) return;
    const sweep = () =>
      autoCloseStaleConversationsAction()
        .then((result) => {
          if (result.closed > 0 && process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.log(`[auto-close] ${result.closed} stale conversation(s) closed`);
          }
        })
        .catch(() => {
          /* best-effort — failures here shouldn't block the dashboard */
        });
    sweep();
    const interval = setInterval(sweep, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Clear `selected` when its owning business number gets toggled off
  // or removed. Without this the chat panel keeps rendering the old
  // contact even though the inbox list shows "0 conversations" — the
  // operator sees a ghost chat that no card highlights.
  useEffect(() => {
    if (DEMO_MODE) return;
    async function reconcile() {
      try {
        const res = await fetch("/api/business-numbers", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          numbers?: Array<{ phone_number_id: string; is_active: boolean }>;
        };
        const active = new Set(
          (j.numbers ?? [])
            .filter((n) => n.is_active)
            .map((n) => n.phone_number_id),
        );
        setSelected((cur) => {
          if (!cur) return cur;
          const bpid = cur.business_phone_number_id;
          if (!bpid) return cur;
          return active.has(bpid) ? cur : null;
        });
      } catch {
        /* keep current selection on transient errors */
      }
    }
    // NOTE: only reconcile when the operator actually toggles a number
    // off mid-session — NOT on mount. The mount-time pass used to race the
    // URL `?c=` hydrator and blank a deliberately-opened chat (e.g. from
    // CRM-lookup "Open chat") whenever that contact's number happened to
    // be toggled off in the operator's view.
    window.addEventListener("business-numbers-changed", reconcile);
    return () => window.removeEventListener("business-numbers-changed", reconcile);
  }, []);

  // Live updates if a brand-new business number first appears mid-session
  useEffect(() => {
    if (DEMO_MODE) return;
    const supabase = createBrowserClient();
    const channel = supabase
      .channel("business-numbers")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "business_numbers" },
        (payload) => {
          setNumbers((prev) => {
            if (payload.eventType === "DELETE") {
              return prev.filter((n) => n.phone_number_id !== (payload.old as BusinessNumber).phone_number_id);
            }
            const next = payload.new as BusinessNumber;
            const without = prev.filter((n) => n.phone_number_id !== next.phone_number_id);
            return [...without, next];
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Keep the SELECTED contact in sync with row updates (avatar_url
  // change after a Remove, name change from extraction, lsq_stage
  // bump, etc.). ContactList has its own subscription for the row
  // list; DashboardView holds the `selected` snapshot which would
  // otherwise stay stale and feed an outdated `contact.avatar_url`
  // into ChatWindow + ContactDetailsPanel until the operator
  // clicked the row again.
  // Cross-component avatar-change broadcast. Catches the synchronous
  // event the uploader / lightbox emit on success, so ChatWindow's
  // header avatar (driven off `selected`) flips immediately — no
  // wait for realtime / polling.
  useEffect(() => {
    return subscribeAvatarChanged(({ contactId, avatarUrl }) => {
      setSelected((cur) =>
        cur && cur.id === contactId ? { ...cur, avatar_url: avatarUrl } : cur,
      );
    });
  }, []);

  // Re-subscribe only when the selected ID actually changes — using
  // `selected` (object) as dep would tear down + recreate the channel
  // every time setSelected swaps in a fresh row from the same
  // subscription, which is wasteful and can drop in-flight events.
  const selectedId = selected?.id ?? null;

  // Polling fallback — Supabase realtime filtered subscriptions can
  // silently drop events under some RLS / publication configs (we
  // saw this with the contact-name update from the AI extraction
  // pipeline: ContactList's unfiltered sub caught it, DashboardView's
  // filtered one didn't, so chat-list row refreshed but ChatWindow
  // header / panel name stayed stale). Re-fetching the selected row
  // every 5s reconciles whatever realtime missed.
  useEffect(() => {
    if (DEMO_MODE || !selectedId) return;
    const supabase = createBrowserClient();
    let cancelled = false;
    async function poll() {
      const { data } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", selectedId!)
        .maybeSingle();
      if (cancelled || !data) return;
      const next = data as Contact;
      setSelected((cur) => {
        if (!cur || cur.id !== next.id) return cur;
        const watched: Array<keyof Contact> = [
          "name",
          "profile_name",
          "avatar_url",
          "tags",
          "status",
          "assigned_to",
          "lsq_stage",
          "lsq_lead_number",
          "lsq_owner_name",
          "lsq_prospect_id",
        ];
        const changed = watched.some((k) => cur[k] !== next[k]);
        return changed ? next : cur;
      });
    }
    // 12s poll — picks up name/tags/avatar/LSQ updates the realtime
    // subscription might miss without burning a /contacts/<id> fetch
    // every 5s per open chat.
    const id = setInterval(poll, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  useEffect(() => {
    if (DEMO_MODE || !selectedId) return;
    const supabase = createBrowserClient();
    const channel = supabase
      .channel(`contact-detail-${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "contacts",
          filter: `id=eq.${selectedId}`,
        },
        (payload) => {
          const next = payload.new as Contact;
          setSelected((cur) => {
            if (!cur || cur.id !== next.id) return cur;
            // Only re-render when something the panel/chat header
            // actually displays has changed. Without this guard,
            // every webhook tick (last_message_at, unread_count,
            // last_message_status) bumps `selected` → ChatWindow +
            // ContactDetailsPanel re-render → visible micro-blink.
            const watched: Array<keyof Contact> = [
              "name",
              "profile_name",
              "avatar_url",
              "tags",
              "status",
              "assigned_to",
              "lsq_stage",
              "lsq_lead_number",
              "lsq_owner_name",
              "lsq_prospect_id",
            ];
            const changed = watched.some((k) => cur[k] !== next[k]);
            return changed ? next : cur;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedId]);

  const numbersById = useMemo(() => {
    const map = new Map<string, BusinessNumber>();
    for (const n of numbers) map.set(n.phone_number_id, n);
    return map;
  }, [numbers]);

  const selectedBusiness = selected?.business_phone_number_id
    ? numbersById.get(selected.business_phone_number_id) ?? null
    : null;

  return (
    <div className="flex h-full min-w-0">
      {/* Contact list — full height on the left. The stage strip no
          longer sits above it, so the list runs top-to-bottom. */}
      <div className={selected ? "hidden md:flex md:w-[280px] lg:w-[300px] xl:w-[340px]" : "flex w-full md:w-[280px] lg:w-[300px] xl:w-[340px]"}>
        <ContactList
          initialContacts={initialContacts}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
          businessNumbersById={numbersById}
          stageFilter={stageFilter}
        />
      </div>

      {/* Right section — stage strip on top, then chat + details. The
          strip starts where the contact list ends. */}
      <div
        className={
          selected
            ? "flex min-w-0 flex-1 flex-col"
            : "hidden md:flex min-w-0 flex-1 flex-col"
        }
      >
        {/* Stage strip — hidden on phone while a chat is open so the
            conversation gets the full height; still there on tablet+. */}
        <div className={selected ? "hidden md:block" : "block"}>
          <LeadStageStrip
            selected={stageFilter}
            onSelect={setStageFilter}
            onOpenList={(stage) => {
              setListStage(stage);
              setListMinimized(false);
            }}
          />
        </div>
        {hydrating && !selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-secondary/30">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 min-w-0">
            <div className="flex flex-1 min-w-0">
              {/* key={contact.id} forces a clean remount when the operator
                  switches contacts. Without it, the chat window + details
                  panel reuse internal state (LSQ lead, photos, notes,
                  stale name) from the previous selection and the right
                  rail can show "ghost" data for ~1s while hooks settle. */}
              <ChatWindow
                key={selected?.id ?? "empty"}
                contact={selected}
                businessNumber={selectedBusiness}
                currentUserId={currentUserId}
                onBack={() => handleSelect(null)}
                onOpenPanel={() => setPanelOpen(true)}
              />
            </div>
            <ContactDetailsPanel
              key={selected?.id ?? "empty"}
              contact={selected}
              businessNumber={selectedBusiness}
              currentUserId={currentUserId}
              mobileOpen={panelOpen}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        )}
      </div>

      {listStage ? (
        <StageListView
          stage={listStage}
          minimized={listMinimized}
          onMinimize={() => setListMinimized(true)}
          onRestore={() => setListMinimized(false)}
          onClose={() => setListStage(null)}
          onSelectContact={(c) => {
            handleSelect(c);
            setListMinimized(true);
          }}
        />
      ) : null}
    </div>
  );
}
