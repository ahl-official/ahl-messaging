"use client";

// Compact widget strip in the contact-details panel. Tags + Notes
// collapse into small chips — clicking one expands its body inline
// (accordion: one open at a time). AI Summary and Suggested reply each
// sit in their own collapsible section just below.

import { useState } from "react";
import {
  ChevronDown,
  MessageSquareReply,
  Sparkles,
  StickyNote,
  Tag as TagIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TagsEditor } from "@/components/contact-panel/TagsEditor";
import { NotesEditor } from "@/components/contact-panel/NotesEditor";
import { ChatSummaryWidget } from "@/components/contact-panel/ChatSummaryWidget";
import { ReplySuggestionWidget } from "@/components/contact-panel/ReplySuggestionWidget";
import { RefundRequestSection } from "@/components/contact-panel/RefundRequestSection";
import type { ContactNote } from "@/lib/types";

type WidgetKey = "tags" | "notes";

interface Props {
  contactId: string;
  waId: string | null;
  contactName: string | null;
  contactLeadNumber: string | null;
  initialTags: string[];
  initialNotes: ContactNote[];
  currentUserId: string | null;
}

export function PanelWidgets({
  contactId,
  waId,
  contactName,
  contactLeadNumber,
  initialTags,
  initialNotes,
  currentUserId,
}: Props) {
  const [open, setOpen] = useState<WidgetKey | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<"summary" | "reply">("summary");
  const [tagCount, setTagCount] = useState(initialTags.length);
  const [noteCount, setNoteCount] = useState(initialNotes.length);

  const chips: Array<{
    key: WidgetKey;
    label: string;
    icon: LucideIcon;
    count: number;
  }> = [
    { key: "tags", label: "Tags", icon: TagIcon, count: tagCount },
    { key: "notes", label: "Notes", icon: StickyNote, count: noteCount },
  ];

  return (
    <>
      {/* Tags · Notes chip row */}
      <div className="border-b">
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          {chips.map((c) => {
            const active = open === c.key;
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setOpen(active ? null : c.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                  active
                    ? "border-brand-300 bg-brand-50 text-brand-700"
                    : "border-border bg-card text-muted-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {c.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                    active
                      ? "bg-brand-100 text-brand-700"
                      : "bg-secondary text-muted-foreground",
                  )}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
        </div>

        {open ? (
          <div className="px-4 pb-4">
            {open === "tags" ? (
              <TagsEditor
                contactId={contactId}
                initialTags={initialTags}
                onCountChange={setTagCount}
              />
            ) : (
              <NotesEditor
                contactId={contactId}
                initialNotes={initialNotes}
                currentUserId={currentUserId}
                onCountChange={setNoteCount}
              />
            )}
          </div>
        ) : null}
      </div>

      {/* QHT AI — one section, two tools inside (Summary / Suggested reply) */}
      <div className="border-b">
        <button
          type="button"
          onClick={() => setAiOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
          aria-expanded={aiOpen}
        >
          <Sparkles className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-semibold tracking-tight">AHL AI</span>
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 text-muted-foreground transition-transform",
              aiOpen ? "rotate-0" : "-rotate-90",
            )}
          />
        </button>
        {aiOpen ? (
          <div className="px-4 pb-4">
            {/* Tool switch */}
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
              {(
                [
                  { key: "summary", label: "Summary", icon: Sparkles },
                  {
                    key: "reply",
                    label: "Suggested reply",
                    icon: MessageSquareReply,
                  },
                ] as const
              ).map((t) => {
                const active = aiTab === t.key;
                const Icon = t.icon;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setAiTab(t.key)}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold transition",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t.label}
                  </button>
                );
              })}
            </div>
            {aiTab === "summary" ? (
              <ChatSummaryWidget contactId={contactId} />
            ) : (
              <ReplySuggestionWidget contactId={contactId} />
            )}
          </div>
        ) : null}
      </div>

      {/* Refund request — admin-reviewable form. Pre-fills agent (session)
          + lead/client (CRM); operator types the package + amount fields
          and uploads the booking payment screenshot. */}
      <RefundRequestSection
        contactId={contactId}
        waId={waId}
        currentUserId={currentUserId}
        contactName={contactName}
        contactLeadNumber={contactLeadNumber}
      />
    </>
  );
}
