"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import { Pencil, Check, X } from "lucide-react";
import { updateContactNameAction } from "@/app/(dashboard)/actions";

interface Props {
  contactId: string;
  currentName: string | null;
  fallbackName: string;
  /** Lets the parent slide other identity-row chrome (status pills,
   *  etc.) out of the way while the input takes the full width. */
  onEditingChange?: (editing: boolean) => void;
}

export function NameEditor({ contactId, currentName, fallbackName, onEditingChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName ?? "");

  // Surface editing state to the parent — we don't want NameEditor to
  // know what to hide; it just announces "I'm editing" and the panel
  // decides which siblings get out of the way.
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);
  const [name, setName] = useState<string | null>(currentName);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Sync local state when the parent feeds a fresh contact (chat switch)
  // or a server-side name update. Without this the panel keeps showing
  // the previous contact's name. Skipped mid-edit so we don't clobber
  // what the operator is typing.
  useEffect(() => {
    if (editing) return;
    setName(currentName);
    setDraft(currentName ?? "");
  }, [currentName, editing]);

  function save() {
    const next = draft.trim();
    setError(null);
    startTransition(async () => {
      const result = await updateContactNameAction(contactId, next);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setName(next || null);
      setEditing(false);
    });
  }

  function cancel() {
    setDraft(name ?? "");
    setEditing(false);
    setError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={200}
          placeholder={fallbackName}
          className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-brand-600 disabled:opacity-60"
          aria-label="Save"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={cancel}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background hover:bg-secondary"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
        {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="truncate text-base font-semibold leading-tight">
        {name?.trim() || fallbackName}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Edit name"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
