"use client";

import { StickyNote, Trash2 } from "lucide-react";
import type { ContactNote } from "@/lib/types";

interface Props {
  note: ContactNote;
  canDelete: boolean;
  onDelete?: (id: string) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function NoteBubble({ note, canDelete, onDelete }: Props) {
  return (
    <div className="flex w-full justify-center">
      <div className="max-w-[85%] rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm shadow-sm">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
          <StickyNote className="h-3 w-3" />
          Internal note
          <span className="ml-auto text-muted-foreground font-normal normal-case tracking-normal">
            {note.created_by_email ?? "agent"} · {formatTime(note.created_at)}
          </span>
          {canDelete && onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(note.id)}
              className="ml-1 text-muted-foreground hover:text-destructive"
              aria-label="Delete note"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-amber-900">{note.body}</p>
      </div>
    </div>
  );
}
