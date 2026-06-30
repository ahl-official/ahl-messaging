"use client";

// Cross-component avatar-change broadcast. Realtime + 4s polling is
// the eventual-consistency path; this fires synchronously on the
// click that did the change so all three avatar surfaces (chat list
// row, chat header, contact-details panel) flip in the same frame.
//
// Anyone who renders a contact avatar listens to `subscribe()` and
// patches their local state when the event matches their contact id.
// Anyone who SUCCESSFULLY changes an avatar (upload, set-as-profile,
// remove) calls `emit()` with the new url (or null on remove).

const EVENT_NAME = "qht:contact-avatar-changed";

export interface AvatarChangedDetail {
  contactId: string;
  avatarUrl: string | null;
}

export function emitAvatarChanged(detail: AvatarChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AvatarChangedDetail>(EVENT_NAME, { detail }),
  );
}

export function subscribeAvatarChanged(
  handler: (detail: AvatarChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  function on(e: Event) {
    const ce = e as CustomEvent<AvatarChangedDetail>;
    if (ce.detail && typeof ce.detail.contactId === "string") {
      handler(ce.detail);
    }
  }
  window.addEventListener(EVENT_NAME, on);
  return () => window.removeEventListener(EVENT_NAME, on);
}
