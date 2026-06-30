// Tiny event bus for in-app inbound-message notifications.
//
// ContactList already chimes on new unread; this emitter lets it ALSO
// push a structured event the dashboard's toast stack can render. We
// keep it in-process (window.dispatchEvent) so there's no extra
// dependency — the same browser tab that detected the inbound is the
// one showing the toast.

export interface InboundNotification {
  contactId: string;
  contactName: string;
  preview: string;
  businessPhoneNumberId: string | null;
  occurredAt: string;
}

const EVENT = "qht:inbound-message";

export function emitInboundNotification(n: InboundNotification): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<InboundNotification>(EVENT, { detail: n }));
}

export function subscribeInboundNotifications(
  cb: (n: InboundNotification) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const ce = e as CustomEvent<InboundNotification>;
    if (ce.detail) cb(ce.detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
