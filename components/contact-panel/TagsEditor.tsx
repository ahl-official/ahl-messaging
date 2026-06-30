"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { setContactTagsAction } from "@/app/(dashboard)/actions";

interface Props {
  contactId: string;
  initialTags: string[];
  /** Reports the live tag count up so the panel widget chip can show it. */
  onCountChange?: (n: number) => void;
}

export function TagsEditor({ contactId, initialTags, onCountChange }: Props) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    onCountChange?.(tags.length);
  }, [tags.length, onCountChange]);

  function persist(next: string[]) {
    setError(null);
    startTransition(async () => {
      const result = await setContactTagsAction(contactId, next);
      if ("error" in result) {
        setError(result.error);
        setTags(initialTags);
      }
    });
  }

  function addTag() {
    const t = draft.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setDraft("");
      return;
    }
    if (t.length > 40) {
      setError("Tag too long (40 chars max)");
      return;
    }
    const next = [...tags, t];
    setTags(next);
    setDraft("");
    persist(next);
  }

  function removeTag(t: string) {
    const next = tags.filter((x) => x !== t);
    setTags(next);
    persist(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
          >
            {t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              className="rounded-full hover:bg-brand-100/80"
              aria-label={`Remove ${t}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        <div className="inline-flex items-center gap-1 rounded-full border border-dashed border-input px-2 py-0.5 text-xs text-muted-foreground focus-within:border-ring">
          <Plus className="h-3 w-3" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={addTag}
            placeholder="add tag"
            className="w-20 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            maxLength={40}
          />
        </div>
        {isPending ? (
          <span className="self-center text-[10px] text-muted-foreground">saving…</span>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {tags.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Press Enter or comma to add. Backspace removes the last one.
        </p>
      ) : null}
    </div>
  );
}
