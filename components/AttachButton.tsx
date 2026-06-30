"use client";

import { useRef } from "react";
import { Paperclip } from "lucide-react";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";

interface Props {
  disabled?: boolean;
  /** Receives every picked file — the picker allows multi-select. */
  onFiles: (files: File[]) => void | Promise<void>;
}

export function AttachButton({ disabled, onFiles }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <ComposerIconButton
        icon={Paperclip}
        label="Attach"
        disabled={disabled}
        onClick={() => ref.current?.click()}
      />
      <input
        ref={ref}
        type="file"
        multiple
        className="hidden"
        accept="image/jpeg,image/png,video/mp4,video/3gp,audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          e.target.value = "";
        }}
      />
    </>
  );
}
