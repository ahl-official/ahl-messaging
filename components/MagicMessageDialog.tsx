"use client";

import { Image as ImageIcon, Type, WandSparkles, X } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";

interface Props {
  onClose: () => void;
  /** User picked the text-only Magic Message path. Parent decides what
   *  happens next (typically opens a text composer that wraps the body
   *  into the magic_message utility template). */
  onPickText: () => void;
  /** User picked the image+text Magic Message path. */
  onPickImage: () => void;
}

// Option-picker dialog. The actual send flow lives in the follow-up dialogs
// the parent opens via onPickText / onPickImage — this is purely the choice
// step ("which kind of magic message?").
export function MagicMessageDialog({ onClose, onPickText, onPickImage }: Props) {
  return (
    <ModalShell
      overlayClassName="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-lg border bg-card shadow-xl"
    >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100">
              <WandSparkles className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold">Magic Message</div>
              <div className="text-xs text-muted-foreground">
                Send a dynamic message even when the 24-hour window is closed
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Two options */}
        <div className="grid grid-cols-2 gap-3 p-4">
          <button
            type="button"
            onClick={onPickText}
            className="group flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-input bg-background p-5 text-center transition hover:border-fuchsia-300 hover:bg-fuchsia-50"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100 group-hover:bg-fuchsia-100">
              <Type className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold">Text</span>
            <span className="text-[11px] text-muted-foreground">
              Send a custom text message
            </span>
          </button>

          <button
            type="button"
            onClick={onPickImage}
            className="group flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-input bg-background p-5 text-center transition hover:border-fuchsia-300 hover:bg-fuchsia-50"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100 group-hover:bg-fuchsia-100">
              <ImageIcon className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold">Image</span>
            <span className="text-[11px] text-muted-foreground">
              Send a custom image with caption
            </span>
          </button>
        </div>
    </ModalShell>
  );
}
