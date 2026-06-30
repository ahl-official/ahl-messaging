"use client";

// App-wide inbound-message watcher. Mounted once in the dashboard
// layout so it lives across every page (Inbox, Settings, Reports,
// Templates, etc.) — not just the inbox view. Polls /api/contacts on
// a 5-second cadence, tracks each contact's last seen unread_count,
// and emits a notification event whenever a count bumps up.
//
// The actual UI surface (in-app toast + OS desktop notification) is
// owned by NotificationToasts. This component renders no DOM — it's
// just a long-running listener.
//
// Why we duplicate ContactList's polling instead of sharing it:
// ContactList only lives on the inbox route. Lifting its polling into
// here means desktop pings keep working when the operator is on
// /settings, /reports, etc. — the original ask from the operator was
// "I want notifications even with Chrome minimized". The same logic
// applies to non-inbox tabs within the dashboard.

import { useEffect } from "react";
import { emitInboundNotification } from "@/lib/notification-events";
import { playMessagePing } from "@/lib/notification";
import { pushNotification } from "@/lib/notifications-store";
import { useNameOrPhoneMasker } from "@/components/PermissionsContext";

interface ContactRow {
  id: string;
  name?: string | null;
  profile_name?: string | null;
  wa_id?: string | null;
  unread_count?: number | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  business_phone_number_id?: string | null;
}

export function GlobalInboundWatcher() {
  const maskName = useNameOrPhoneMasker();
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[GlobalInboundWatcher] mounted — polling /api/contacts every 5s");
    let cancelled = false;
    const prevUnread = new Map<string, number>();
    let primed = false;

    async function poll() {
      try {
        const res = await fetch("/api/contacts", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { contacts?: ContactRow[] };
        if (cancelled || !json.contacts) return;

        let anyNew = false;
        for (const c of json.contacts) {
          const before = prevUnread.get(c.id) ?? 0;
          const now = c.unread_count ?? 0;
          if (primed && now > before) {
            anyNew = true;
            // eslint-disable-next-line no-console
            console.log(
              `[GlobalInboundWatcher] new inbound on ${c.id} (unread ${before} → ${now})`,
            );
            const payload = {
              contactId: c.id,
              contactName: maskName(
                c.name?.trim() ||
                  c.profile_name?.trim() ||
                  c.wa_id ||
                  "Unknown",
              ),
              preview: (c.last_message_preview ?? "").slice(0, 120),
              businessPhoneNumberId: c.business_phone_number_id ?? null,
              occurredAt: c.last_message_at ?? new Date().toISOString(),
            };
            // Existing toast bus — disappears after a few seconds.
            emitInboundNotification(payload);
            // Persistent dropdown store — stays until the operator
            // opens the chat or clears it.
            pushNotification({ kind: "message", ...payload });
          }
          prevUnread.set(c.id, now);
        }
        // Single chime per tick even if multiple chats bumped — matches
        // the WhatsApp Web pattern (one ping, then look at the list).
        if (anyNew) playMessagePing();
        primed = true;
      } catch {
        // Network blip — next tick will retry.
      }
    }

    // First poll runs after a short delay so a fresh tab doesn't fire
    // an avalanche of toasts for everything currently unread (the
    // sidebar already shows badges for those — toasts are for NEW
    // arrivals). The `primed` flag handles the same protection.
    const initial = setTimeout(() => void poll(), 1_500);
    // 10s poll — paired with the inbox list polling at the same
    // cadence. With 100 operators, going from 5s → 10s halves the
    // sustained load on /api/contacts.
    const interval = setInterval(poll, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  return null;
}
