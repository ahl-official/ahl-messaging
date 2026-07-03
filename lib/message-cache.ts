import type { Message } from "@/lib/types";

// Client-side message cache so reopening a chat (SPA nav or a full page
// refresh) paints instantly instead of blanking to a spinner while the
// 500-row Supabase fetch runs. Stale-while-revalidate: we show the cache
// immediately, then the live fetch overwrites it.
//
// Two tiers:
//   1. In-memory Map — fast, survives SPA navigation between chats.
//   2. sessionStorage — survives a full F5 refresh. NOT localStorage:
//      message bodies are client PII, so we keep them off disk and let
//      them clear when the tab closes.

const MEM = new Map<string, Message[]>();
const KEY_PREFIX = "qht_msgcache_";
// Cap stored rows per chat — enough for an instant first paint; the
// background fetch fills the full window. Keeps each sessionStorage
// entry small so writes stay cheap.
const MAX_ROWS = 200;
// LRU-ish bound on how many chats we persist to sessionStorage.
const MAX_CHATS = 40;

function storageKey(contactId: string): string {
  return KEY_PREFIX + contactId;
}

/** Read cached messages for a chat: memory first, then sessionStorage. */
export function loadCachedMessages(contactId: string): Message[] | null {
  const mem = MEM.get(contactId);
  if (mem) return mem;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(contactId));
    if (!raw) return null;
    const rows = JSON.parse(raw) as Message[];
    MEM.set(contactId, rows);
    return rows;
  } catch {
    return null;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { contactId: string; rows: Message[] } | null = null;

function flush() {
  writeTimer = null;
  if (!pending || typeof window === "undefined") return;
  const { contactId, rows } = pending;
  pending = null;
  try {
    const ss = window.sessionStorage;
    ss.setItem(storageKey(contactId), JSON.stringify(rows));
    evictIfNeeded(ss);
  } catch {
    // Quota / private-mode — memory cache still serves this session.
  }
}

function evictIfNeeded(ss: Storage) {
  const keys: string[] = [];
  for (let i = 0; i < ss.length; i++) {
    const k = ss.key(i);
    if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
  }
  if (keys.length <= MAX_CHATS) return;
  // Oldest insertions sit at the front of the index order; drop them.
  for (const k of keys.slice(0, keys.length - MAX_CHATS)) ss.removeItem(k);
}

/** Persist the latest messages for a chat. Memory write is immediate;
 *  the sessionStorage write is debounced so realtime ticks don't thrash. */
export function saveCachedMessages(contactId: string, messages: Message[]): void {
  if (!messages.length) return;
  const rows = messages.slice(-MAX_ROWS);
  MEM.set(contactId, rows);
  pending = { contactId, rows };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
}
