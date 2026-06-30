// Tiny event bus to signal CallOverlay from elsewhere in the app
// (specifically the Call dropdown in ChatToolbar). The overlay is
// mounted at the dashboard root so it can't share React state with
// per-page components — a window-scoped CustomEvent is the
// lightest-weight bridge that doesn't pull a state library in.

const DIAL_EVENT = "qht-wa-call-dial";

export interface DialPayload {
  contactId: string;
  /** Cached so the overlay can show a name on the dialing card before
   *  it polls /active and hydrates the contact join. */
  contactName?: string | null;
}

export function emitWaCallDial(payload: DialPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DIAL_EVENT, { detail: payload }));
}

export function subscribeWaCallDial(
  fn: (payload: DialPayload) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<DialPayload>).detail;
    if (detail) fn(detail);
  };
  window.addEventListener(DIAL_EVENT, handler as EventListener);
  return () =>
    window.removeEventListener(DIAL_EVENT, handler as EventListener);
}
