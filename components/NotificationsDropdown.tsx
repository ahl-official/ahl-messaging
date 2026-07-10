"use client";

// Floating bottom-right notification centre. Bell button shows the
// current pending count; clicking opens a popover with one row per
// pending event (inbound message / inbound call), most recent at the
// top. Each row navigates to the chat on click and clears itself; a
// "Clear all" button at the foot dismisses every row in one shot.
//
// Backed by lib/notifications-store — survives page reloads via
// localStorage, so a missed ping at 4pm is still visible when the
// operator opens their laptop at 6pm.

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, MessageSquare, Phone, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { emitFabClose, emitFabOpen, useFabsFlat } from "@/lib/fab-layout";
import {
  dockHideClasses,
  useFloatingDock,
} from "@/components/FloatingDockToggle";
import {
  clearAllNotifications,
  dismissNotification,
  dismissNotificationsForContact,
  getNotificationsSnapshot,
  subscribeNotifications,
  type PersistentNotification,
} from "@/lib/notifications-store";

function formatAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function NotificationsDropdown() {
  const [items, setItems] = useState<PersistentNotification[]>(() =>
    getNotificationsSnapshot(),
  );
  const [open, setOpen] = useState(false);
  // `items` is seeded from a localStorage snapshot, which is empty during SSR
  // but populated on the client's first render — rendering the count badge off
  // it directly trips a hydration mismatch (<span> in <button>). Gate the badge
  // on mount so server + first client render agree (no badge), then reveal it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const flat = useFabsFlat();
  const { collapsed: dockCollapsed, mounted: dockMounted } = useFloatingDock();

  useEffect(() => {
    if (open) emitFabOpen("bell");
    else emitFabClose("bell");
    return () => emitFabClose("bell");
  }, [open]);

  useEffect(() => subscribeNotifications((next) => setItems([...next])), []);

  // Close when clicking outside the panel.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!panelRef.current) return;
      if (e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const navigateToChat = useCallback((contactId: string) => {
    // Clear every notification tied to this contact in one shot — the
    // operator is opening the chat, so all pending pings are "handled".
    dismissNotificationsForContact(contactId);
    setOpen(false);
    if (typeof window === "undefined") return;
    const url = `/dashboard?c=${encodeURIComponent(contactId)}`;
    // Same target whether on /dashboard or not — keeps the URL in sync
    // so DashboardView's `?c=` hydration opens the right chat.
    window.location.href = url;
  }, []);

  const total = mounted ? items.length : 0;

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed z-[55] hidden md:block transition-all duration-300 ease-out",
        // Bell is the anchor — it stays at the right-5 column in both
        // modes; only the AI + new-chat FABs swing into a horizontal
        // row beside it when any popover is open.
        flat ? "bottom-5 right-5" : "bottom-5 right-5",
        dockHideClasses(dockCollapsed, dockMounted),
      )}
    >
      {open ? (
        <div className="mb-2 w-[22rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-border">
          <header className="flex items-center justify-between border-b bg-secondary/40 px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Notifications · {total}
            </span>
            {total > 0 ? (
              <button
                type="button"
                onClick={() => clearAllNotifications()}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Clear all notifications"
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </button>
            ) : null}
          </header>
          <ul className="max-h-[60vh] divide-y overflow-auto">
            {items.length === 0 ? (
              <li className="px-4 py-10 text-center text-xs text-muted-foreground">
                You&apos;re all caught up.
              </li>
            ) : (
              items.map((n) => (
                <li
                  key={n.id}
                  className="group relative flex items-start gap-3 px-3 py-2.5 transition hover:bg-secondary/40"
                >
                  <button
                    type="button"
                    onClick={() => navigateToChat(n.contactId)}
                    className="flex flex-1 items-start gap-3 text-left"
                  >
                    <span
                      className={cn(
                        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                        n.kind === "call"
                          ? "bg-amber-50 text-amber-700 ring-amber-200"
                          : "bg-primary/10 text-primary ring-primary/25",
                      )}
                    >
                      {n.kind === "call" ? (
                        <Phone className="h-3.5 w-3.5" />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold">
                          {n.contactName}
                          {n.count > 1 ? (
                            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary">
                              +{n.count - 1}
                            </span>
                          ) : null}
                        </p>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatAgo(n.occurredAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {n.preview}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissNotification(n.id);
                    }}
                    aria-label="Dismiss"
                    className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-secondary"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-16 w-16 items-center justify-center rounded-full border bg-card text-foreground shadow-lg ring-1 ring-border transition hover:bg-secondary",
          open && "bg-secondary",
        )}
        aria-label={total > 0 ? `${total} notifications` : "Notifications"}
      >
        <Bell className="h-6 w-6" />
        {total > 0 ? (
          <span className="absolute -top-1 -right-1 inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-rose-600 px-1.5 text-[11px] font-bold text-white shadow ring-2 ring-background">
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>
    </div>
  );
}
