"use client";

// Shared layout state for the bottom-right floating action buttons
// (notifications bell, AI assistant, new chat). By default they stack
// vertically at the right edge. When ANY of them opens its popover the
// stack flattens into a horizontal row at the bottom edge so the open
// popover has clean space above without overlapping a sibling FAB.
//
// Each FAB calls `emitFabOpen(id)` when its popover opens and
// `emitFabClose(id)` when it closes. The `useFabsFlat()` hook returns
// true whenever any FAB is currently open.

import { useEffect, useState } from "react";

const EVENT_NAME = "qht-fab-state";

interface FabStateDetail {
  /** Map of FAB id → open boolean. */
  open: Record<string, boolean>;
}

// Module-level singleton — survives across mount/unmount and is the
// source of truth. Components mirror it into local state via the hook.
const state: FabStateDetail = { open: {} };

function broadcast() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FabStateDetail>(EVENT_NAME, {
      detail: { open: { ...state.open } },
    }),
  );
}

export function emitFabOpen(id: string) {
  state.open[id] = true;
  broadcast();
}

export function emitFabClose(id: string) {
  state.open[id] = false;
  broadcast();
}

/** Returns true when at least one FAB has signalled its popover is
 *  open. FABs use this to switch from a vertical stack at the right
 *  edge to a horizontal row at the bottom edge. */
export function useFabsFlat(): boolean {
  const [flat, setFlat] = useState<boolean>(() =>
    Object.values(state.open).some(Boolean),
  );
  useEffect(() => {
    function onState(e: Event) {
      const detail = (e as CustomEvent<FabStateDetail>).detail;
      setFlat(Object.values(detail.open).some(Boolean));
    }
    window.addEventListener(EVENT_NAME, onState);
    return () => {
      window.removeEventListener(EVENT_NAME, onState);
    };
  }, []);
  return flat;
}
