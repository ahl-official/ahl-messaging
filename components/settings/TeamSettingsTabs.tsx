"use client";

// /settings/team houses two related views — individual members and the
// team groups they get bucketed into. Operators kept treating them as
// "one settings area" so we render both behind a small in-page tab
// switcher instead of two top-level settings tabs.

import { useEffect, useState } from "react";
import { Layers, Monitor, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { TeamView } from "@/components/TeamView";
import { TeamsView } from "@/components/settings/TeamsView";
import { AllSessionsView } from "@/components/settings/AllSessionsView";

type SubTab = "members" | "groups" | "sessions";

const SUB_TABS: Array<{ key: SubTab; label: string; icon: typeof Users }> = [
  { key: "members", label: "Members", icon: Users },
  { key: "groups", label: "Groups", icon: Layers },
  { key: "sessions", label: "Login activity", icon: Monitor },
];

export function TeamSettingsTabs() {
  const [tab, setTab] = useState<SubTab>("members");

  // Hydrate from `?view=` so legacy /settings/teams links + deep
  // links land on the right sub-tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URL(window.location.href).searchParams.get("view");
    if (v === "groups" || v === "sessions") setTab(v);
  }, []);

  // Mirror selection back to the URL so a refresh doesn't bounce the
  // operator back to Members mid-edit.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (tab === "members") url.searchParams.delete("view");
    else url.searchParams.set("view", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-6 py-2 lg:px-10">
          {SUB_TABS.map((s) => {
            const active = tab === s.key;
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setTab(s.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  active
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "members" ? (
          <TeamView />
        ) : tab === "groups" ? (
          <TeamsView />
        ) : (
          <AllSessionsView />
        )}
      </div>
    </div>
  );
}
