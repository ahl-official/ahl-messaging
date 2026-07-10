"use client";

// Settings → Data → Chat export.
//
// Operator searches a contact (phone or name), the panel shows
// matches with last-message previews, click → downloads the chat as a
// WhatsApp-style .txt via /api/contacts/[id]/export.
//
// Why here and not on the chat header any more: the in-chat button
// crowded the toolbar and operators wanted one central place where
// they could pull any conversation without having to click into it.

import { useEffect, useState } from "react";
import {
  Download,
  Loader2,
  MessageSquare,
  Phone,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePhoneMasker, useNameOrPhoneMasker } from "@/components/PermissionsContext";

interface ContactResult {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  message_count: number;
}

function displayName(c: ContactResult): string {
  return (
    c.name?.trim() ||
    c.profile_name?.trim() ||
    c.wa_id ||
    "Unknown contact"
  );
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "chat";
}

export function ChatExportPanel() {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          contacts?: ContactResult[];
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setResults(json.contacts ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [query]);

  async function downloadFor(contact: ContactResult) {
    setDownloadingId(contact.id);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/export`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          (j as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `chat-${sanitizeFilename(displayName(contact))}-${stamp}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
        Search by phone number or name (3+ characters), then click{" "}
        <strong>Export</strong> on the row to download that conversation as a
        WhatsApp-style <code className="font-mono text-[10px]">.txt</code> file
        (compatible with the &ldquo;Data upload&rdquo; tab too — you can re-import
        an exported chat into another workspace).
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Phone number or name…"
          className="w-full rounded-md border bg-background py-2 pl-8 pr-3 text-sm shadow-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </div>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border bg-card">
        {query.trim().length < 3 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            Type at least 3 characters to search.
          </div>
        ) : searching ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching…
          </div>
        ) : results === null || results.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No matching contacts.
          </div>
        ) : (
          <ul className="divide-y">
            {results.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/30"
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
                  <Phone className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {maskName(displayName(c))}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {maskPhone(c.wa_id)}
                    {c.message_count > 0
                      ? ` · ${c.message_count} message${c.message_count === 1 ? "" : "s"}`
                      : ""}
                    {c.last_message_at
                      ? ` · last ${new Date(c.last_message_at).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => downloadFor(c)}
                  disabled={downloadingId === c.id || c.message_count === 0}
                  title={
                    c.message_count === 0
                      ? "No messages to export"
                      : "Download chat as .txt"
                  }
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold shadow-sm transition",
                    downloadingId === c.id || c.message_count === 0
                      ? "border bg-secondary text-muted-foreground"
                      : "bg-primary text-white hover:bg-primary/90",
                  )}
                >
                  {downloadingId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {downloadingId === c.id ? "Exporting…" : "Export"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Tip: the icon next to{" "}
        <MessageSquare className="inline h-3 w-3 align-text-bottom" /> message
        counts means we ship the full thread — text, edits, deletes, and media
        URLs. Media files themselves aren&apos;t bundled, just the links.
      </p>
    </section>
  );
}
