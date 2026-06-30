"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  comingSoon?: boolean;
}

export const ComposerIconButton = React.forwardRef<HTMLButtonElement, Props>(
  ({ icon: Icon, label, active, comingSoon, className, disabled, ...props }, ref) => {
    const isDisabled = disabled || comingSoon;
    return (
      <span className="group relative inline-flex">
        <button
          ref={ref}
          type="button"
          disabled={isDisabled}
          aria-label={label}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md transition",
            isDisabled
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            active && "bg-brand-50 text-brand-700",
            className,
          )}
          {...props}
        >
          <Icon className="h-[18px] w-[18px]" />
        </button>
        <span
          className={cn(
            "pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap",
            "rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background shadow-md z-50",
            "opacity-0 group-hover:opacity-100 transition-opacity",
          )}
        >
          {label}
          {comingSoon ? <span className="ml-1 opacity-70">· soon</span> : null}
        </span>
      </span>
    );
  },
);
ComposerIconButton.displayName = "ComposerIconButton";
