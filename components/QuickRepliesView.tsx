"use client";

import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { PremiumHeader } from "@/components/PremiumHeader";
import { QuickRepliesManager } from "@/components/QuickRepliesManager";
import { PortfolioNumberPicker } from "@/components/PortfolioNumberPicker";

interface NumberOption {
  phone_number_id: string;
  nickname: string | null;
  display_phone_number: string | null;
  verified_name?: string | null;
  is_active?: boolean;
  provider?: "meta" | "evolution" | null;
  portfolio?: { key: string; name: string } | null;
}

// Standalone Quick Replies page — moved out of Templates into its own nav item.
// Pick a business number, then manage the snippets scoped to it.
export function QuickRepliesView() {
  const [numbers, setNumbers] = useState<NumberOption[] | null>(null);
  const [activePhoneId, setActivePhoneId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: Array<Record<string, unknown>> }) => {
        const list = (j.numbers ?? [])
          .map((n) => ({
            phone_number_id: String(n.phone_number_id ?? ""),
            nickname: (n.nickname as string | null) ?? null,
            display_phone_number: (n.display_phone_number as string | null) ?? null,
            verified_name: (n.verified_name as string | null) ?? null,
            is_active: n.is_active !== false,
            provider: (n.provider as "meta" | "evolution" | null) ?? "meta",
            portfolio: (n.portfolio as { key: string; name: string } | null) ?? null,
          }))
          // Drop Evolution (Baileys) numbers — keep Meta + WAHA (waha: ids
          // may still be tagged provider=evolution in DB).
          .filter((n) => n.provider !== "evolution" || n.phone_number_id.startsWith("waha:"));
        setNumbers(list);
        setActivePhoneId(list[0]?.phone_number_id ?? null);
      })
      .catch(() => setNumbers([]));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PremiumHeader
        icon={MessageSquareText}
        title="Quick Replies"
        subtitle="Canned snippets — chat me /shortcut type karke insert karo. Har snippet jin numbers pe tick ho unhi pe dikhta hai."
      />

      {/* Number picker — portfolio cards + numbers */}
      <div className="border-b bg-card px-6 py-3">
        {numbers === null ? (
          <span className="text-[11px] text-muted-foreground">Loading numbers…</span>
        ) : (
          <PortfolioNumberPicker numbers={numbers} activePhoneId={activePhoneId} onSelect={(id) => setActivePhoneId(id)} excludeEvolution />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <QuickRepliesManager activePhoneId={activePhoneId} numbers={numbers ?? []} />
      </div>
    </div>
  );
}
