"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/utils";

interface Props {
  iso: string | null | undefined;
  className?: string;
}

// Renders a relative-time string ("16 mins", "4 hrs", "1 day"). Renders
// the label synchronously on every render — earlier version started with an
// empty string and updated via useEffect, which left an invisible time on
// initial paint when hydration was slow. `suppressHydrationWarning` is set
// because server vs client time can differ by a tick (that's expected).
// A tick counter forces a re-render every minute so the label stays fresh.
export function RelativeTime({ iso, className }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!iso) return null;
  return (
    <span className={className} suppressHydrationWarning>
      {formatRelativeTime(iso)}
    </span>
  );
}
