// Persistent in-app notifications store.
//
// Toasts disappear after a few seconds; this store keeps a copy of every
// inbound event around until the operator explicitly acts on it (clicks
// the row → opens the chat / clears it). Backed by localStorage so a
// page reload doesn't wipe pending pings.
//
// Module-level singleton + a tiny subscribe-on-mount hook (no zustand /
// jotai dependency — we use this pattern elsewhere in the project too).

export type NotificationKind = "message" | "call";

export interface PersistentNotification {
  /** Stable id used for de-dupe + UI keys. */
  id: string;
  kind: NotificationKind;
  /** ISO timestamp the event occurred. */
  occurredAt: string;
  /** Contact this notification belongs to. Clicking the row navigates
   *  to /dashboard?c=<contactId>. */
  contactId: string;
  contactName: string;
  /** Short preview (last message text for messages, "Incoming call" for
   *  calls). */
  preview: string;
  /** Which business number the event is on. Used to scope display when
   *  the user has multiple numbers. */
  businessPhoneNumberId: string | null;
  /** Internal counter — when the same chat fires multiple message
   *  events we collapse them into one row + show "+N" instead of
   *  stacking duplicates. */
  count: number;
}

const STORAGE_KEY = "qht:notifications:v1";
// Hard cap so a runaway burst doesn't blow up localStorage. Oldest
// notifications fall off when this is exceeded.
const MAX_NOTIFICATIONS = 200;

type Listener = (snapshot: PersistentNotification[]) => void;

let state: PersistentNotification[] = [];
const listeners = new Set<Listener>();
let hydrated = false;

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / privacy mode — store still works in memory */
  }
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistentNotification[];
    if (Array.isArray(parsed)) state = parsed.slice(-MAX_NOTIFICATIONS);
  } catch {
    /* corrupt blob — drop it silently */
  }
}

function emit(): void {
  for (const fn of listeners) fn(state);
}

export function getNotificationsSnapshot(): PersistentNotification[] {
  hydrate();
  return state;
}

export function subscribeNotifications(fn: Listener): () => void {
  hydrate();
  listeners.add(fn);
  // Fire once so consumers don't have to do an initial snapshot read.
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

/** Add or merge a notification. Two notifications collide when they
 *  share kind + contactId — the existing row is bumped (count++, fresh
 *  timestamp, latest preview) instead of stacking duplicates. */
export function pushNotification(
  input: Omit<PersistentNotification, "id" | "count"> & { id?: string },
): void {
  hydrate();
  const existing = state.find(
    (n) => n.kind === input.kind && n.contactId === input.contactId,
  );
  if (existing) {
    existing.count += 1;
    existing.occurredAt = input.occurredAt;
    existing.preview = input.preview || existing.preview;
    existing.contactName = input.contactName || existing.contactName;
    // Move to front so the most recently-pinged chat is at the top.
    state = [existing, ...state.filter((n) => n !== existing)];
  } else {
    const fresh: PersistentNotification = {
      id:
        input.id ??
        `${input.kind}:${input.contactId}:${Date.now()}:${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      kind: input.kind,
      contactId: input.contactId,
      contactName: input.contactName,
      preview: input.preview,
      businessPhoneNumberId: input.businessPhoneNumberId,
      occurredAt: input.occurredAt,
      count: 1,
    };
    state = [fresh, ...state];
    if (state.length > MAX_NOTIFICATIONS) state = state.slice(0, MAX_NOTIFICATIONS);
  }
  persist();
  emit();
}

/** Drop one notification (operator dismissed or opened the chat). */
export function dismissNotification(id: string): void {
  hydrate();
  const next = state.filter((n) => n.id !== id);
  if (next.length === state.length) return;
  state = next;
  persist();
  emit();
}

/** Drop every notification for a contact — fires when the operator
 *  opens that chat so all pings for it clear in one shot. */
export function dismissNotificationsForContact(contactId: string): void {
  hydrate();
  const next = state.filter((n) => n.contactId !== contactId);
  if (next.length === state.length) return;
  state = next;
  persist();
  emit();
}

export function clearAllNotifications(): void {
  hydrate();
  if (state.length === 0) return;
  state = [];
  persist();
  emit();
}
