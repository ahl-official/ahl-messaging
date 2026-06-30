"use client";

// Cross-component chat-status broadcast. Same pattern as
// avatar-events: realtime + 10s polling is the eventual-consistency
// path; this fires synchronously on the click that toggled the
// status (open <-> closed) so the sidebar row drops out of the Open
// tab in the same frame the operator dismisses it.

const EVENT_NAME = "qht:contact-status-changed";

export interface ContactStatusChangedDetail {
  contactId: string;
  status: "open" | "closed";
}

export function emitContactStatusChanged(
  detail: ContactStatusChangedDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ContactStatusChangedDetail>(EVENT_NAME, { detail }),
  );
}

export function subscribeContactStatusChanged(
  handler: (detail: ContactStatusChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  function on(e: Event) {
    const ce = e as CustomEvent<ContactStatusChangedDetail>;
    if (ce.detail && typeof ce.detail.contactId === "string") {
      handler(ce.detail);
    }
  }
  window.addEventListener(EVENT_NAME, on);
  return () => window.removeEventListener(EVENT_NAME, on);
}
