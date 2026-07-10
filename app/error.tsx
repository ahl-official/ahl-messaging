"use client";

// Page-level crash boundary (everything under app/, incl. the dashboard).
// Same idea as global-error: auto-reload once on a stale-deploy chunk error,
// otherwise a calm recoverable card instead of a blank "Application error".

import { useEffect, useState } from "react";

function isChunkError(error: Error): boolean {
  const s = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|failed to fetch dynamically/i.test(
    s,
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !isChunkError(error)) return;
    const KEY = "qht_chunk_reload_at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 15_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      setReloading(true);
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="grid h-full min-h-[60vh] place-items-center bg-secondary px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-7 text-center shadow-sm">
        <p className="text-sm font-bold text-foreground">
          {reloading ? "Reconnecting…" : "Something interrupted"}
        </p>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {reloading
            ? "A new version just loaded — refreshing your inbox."
            : "This view hit a snag. Reload to continue — nothing was lost."}
        </p>
        <button
          type="button"
          onClick={() => {
            setReloading(true);
            try {
              reset();
            } finally {
              window.location.reload();
            }
          }}
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-white hover:bg-primary/90"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
