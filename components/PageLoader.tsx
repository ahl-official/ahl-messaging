// Modern full-screen loader — Linear / Vercel-inspired.
//
// Layers:
//   1. Frosted-blur backdrop dims the underlying page.
//   2. Indeterminate top progress bar (slim emerald gradient sweep).
//   3. Centered minimal spinner — a single thin gradient stroke
//      orbiting an empty circle (no logo, no nesting).
//   4. Gradient-shimmer "Loading" text that sweeps continuously.
//
// All animations are pure CSS keyframes (defined in app/globals.css)
// + Tailwind built-ins (`animate-spin`, `animate-pulse`). No JS, GPU
// cheap, drops in cleanly via app/(dashboard)/loading.tsx.

import { cn } from "@/lib/utils";

interface Props {
  /** Optional copy under the spinner. Defaults to "Loading". */
  label?: string;
  /** When true, the wrapper is `absolute` instead of `fixed` so the
   *  overlay only covers its parent (panel-level loaders). */
  inline?: boolean;
}

export function PageLoader({ label = "Loading", inline }: Props) {
  return (
    <div
      className={cn(
        "z-[60] grid place-items-center overflow-hidden bg-white/55 backdrop-blur-md",
        inline ? "absolute inset-0" : "fixed inset-0",
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* Top indeterminate progress bar */}
      <div className="absolute left-0 right-0 top-0 h-[2px] overflow-hidden bg-primary/15/40">
        <div className="animate-loader-progress h-full w-[30%] rounded-full bg-gradient-to-r from-[#6098FF] via-primary to-[#6098FF] shadow-[0_0_8px_rgba(46,109,226,0.6)]" />
      </div>

      <div className="flex flex-col items-center gap-5">
        {/* Minimal ring spinner — single emerald arc rotating on a soft track. */}
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-primary/20/80" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary border-r-primary/60" />
        </div>

        {/* Shimmer text */}
        <div className="animate-loader-shimmer bg-gradient-to-r from-[#1a4ab8] via-[#6098FF] to-[#1a4ab8] bg-clip-text text-[13px] font-semibold tracking-[0.18em] text-transparent uppercase">
          {label}
        </div>
      </div>
    </div>
  );
}
