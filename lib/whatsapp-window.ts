// Helpers for the WhatsApp 24-hour customer service window.
//
// Meta's rule: from the moment a customer sends an inbound message to the
// business, the business has 24 hours to send free-form (non-template) replies.
// After the window expires, only approved template messages can be sent;
// sending a fresh template re-opens the window once the customer replies.
//
// We use this helper both in the chat UI (banner + composer restriction) and
// in the server action that auto-closes stale conversations.

export const WHATSAPP_WINDOW_HOURS = 24;
export const WHATSAPP_WINDOW_MS = WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000;
// Show a "closing soon" warning when this many hours are left.
export const WHATSAPP_WINDOW_WARN_HOURS = 4;

export interface WindowState {
  /** True if the business can currently send free-form messages. */
  isOpen: boolean;
  /** ISO timestamp of the most recent inbound message, if any. */
  lastInboundAt: string | null;
  /** Hours left in the window. 0 if expired or never opened. */
  hoursRemaining: number;
  /** True if the window has < WHATSAPP_WINDOW_WARN_HOURS left (still open). */
  closingSoon: boolean;
  /** True if this conversation never had any inbound message. */
  neverOpened: boolean;
}

interface MessageLike {
  direction: "inbound" | "outbound";
  timestamp: string;
}

export function getWindowState(messages: MessageLike[]): WindowState {
  let lastInboundAt: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === "inbound") {
      lastInboundAt = messages[i].timestamp;
      break;
    }
  }

  if (!lastInboundAt) {
    return {
      isOpen: false,
      lastInboundAt: null,
      hoursRemaining: 0,
      closingSoon: false,
      neverOpened: true,
    };
  }

  const elapsed = Date.now() - new Date(lastInboundAt).getTime();
  const remainingMs = WHATSAPP_WINDOW_MS - elapsed;
  const isOpen = remainingMs > 0;
  const hoursRemaining = isOpen ? remainingMs / (60 * 60 * 1000) : 0;

  return {
    isOpen,
    lastInboundAt,
    hoursRemaining,
    closingSoon: isOpen && hoursRemaining < WHATSAPP_WINDOW_WARN_HOURS,
    neverOpened: false,
  };
}

/** Format remaining hours for display. "3h 24m left" / "12m left". */
export function formatTimeLeft(hours: number): string {
  if (hours <= 0) return "expired";
  const totalMin = Math.round(hours * 60);
  if (totalMin < 60) return `${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
}
