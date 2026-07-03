"use client";

// Per-operator toggle: "show LSQ activities inline in the chat thread".
// Persists to localStorage so the choice survives reloads. Cross-tab
// sync uses the native `storage` event (only fires for changes in
// OTHER tabs) — within the same tab a single React state update is
// enough; we deliberately don't bounce events back to ourselves.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "qht.lsq.activities_in_chat";
// Default OFF — opt-in by design. When OFF the hook in ChatWindow
// also skips polling, so a quiet inbox costs zero CRM API calls until
// the operator explicitly asks to see activities.
const DEFAULT_VALUE = false;

function readStored(): boolean {
  if (typeof window === "undefined") return DEFAULT_VALUE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VALUE;
    return raw === "1";
  } catch {
    return DEFAULT_VALUE;
  }
}

function writeStored(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // localStorage can throw in private mode / quota — ignore.
  }
}

export function useLsqActivitiesInChat(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  toggle: () => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(DEFAULT_VALUE);

  // Hydrate from localStorage on mount. Doing this in an effect (not
  // `useState(readStored)`) avoids a hydration mismatch on SSR — the
  // server can't read localStorage, so we render with the default and
  // sync up on the client.
  useEffect(() => {
    setEnabledState(readStored());
  }, []);

  // Cross-tab sync only — `storage` event fires for changes from
  // other tabs, never for the tab that wrote the value.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setEnabledState(e.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeStored(next);
  }, []);

  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      writeStored(next);
      return next;
    });
  }, []);

  return { enabled, setEnabled, toggle };
}
