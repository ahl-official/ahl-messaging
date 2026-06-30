"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { addContactNoteAction, deleteContactNoteAction } from "@/app/(dashboard)/actions";
import { createBrowserClient } from "@/lib/supabase/client";
import type { ContactNote } from "@/lib/types";

interface Props {
  contactId: string;
  initialNotes: ContactNote[];
  currentUserId: string | null;
  /** Reports the live note count up so the panel widget chip can show it. */
  onCountChange?: (n: number) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

export function NotesEditor({
  contactId,
  initialNotes,
  currentUserId,
  onCountChange,
}: Props) {
  const [notes, setNotes] = useState<ContactNote[]>(initialNotes);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    onCountChange?.(notes.length);
  }, [notes.length, onCountChange]);

  // Realtime: pick up notes added by other agents
  useEffect(() => {
    const supabase = createBrowserClient();
    const channel = supabase
      .channel(`notes-${contactId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "contact_notes", filter: `contact_id=eq.${contactId}` },
        (payload) => {
          const n = payload.new as ContactNote;
          setNotes((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev]));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "contact_notes", filter: `contact_id=eq.${contactId}` },
        (payload) => {
          const n = payload.old as ContactNote;
          setNotes((prev) => prev.filter((x) => x.id !== n.id));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [contactId]);

  function add() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const result = await addContactNoteAction(contactId, body);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDraft("");
      // Optimistic — realtime will reconcile with the server row.
      setNotes((prev) => [
        {
          id: result.id,
          contact_id: contactId,
          body,
          created_by: currentUserId,
          created_by_email: null,
          created_at: new Date().toISOString(),
        },
        ...prev.filter((n) => n.id !== result.id),
      ]);
    });
  }

  function remove(id: string) {
    let removed: ContactNote | undefined;
    setNotes((prev) => {
      removed = prev.find((n) => n.id === id);
      return prev.filter((n) => n.id !== id);
    });
    startTransition(async () => {
      const result = await deleteContactNoteAction(id);
      if ("error" in result) {
        setError(result.error);
        if (removed) {
          setNotes((prev) => (prev.some((n) => n.id === id) ? prev : [removed!, ...prev]));
        }
      }
    });
  }

  return (
    <div>
      <div className="space-y-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add an internal note (only visible to your team)…"
          rows={2}
          maxLength={2000}
          className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{draft.length}/2000</span>
          <button
            type="button"
            onClick={add}
            disabled={isPending || !draft.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-brand-600 disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Add note"}
          </button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {notes.length === 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground italic">No notes yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.map((n) => {
            const mine = currentUserId && n.created_by === currentUserId;
            return (
              <li
                key={n.id}
                className="rounded-md border bg-secondary/40 px-2.5 py-2 text-sm"
              >
                <p className="whitespace-pre-wrap break-words">{n.body}</p>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate">
                    {n.created_by_email ?? "agent"} · {formatTime(n.created_at)}
                  </span>
                  {mine ? (
                    <button
                      type="button"
                      onClick={() => remove(n.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete note"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
