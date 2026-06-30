"use client";

// Catches crashes that escape every page boundary (incl. the root layout).
// Two jobs:
//   1. A failed CSS/JS *chunk* load almost always means a NEW build was just
//      deployed while this browser tab still referenced the OLD chunk names —
//      so we reload ONCE to pull the fresh build (this is the usual cause of
//      "Application error" / an unstyled page right after a deploy).
//   2. Any other crash shows a calm "reconnecting" card with a Reload button
//      instead of a blank white screen.

import { useEffect, useState } from "react";

function isChunkError(error: Error): boolean {
  const s = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|failed to fetch dynamically/i.test(
    s,
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isChunkError(error)) return;
    // Loop guard — only auto-reload once per 15s so a persistent error can't
    // trap the tab in a refresh loop.
    const KEY = "qht_chunk_reload_at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 15_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      setReloading(true);
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#f3f5f7",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          color: "#0f172a",
        }}
      >
        <div
          style={{
            maxWidth: 360,
            width: "90%",
            textAlign: "center",
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: "28px 24px",
            boxShadow: "0 10px 30px -12px rgba(0,0,0,0.15)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {reloading ? "Reconnecting…" : "Something interrupted"}
          </div>
          <p style={{ margin: "8px 0 18px", fontSize: 13, color: "#64748b" }}>
            {reloading
              ? "A new version just loaded — refreshing your inbox."
              : "Your inbox hit a snag. Reload to continue — nothing was lost."}
          </p>
          <button
            onClick={() => {
              setReloading(true);
              // reset() retries render; a hard reload guarantees fresh chunks.
              try {
                reset();
              } finally {
                window.location.reload();
              }
            }}
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 10,
              padding: "10px 18px",
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: "#0E7C5A",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
