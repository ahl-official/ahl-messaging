"use client";

// Settings → Data. Search a contact by phone / name and delete their
// chat history (or the contact entirely). Owner-only, destructive —
// every action goes through a confirmation step.

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Database,
  Download,
  Eraser,
  Loader2,
  MessageSquare,
  Phone,
  Search,
  ShieldAlert,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { usePhoneMasker, useNameOrPhoneMasker } from "@/components/PermissionsContext";
import { ChatImportPanel } from "@/components/data/ChatImportPanel";
import { NumberFixPanel } from "@/components/data/NumberFixPanel";
import { ChatExportPanel } from "@/components/data/ChatExportPanel";
import { LsqWebhookCard } from "@/components/settings/LsqWebhookCard";

type DataTab = "upload" | "export" | "remove" | "lsq";

interface ContactResult {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  message_count: number;
  business_number_label: string | null;
}

interface PendingDelete {
  contact: ContactResult;
  mode: "history" | "contact";
}

export function DataView() {
  const [tab, setTab] = useState<DataTab>("upload");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Debounced search
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
        const json = (await res.json()) as { contacts?: ContactResult[]; error?: string };
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

  async function refreshAfterDelete() {
    if (query.trim().length >= 3) {
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(query.trim())}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as { contacts?: ContactResult[] };
        setResults(json.contacts ?? []);
      }
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Eraser}
        tone="rose"
        title="Data"
        subtitle="Bring old chats into this workspace or clear contact history. Owner-only — destructive actions live under Data remove."
      />

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          {/* Tab strip — Upload (constructive) vs Remove (destructive). Two
              very different intents share the same page so the operator
              has one place to manage workspace-wide chat data, but a tab
              switch keeps the destructive UI out of sight during imports. */}
          <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-1 shadow-sm">
            <TabButton
              active={tab === "upload"}
              onClick={() => setTab("upload")}
              icon={Database}
              label="Data upload"
              tone="emerald"
            />
            <TabButton
              active={tab === "export"}
              onClick={() => setTab("export")}
              icon={Download}
              label="Chat export"
              tone="sky"
            />
            <TabButton
              active={tab === "lsq"}
              onClick={() => setTab("lsq")}
              icon={Webhook}
              label="LeadSquared"
              tone="violet"
            />
            <TabButton
              active={tab === "remove"}
              onClick={() => setTab("remove")}
              icon={Eraser}
              label="Data remove"
              tone="rose"
            />
          </div>

          {tab === "upload" ? (
            <div className="space-y-5">
              <ChatImportPanel />
              <NumberFixPanel />
            </div>
          ) : null}
          {tab === "export" ? <ChatExportPanel /> : null}
          {tab === "lsq" ? <LsqWebhookCard /> : null}

          {tab === "remove" ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <strong>Destructive actions.</strong> Clearing chat history removes
                  messages permanently — this cannot be undone. The contact remains so
                  future inbound messages still arrive at the dashboard. Deleting
                  the contact also removes their notes, tags, and automation logs.
                </div>
              </div>

              {flash ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  {flash}
                </div>
              ) : null}

              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by phone (+91 90847 23091), name, or WhatsApp ID…"
                    className="w-full rounded-lg border bg-background py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                  {searching ? (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  Enter at least 3 characters. Phone search ignores spaces and country code prefixes.
                </div>
              </div>

              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              {results !== null ? (
                results.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-card px-6 py-8 text-center text-sm text-muted-foreground">
                    No contacts match &ldquo;{query}&rdquo;.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {results.map((c) => (
                      <ContactRow
                        key={c.id}
                        contact={c}
                        onClear={() => setPending({ contact: c, mode: "history" })}
                        onDeleteContact={() => setPending({ contact: c, mode: "contact" })}
                      />
                    ))}
                  </ul>
                )
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {pending ? (
        <ConfirmDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(msg) => {
            setFlash(msg);
            setTimeout(() => setFlash(null), 4000);
            refreshAfterDelete();
          }}
        />
      ) : null}
    </div>
  );
}

function ContactRow({
  contact,
  onClear,
  onDeleteContact,
}: {
  contact: ContactResult;
  onClear: () => void;
  onDeleteContact: () => void;
}) {
  const maskPhone = usePhoneMasker();
  const maskName = useNameOrPhoneMasker();
  const display = contact.name?.trim() || contact.profile_name?.trim() || contact.wa_id;
  const initials =
    display
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join("") || "?";

  return (
    <li className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-sm font-semibold text-foreground/70 ring-1 ring-inset ring-border">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{maskName(display)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono">
              <Phone className="h-3 w-3" />
              {maskPhone(formatPhone(contact.wa_id))}
            </span>
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              {contact.message_count} {contact.message_count === 1 ? "message" : "messages"}
            </span>
            {contact.last_message_at ? (
              <span>
                Last:{" "}
                {new Date(contact.last_message_at).toLocaleString(undefined, {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
            {contact.business_number_label ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-100"
                title="WhatsApp number this chat is on"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {contact.business_number_label}
              </span>
            ) : null}
          </div>
          {contact.last_message_preview ? (
            <div className="mt-1 line-clamp-1 rounded-md bg-secondary/40 px-2 py-1 text-[11px] text-foreground/75">
              {contact.last_message_preview}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onClear}
            disabled={contact.message_count === 0}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eraser className="h-3 w-3" />
            Clear chat history
          </button>
          <button
            type="button"
            onClick={onDeleteContact}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
            Delete contact
          </button>
        </div>
      </div>
    </li>
  );
}

function ConfirmDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingDelete;
  onClose: () => void;
  onDone: (flash: string) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const maskName = useNameOrPhoneMasker();
  const expected = pending.mode === "contact" ? "DELETE" : "CLEAR";
  const c = pending.contact;
  const display = maskName(c.name?.trim() || c.profile_name?.trim() || c.wa_id);

  async function handleDelete() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/contacts/${c.id}?mode=${pending.mode}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as {
        error?: string;
        deleted_messages?: number;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onDone(
        pending.mode === "contact"
          ? `Deleted ${display} and all their data.`
          : `Cleared ${json.deleted_messages ?? c.message_count} messages for ${display}.`,
      );
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-lg",
                pending.mode === "contact"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-amber-100 text-amber-700",
              )}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <h3 className="text-sm font-semibold">
              {pending.mode === "contact" ? "Delete contact" : "Clear chat history"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4 text-sm">
          <p>
            {pending.mode === "contact" ? (
              <>
                You&apos;re about to <strong>permanently delete</strong>{" "}
                <span className="font-semibold">{display}</span> and everything tied to them: messages, notes, tags, and automation logs.
              </>
            ) : (
              <>
                You&apos;re about to <strong>delete {c.message_count} messages</strong> for{" "}
                <span className="font-semibold">{display}</span>. The contact stays so future inbound messages still arrive — just the history is wiped.
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            This cannot be undone. Type <span className="font-mono font-bold">{expected}</span> to confirm.
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={`Type ${expected}`}
            autoFocus
            className="w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:border-destructive focus:ring-2 focus:ring-destructive/20"
          />
          {err ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {err}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={confirmText !== expected || busy}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:opacity-40",
              pending.mode === "contact"
                ? "bg-destructive hover:bg-destructive/90"
                : "bg-amber-600 hover:bg-amber-700",
            )}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            {pending.mode === "contact" ? "Delete contact" : "Clear history"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ----- Tab pill used at the top of the Data page. Two tones so the
// destructive "remove" tab visually telegraphs the risk even when not
// active. -----
function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Eraser;
  label: string;
  tone: "emerald" | "rose" | "sky" | "violet";
}) {
  const activeCls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200"
      : tone === "sky"
        ? "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200"
        : tone === "violet"
          ? "bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-200"
          : "bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-200";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition",
        active ? activeCls : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
