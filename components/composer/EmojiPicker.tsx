"use client";

import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { cn } from "@/lib/utils";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";

interface Props {
  disabled?: boolean;
  /** Called with the picked emoji character. */
  onPick: (emoji: string) => void;
}

// Curated set — common, work-friendly, healthcare-relevant. Kept inline so
// we don't pull in a 300KB emoji library for a button most agents use rarely.
const CATEGORIES: { name: string; emojis: string[] }[] = [
  {
    name: "Smileys",
    emojis: [
      "😀","😃","😄","😁","😊","😇","🙂","🙃","😉","😌",
      "😍","🥰","😘","😋","😛","😜","🤪","🤗","🤔","😐",
      "😏","🙄","😬","😴","🤒","🤕","🤧","😷","🤓","😎",
      "🥳","🥺","😢","😭","😤","😠","🤯","😱","🤝","🙏",
    ],
  },
  {
    name: "Gestures",
    emojis: [
      "👍","👎","👌","✌️","🤞","🤝","👏","🙌","🤲","🙏",
      "💪","👋","✋","🖐️","🖖","🤘","👇","👆","👈","👉",
    ],
  },
  {
    name: "Hearts & symbols",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💯",
      "✨","⭐","🌟","🔥","🎉","🎊","🎁","✅","❌","⚠️",
    ],
  },
  {
    name: "Clinic",
    emojis: [
      "🩺","💊","🏥","💉","🦷","👶","👨‍⚕️","👩‍⚕️","🧑‍⚕️","🧬",
      "🩹","🩻","🧪","💆","💆‍♀️","💆‍♂️","🪞","✂️","🧴","🧼",
    ],
  },
  {
    name: "Calendar & work",
    emojis: [
      "📅","📆","🗓️","⏰","⏳","📞","📱","💬","📨","📋",
      "📝","✏️","📌","📎","🔖","💼","🏷️","🔔","🔕","💡",
    ],
  },
];

export function EmojiPicker({ disabled, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [activeCat, setActiveCat] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(emoji: string) {
    onPick(emoji);
    // Keep panel open so users can stack a few emojis quickly.
  }

  return (
    <div ref={wrapperRef} className="relative">
      <ComposerIconButton
        icon={Smile}
        label="Emoji"
        active={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />

      {open ? (
        <div
          className={cn(
            "absolute bottom-full right-0 mb-2 w-[320px] rounded-lg border bg-card shadow-xl z-50",
            "animate-in fade-in-0 zoom-in-95",
          )}
        >
          {/* Category tabs */}
          <div className="flex items-center gap-0.5 border-b px-2 py-1.5 overflow-x-auto">
            {CATEGORIES.map((cat, i) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => setActiveCat(i)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap transition",
                  i === activeCat
                    ? "bg-brand-50 text-brand-700"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* Emoji grid */}
          <div className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto p-2">
            {CATEGORIES[activeCat].emojis.map((emoji, i) => (
              <button
                key={`${activeCat}-${i}-${emoji}`}
                type="button"
                onClick={() => pick(emoji)}
                className="aspect-square rounded-md text-xl transition hover:bg-secondary"
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* Footer hint */}
          <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
            Click to insert · Esc to close
          </div>
        </div>
      ) : null}
    </div>
  );
}
