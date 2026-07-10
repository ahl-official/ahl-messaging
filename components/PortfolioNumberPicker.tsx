"use client";

// Portfolio-card number picker — used by Templates + Quick Replies. Numbers are
// grouped into portfolio CARDS (icon + name + count); picking a card selects
// that portfolio and its numbers show as pills below for choosing the exact one.

import { useMemo } from "react";
import { Building2, Cable } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PickerNumber {
  phone_number_id: string;
  nickname: string | null;
  display_phone_number: string | null;
  verified_name?: string | null;
  is_active?: boolean;
  provider?: "meta" | "evolution" | null;
  portfolio?: { key: string; name: string } | null;
}

const EVO_KEY = "__evolution__";
const UNASSIGNED_KEY = "__unassigned__";

export function PortfolioNumberPicker({
  numbers,
  activePhoneId,
  onSelect,
  excludeEvolution = true,
  requirePortfolio = false,
}: {
  numbers: PickerNumber[];
  activePhoneId: string | null;
  onSelect: (phoneNumberId: string, portfolioKey: string | null) => void;
  /** Drop Evolution (Baileys) numbers. */
  excludeEvolution?: boolean;
  /** Drop numbers with no portfolio (e.g. Templates need a Meta portfolio). */
  requirePortfolio?: boolean;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; isEvo: boolean; rows: PickerNumber[] }>();
    for (const n of numbers) {
      const isEvo = n.provider === "evolution" || n.phone_number_id.startsWith("evo:");
      if (isEvo && excludeEvolution) continue;
      const portfolioKey = n.portfolio?.key ?? null;
      if (requirePortfolio && !portfolioKey && !isEvo) continue;
      const key = isEvo ? EVO_KEY : portfolioKey ?? UNASSIGNED_KEY;
      const name = isEvo ? "Evolution (Baileys)" : n.portfolio?.name ?? "Unassigned";
      if (!m.has(key)) m.set(key, { key, name, isEvo, rows: [] });
      m.get(key)!.rows.push(n);
    }
    return Array.from(m.values()).sort((a, b) => {
      if (a.key === EVO_KEY) return 1;
      if (b.key === EVO_KEY) return -1;
      if (a.key === UNASSIGNED_KEY) return 1;
      if (b.key === UNASSIGNED_KEY) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [numbers, excludeEvolution, requirePortfolio]);

  const activeGroup = groups.find((g) => g.rows.some((n) => n.phone_number_id === activePhoneId)) ?? groups[0] ?? null;
  const portfolioKeyOf = (n: PickerNumber) => (n.provider === "evolution" ? null : n.portfolio?.key ?? null);

  return (
    <div className="space-y-3">
      {/* Portfolio cards */}
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => {
          const selected = activeGroup?.key === g.key;
          const onCount = g.rows.filter((n) => n.is_active !== false).length;
          const Icon = g.isEvo ? Cable : Building2;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => {
                const pick = g.rows.find((n) => n.phone_number_id === activePhoneId) ?? g.rows[0];
                if (pick) onSelect(pick.phone_number_id, portfolioKeyOf(pick));
              }}
              className={cn(
                "relative flex min-w-[180px] items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition",
                selected ? "border-primary/40 ring-1 ring-primary/25" : "border-input hover:border-foreground/20 hover:bg-secondary/40",
              )}
            >
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", selected ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-bold uppercase tracking-wide">{g.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{onCount}</span>/{g.rows.length} on
                </span>
              </span>
              {selected ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" /> : null}
            </button>
          );
        })}
      </div>

      {/* Numbers within the selected portfolio */}
      {activeGroup ? (
        <div className="flex flex-wrap gap-1.5">
          {activeGroup.rows.map((n) => {
            const label = n.nickname?.trim() || n.verified_name?.trim() || n.display_phone_number || n.phone_number_id;
            const active = n.phone_number_id === activePhoneId;
            return (
              <button
                key={n.phone_number_id}
                type="button"
                onClick={() => onSelect(n.phone_number_id, portfolioKeyOf(n))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  active ? "border-primary bg-brand-50 text-brand-700" : "border-input bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
                  n.is_active === false && "opacity-60",
                )}
              >
                <span className="max-w-[160px] truncate">{label}</span>
                <span className="text-[10px] text-muted-foreground">{n.display_phone_number ?? ""}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
