"use client";

import { MessageSquare, StickyNote } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComposerMode = "reply" | "note";

interface Props {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
}

export function ComposerTabs({ mode, onChange }: Props) {
  return (
    <div className="flex items-center gap-0 border-t bg-card px-3 pt-2">
      <Tab label="Reply" icon={MessageSquare} active={mode === "reply"} onClick={() => onChange("reply")} />
      <Tab
        label="Notes"
        icon={StickyNote}
        active={mode === "note"}
        onClick={() => onChange("note")}
        tintNote
      />
    </div>
  );
}

function Tab({
  label,
  icon: Icon,
  active,
  onClick,
  tintNote,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
  tintNote?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative -mb-px inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition",
        active
          ? tintNote
            ? "text-amber-800 border-b-2 border-amber-500"
            : "text-primary border-b-2 border-primary"
          : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
