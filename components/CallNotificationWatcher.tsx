"use client";

// Polls the active-call endpoint and pushes an "Incoming call" entry
// into the persistent notification store the first time we see each
// inbound ringing call. The fullscreen CallOverlay still handles the
// real-time ringing UI; this watcher exists so that AFTER the call ends
// (accepted, declined, missed, or anything in between) the operator
// still has a visible record in the bottom-right dropdown until they
// act on it.
//
// We dedupe by wa_call_id so a 30-second ring doesn't enqueue 30
// notifications. Once a call id has been seen it never re-fires for
// this tab session.

import { useEffect } from "react";
import { pushNotification } from "@/lib/notifications-store";
import { useNameOrPhoneMasker } from "@/components/PermissionsContext";
import { createBrowserClient } from "@/lib/supabase/client";

interface ActiveCallResponse {
  call?: {
    wa_call_id: string;
    contact_id: string | null;
    business_phone_number_id: string | null;
    direction: "inbound" | "outbound";
    status: string;
    start_at: string;
    contacts?: {
      id: string;
      name: string | null;
      profile_name: string | null;
      wa_id: string | null;
    } | null;
  } | null;
}

export function CallNotificationWatcher() {
  const maskName = useNameOrPhoneMasker();
  useEffect(() => {
    const seen = new Set<string>();
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/whatsapp-call/active", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as ActiveCallResponse;
        const call = json.call;
        if (!call || call.direction !== "inbound") return;
        if (call.status !== "ringing" && call.status !== "accepted") return;
        if (seen.has(call.wa_call_id)) return;
        seen.add(call.wa_call_id);

        const contact = call.contacts;
        if (!call.contact_id) return; // can't link to a chat
        pushNotification({
          kind: "call",
          contactId: call.contact_id,
          contactName: maskName(
            contact?.name?.trim() ||
              contact?.profile_name?.trim() ||
              contact?.wa_id ||
              "Unknown",
          ),
          preview: "Incoming WhatsApp call",
          businessPhoneNumberId: call.business_phone_number_id,
          occurredAt: call.start_at,
        });
      } catch {
        /* network blip — next tick retries */
      }
    }

    // First poll after a short delay so a fresh tab doesn't replay an
    // in-progress call as "new".
    const initial = setTimeout(() => void poll(), 2_000);
    // 8s poll — incoming-call detection latency stays well under
    // WhatsApp's ring window (~30s), without flooding /api/whatsapp-
    // call/active.
    const interval = setInterval(poll, 8_000);

    // Realtime — Supabase row inserts on whatsapp_calls fire poll()
    // immediately, so a freshly-ringing call surfaces within a few
    // hundred ms instead of waiting up to 8 s for the next polling
    // tick. Status changes (handled_by_user_id stamp, terminate, etc.)
    // also trigger a re-fetch so the banner hides instantly on every
    // other operator's screen the moment someone picks up.
    const supabase = createBrowserClient();
    const channel = supabase
      .channel("whatsapp-calls-watch")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_calls" },
        () => {
          void poll();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  return null;
}
