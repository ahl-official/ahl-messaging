"use client";

// Tiny arrow tab on the right edge that hides / shows the cluster of
// floating bottom-right widgets (NotificationsDropdown bell, HomeAssistant
// sparkle, NewChatFab). State persists per-tab via localStorage so the
// operator's preference survives refresh / navigation.
//
// Each widget reads `useFloatingDock().collapsed` and applies a
// translate-x + fade when collapsed; the toggle itself stays anchored to
// the screen edge so the operator can always expand again.
//
// Hydration: the provider intentionally renders `collapsed=false` on the
// server AND on the very first client commit. A `mounted` flag flips
// true only after the localStorage read, and consumers gate their
// classes on it via `dockHideClasses(collapsed, mounted)` so the
// server-rendered HTML matches the first client paint exactly. Skipping
// this caused React error #418/#423 which detached + remounted the
// entire floating subtree — silently killing event handlers on the Call
// dropdown.

import { createContext, useContext, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingDockCtx {
  collapsed: boolean;
  mounted: boolean;
  toggle: () => void;
}

const FloatingDockContext = createContext<FloatingDockCtx>({
  collapsed: false,
  mounted: false,
  toggle: () => {},
});

const STORAGE_KEY = "qht_floating_dock_collapsed";

export function useFloatingDock(): FloatingDockCtx {
  return useContext(FloatingDockContext);
}

export function FloatingDockProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* localStorage blocked — fall back to in-memory default */
    }
    setMounted(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <FloatingDockContext.Provider value={{ collapsed, mounted, toggle }}>
      {children}
    </FloatingDockContext.Provider>
  );
}

/** Render this once in the dashboard layout. It positions the arrow
 *  tab itself; widgets handle their own hide/show via useFloatingDock. */
export function FloatingDockToggle() {
  const { collapsed, mounted, toggle } = useFloatingDock();
  // Don't paint the button until the localStorage read settles — the
  // server has no way to know the right-edge position, and rendering
  // the wrong one would trigger a hydration mismatch.
  if (!mounted) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      title={
        collapsed
          ? "Show notifications + AI + new chat"
          : "Hide notifications + AI + new chat"
      }
      aria-label={collapsed ? "Show floating actions" : "Hide floating actions"}
      className={cn(
        "group fixed bottom-6 z-[60] inline-flex h-7 w-5 items-center justify-center rounded-l-md border border-r-0 border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-all hover:bg-accent hover:text-foreground",
        collapsed ? "right-0" : "right-[5rem]",
      )}
    >
      <ChevronRight
        className={cn(
          "h-3.5 w-3.5 transition-transform",
          collapsed ? "rotate-180" : "rotate-0",
        )}
      />
    </button>
  );
}

/** Helper: classes to apply to a floating widget so it slides off when
 *  the dock is collapsed. Returns empty (default visible) until the
 *  provider has mounted so the server-rendered HTML matches the first
 *  client paint. */
export function dockHideClasses(collapsed: boolean, mounted = true): string {
  if (!mounted) return "translate-x-0 opacity-100";
  return collapsed
    ? "translate-x-[150%] opacity-0 pointer-events-none"
    : "translate-x-0 opacity-100";
}
