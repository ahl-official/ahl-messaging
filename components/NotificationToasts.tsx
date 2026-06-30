"use client";

// Stacked toast notifications for inbound messages. Mounted once at
// the dashboard root; listens to the in-process notification bus
// ContactList already emits to. Each toast auto-dismisses after a few
// seconds; clicking it surfaces the chat (callback the parent wires
// in) so the operator can act without scrolling the sidebar.

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  subscribeInboundNotifications,
  type InboundNotification,
} from "@/lib/notification-events";
import { notifyDesktop } from "@/lib/desktop-notifications";

interface ToastItem extends InboundNotification {
  id: string;
}

interface Props {
  /** Optional click handler — usually wired to DashboardView's
   *  setSelected so clicking the toast opens the chat. */
  onSelect?: (contactId: string) => void;
  /** Max simultaneous toasts before the oldest gets dropped. */
  max?: number;
  /** How long each toast lingers before auto-dismiss. */
  durationMs?: number;
}

export function NotificationToasts({
  onSelect,
  max = 4,
  durationMs = 6_000,
}: Props) {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeInboundNotifications((n) => {
      // Random id keeps the same contact's repeated pings as separate
      // toasts (operators want to see the count, not have them stack
      // silently).
      const id = `${n.contactId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      setItems((cur) => {
        const next = [...cur, { ...n, id }];
        // Trim oldest when we exceed the cap.
        return next.length > max ? next.slice(next.length - max) : next;
      });
      // OS notification too — only fires when tab is hidden (the in-app
      // toast above covers the visible case). `tag` per contact so
      // repeated pings from the same chat collapse instead of stacking
      // up in the OS notification center. Permission is granted via
      // the DesktopNotifyToggle in the TopBar.
      notifyDesktop({
        title: n.contactName,
        body: n.preview || "New message",
        tag: `qht-inbound:${n.contactId}`,
        onClick: () => onSelect?.(n.contactId),
      });
    });
  }, [max, onSelect]);

  // Auto-dismiss — one timeout per item. Cleanup runs when the items
  // list shrinks (no leak risk since the timeouts only fire setItems).
  useEffect(() => {
    if (items.length === 0) return;
    const timers = items.map((it) =>
      setTimeout(() => {
        setItems((cur) => cur.filter((c) => c.id !== it.id));
      }, durationMs),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [items, durationMs]);

  const dismiss = useCallback((id: string) => {
    setItems((cur) => cur.filter((c) => c.id !== id));
  }, []);

  const handleClick = useCallback(
    (it: ToastItem) => {
      if (onSelect) {
        onSelect(it.contactId);
      } else if (typeof window !== "undefined") {
        // Layout-mounted default: navigate to /dashboard with the
        // `c` URL param DashboardView uses to seed the open chat.
        // Hard navigation when on a different route; same-page nav
        // when already on /dashboard so we don't lose realtime subs.
        const url = `/dashboard?c=${encodeURIComponent(it.contactId)}`;
        if (window.location.pathname === "/dashboard") {
          window.location.href = url;
        } else {
          window.location.href = url;
        }
      }
      dismiss(it.id);
    },
    [dismiss, onSelect],
  );

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-20 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => handleClick(it)}
          className={cn(
            "pointer-events-auto group relative flex w-full items-start gap-3 overflow-hidden rounded-xl border bg-card p-3 text-left shadow-lg ring-1 ring-black/5",
            "translate-y-0 opacity-100 transition-all duration-200",
            "hover:border-emerald-300 hover:shadow-xl",
          )}
        >
          {/* Left accent — emerald like the inbound bubbles in the chat */}
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
          />
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <MessageSquare className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 pl-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-semibold text-foreground">
                {it.contactName}
              </p>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                just now
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {it.preview || "New message"}
            </p>
          </div>
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              dismiss(it.id);
            }}
            aria-label="Dismiss"
            className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-secondary"
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
    </div>
  );
}
