"use client";

// LSQ lead number chip with a copy button. Shown next to the patient's mobile
// in the inbox + bird's-eye chat headers.

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function LeadNumberBadge({
  leadNumber,
  className,
}: {
  leadNumber: string | null | undefined;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!leadNumber) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium", className)}>
      <span className="opacity-70">#</span>
      {leadNumber}
      <button
        type="button"
        title="Copy lead number"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard?.writeText(leadNumber).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className="rounded p-0.5 hover:bg-black/10"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
