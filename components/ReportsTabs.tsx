"use client";

// /reports has two complementary views now:
//   - Analytics  → workspace-wide volume / response time / leaderboard
//                  with date + number filters (default tab).
//   - Agents     → the existing per-agent productivity rollup.
//
// We mount both client-side and switch via a small chip toggle at the
// top so navigation feels instant and the page state survives a tab
// flip. URL ?tab=agents preserves the choice across refreshes.

import { useEffect, useState } from "react";
import { BarChart3, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReportsView } from "@/components/ReportsView";
import { AnalyticsDashboard } from "@/components/AnalyticsDashboard";

type Tab = "analytics" | "agents";

const TABS: Array<{ key: Tab; label: string; icon: typeof BarChart3 }> = [
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "agents", label: "Agent productivity", icon: Users },
];

export function ReportsTabs({
  teamLeadOnly = false,
  canSetKra = false,
}: {
  teamLeadOnly?: boolean;
  /** Owner or Team Lead — shows the inline "Set KRA" controls in the
   *  Agent-productivity table. */
  canSetKra?: boolean;
}) {
  // Team Leads only get the team-scoped Agent-productivity view; the
  // workspace-wide Analytics tab is hidden for them.
  const tabs = teamLeadOnly ? TABS.filter((t) => t.key === "agents") : TABS;
  const [tab, setTab] = useState<Tab>(teamLeadOnly ? "agents" : "analytics");

  // Hydrate from the URL on mount + mirror updates back.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (teamLeadOnly) return; // forced to the agents tab
    const fromUrl = new URL(window.location.href).searchParams.get("tab");
    if (fromUrl === "agents" || fromUrl === "analytics") setTab(fromUrl);
  }, [teamLeadOnly]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (tab === "analytics") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-1 px-6 py-2 lg:px-10">
          {tabs.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  active
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "analytics" && !teamLeadOnly ? (
          <AnalyticsDashboard />
        ) : (
          <ReportsView canSetKra={canSetKra} />
        )}
      </div>
    </div>
  );
}
