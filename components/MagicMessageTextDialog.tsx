"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BookmarkPlus, Loader2, Save, Trash2, Type, WandSparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModalShell } from "@/components/ui/ModalShell";
import { SuggestReplyButton } from "@/components/contact-panel/SuggestReplyButton";
import { PolishButton } from "@/components/PolishButton";
import type { QuickReply } from "@/components/QuickRepliesManager";

interface MmTemplate {
  id: string;
  team_id: string | null;
  title: string;
  body: string;
  created_by: string | null;
}

interface Props {
  contactId: string;
  waId: string;
  contactName: string;
  /** The contact's own business number, if it has one. When present, the
   *  message always sends from it (the picker is irrelevant). When NULL the
   *  agent MUST explicitly choose a "Send from" number — we no longer silently
   *  default to the first connected number, which used to dump every
   *  no-number contact's magic message onto one arbitrary number. */
  defaultBusinessPhoneNumberId?: string | null;
  onClose: () => void;
  /** Called after the magic_message template is successfully sent so the
   *  parent can refresh the chat / scroll to bottom / etc. */
  onSent: () => void;
}

// Pre-fills the composer with "Hi <full contact name>,\n\n" so the agent
// can immediately start typing the body on a fresh line. Uses the full
// display name (not just the first word) so multi-part names like "Head
// AI/ML" or "Birjul Saini" come out correctly. Falls back to "Hi,\n\n" when
// the contact only has a phone number on file.
function buildInitialGreeting(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Hi,\n\n";
  // Phone-only display name → "+91..." or "+1234..." — don't address by it.
  // A masked name ("•••• 91") is also a number stand-in, never a real name.
  if (trimmed.includes("•") || /^\+?\d[\d\s-]*$/.test(trimmed)) return "Hi,\n\n";
  return `Hi ${trimmed},\n\n`;
}

interface ApiResponse {
  ok?: boolean;
  error?: string;
  message?: { id: string };
}

// Match a `/word` token at the caret. Same shape as the regular composer in
// MessageInput.tsx — slash must be at start-of-text or after whitespace, so
// URLs like https://x.com/foo never trigger the popover.
function detectSlashQueryAt(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|\s)\/([a-z0-9_-]*)$/i);
  return m ? m[1].toLowerCase() : null;
}

// Composer for the "Text" branch of Magic Message. The agent types a custom
// body, we POST it to the image-generator API to render the text onto a
// branded card, then dispatch the generated image as the header of the
// magic_message utility template (which punches through the 24h window).
export function MagicMessageTextDialog({
  contactId,
  waId,
  contactName,
  defaultBusinessPhoneNumberId,
  onClose,
  onSent,
}: Props) {
  const [text, setText] = useState(() => buildInitialGreeting(contactName));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // "Send from" picker — only matters when the contact has no assigned
  // number yet. Lists template-capable numbers (Meta + Interakt, not
  // Evolution). The chosen number is passed as a fallback to the API.
  const [numbers, setNumbers] = useState<
    { phone_number_id: string; label: string }[]
  >([]);
  const [fromNumber, setFromNumber] = useState("");
  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: Array<{ phone_number_id: string; provider?: string; is_active?: boolean; verified_name?: string; nickname?: string; display_phone_number?: string }> }) => {
        const all = j.numbers ?? [];
        const label = (n: (typeof all)[number]) =>
          n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id;
        // Only the operator's toggled-ON (active) numbers, no Evolution.
        const list = all
          .filter((n) => n.provider !== "evolution" && n.is_active)
          .map((n) => ({ phone_number_id: n.phone_number_id, label: label(n) }));
        // Keep the open chat's own number selectable even if it's toggled off.
        if (
          defaultBusinessPhoneNumberId &&
          !list.some((n) => n.phone_number_id === defaultBusinessPhoneNumberId)
        ) {
          const own = all.find((n) => n.phone_number_id === defaultBusinessPhoneNumberId);
          if (own && own.provider !== "evolution") {
            list.unshift({ phone_number_id: own.phone_number_id, label: label(own) });
          }
        }
        setNumbers(list);
        // Default: the open chat's number if there is one, else the first
        // active (currently-working) number.
        setFromNumber((cur) => cur || defaultBusinessPhoneNumberId || list[0]?.phone_number_id || "");
      })
      .catch(() => {});
  }, [defaultBusinessPhoneNumberId]);

  // Team-scoped templates — loaded once on open. UI surfaces the
  // operator's team templates + any workspace-wide rows so org-wide
  // boilerplate stays available even after teams diverge.
  const [templates, setTemplates] = useState<MmTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateTitle, setTemplateTitle] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);

  useEffect(() => {
    fetch("/api/magic-message/templates", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((j: { templates?: MmTemplate[] }) => setTemplates(j.templates ?? []))
      .catch(() => setTemplates([]));
  }, []);

  async function saveTemplate() {
    const title = templateTitle.trim();
    if (!title) return;
    setSavingTemplate(true);
    try {
      const res = await fetch("/api/magic-message/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: text.trim() }),
      });
      const j = (await res.json()) as { template?: MmTemplate; error?: string };
      if (!res.ok) {
        setError(j.error ?? "Save failed");
        return;
      }
      if (j.template) setTemplates((t) => [...t, j.template!]);
      setShowSaveForm(false);
      setTemplateTitle("");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm("Delete this template?")) return;
    const res = await fetch(
      `/api/magic-message/templates?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (res.ok) setTemplates((t) => t.filter((x) => x.id !== id));
  }

  // Park the cursor at the end of the pre-filled greeting so the agent can
  // continue typing the body without manually moving the caret first.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
  }, []);

  // Quick-reply autocomplete (mirrors MessageInput.tsx). Lazy-fetched on
  // first slash; agents type /shortcut, popover suggests, Enter inserts.
  const [quickReplies, setQuickReplies] = useState<QuickReply[] | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);

  useEffect(() => {
    if (slashQuery === null || quickReplies !== null) return;
    fetch("/api/quick-replies", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { quick_replies?: QuickReply[] }) => {
        setQuickReplies(j.quick_replies ?? []);
      })
      .catch(() => setQuickReplies([]));
  }, [slashQuery, quickReplies]);

  const slashSuggestions = (() => {
    if (slashQuery === null || !quickReplies) return [];
    const q = slashQuery;
    if (!q) return quickReplies.slice(0, 8);
    return quickReplies.filter((qr) => qr.shortcut.startsWith(q)).slice(0, 8);
  })();
  const slashOpen = slashQuery !== null && slashSuggestions.length > 0;

  function applyQuickReply(qr: QuickReply) {
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const tokenMatch = before.match(/\/[a-z0-9_-]*$/i);
    const tokenLen = tokenMatch ? tokenMatch[0].length : 0;
    const head = before.slice(0, before.length - tokenLen);
    const newValue = head + qr.body + after;
    setText(newValue);
    setSlashQuery(null);
    const newCaret = head.length + qr.body.length;
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(newCaret, newCaret);
    });
  }

  function onTextareaKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashSuggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = slashSuggestions[slashIdx];
        if (pick) applyQuickReply(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
  }

  const trimmed = text.trim();
  // When the contact has no number of its own, a "Send from" choice is
  // mandatory — otherwise the message would have no number to route through
  // (and we no longer silently pick one).
  const needsNumberPick = !defaultBusinessPhoneNumberId && !fromNumber;
  const canSend = trimmed.length > 0 && !sending && !needsNumberPick;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/magic-message/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          wa_id: waId,
          text: trimmed,
          business_phone_number_id: fromNumber || undefined,
        }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSent();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <ModalShell
      overlayClassName="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-lg border bg-card shadow-xl"
    >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-fuchsia-50 text-fuchsia-600 ring-1 ring-fuchsia-100">
              <WandSparkles className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5">
                Magic Message
                <span className="inline-flex items-center gap-1 rounded bg-fuchsia-50 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-700 ring-1 ring-fuchsia-100">
                  <Type className="h-3 w-3" />
                  Text
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                To {contactName}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {/* Team-saved templates picker. Hidden unless the operator
              clicks "Templates" — keeps the dialog uncluttered for
              fresh sends but one click away when wanted. */}
          <div className="flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={() => setShowTemplates((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold transition",
                showTemplates
                  ? "bg-fuchsia-100 text-fuchsia-800"
                  : "bg-secondary text-muted-foreground hover:text-foreground",
              )}
            >
              Templates · {templates.length}
            </button>
            <button
              type="button"
              onClick={() => setShowSaveForm((v) => !v)}
              disabled={!text.trim() || sending}
              className="inline-flex items-center gap-1 text-fuchsia-700 font-semibold hover:underline disabled:opacity-50"
              title="Save current text as a team template"
            >
              <BookmarkPlus className="h-3 w-3" />
              Save as template
            </button>
          </div>
          {showTemplates && templates.length > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-secondary/30 p-1.5">
              {templates.map((t) => (
                <li
                  key={t.id}
                  className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-card"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setText(t.body);
                      setShowTemplates(false);
                    }}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold">{t.title}</span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0 text-[9px] font-bold",
                          t.team_id
                            ? "bg-fuchsia-100 text-fuchsia-700"
                            : "bg-slate-200 text-slate-700",
                        )}
                      >
                        {t.team_id ? "Team" : "Workspace"}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                      {t.body}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteTemplate(t.id)}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-700"
                    title="Delete template"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {showSaveForm ? (
            <div className="flex items-center gap-2 rounded-md border border-fuchsia-200 bg-fuchsia-50/40 px-2 py-2">
              <input
                type="text"
                value={templateTitle}
                onChange={(e) => setTemplateTitle(e.target.value)}
                placeholder="Template name (e.g. Welcome script)"
                maxLength={80}
                disabled={savingTemplate}
                className="h-7 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={saveTemplate}
                disabled={savingTemplate || !templateTitle.trim() || !text.trim()}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-fuchsia-600 px-2 text-[11px] font-semibold text-white hover:bg-fuchsia-700 disabled:opacity-50"
              >
                {savingTemplate ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                Save
              </button>
            </div>
          ) : null}
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Your message
              </label>
              <div className="flex items-center gap-1.5">
                <PolishButton text={text} onResult={setText} variant="chip" />
                <SuggestReplyButton
                  contactId={contactId}
                  onPick={setText}
                  variant="chip"
                />
              </div>
            </div>
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => {
                  const next = e.target.value;
                  setText(next);
                  const caret = e.target.selectionStart ?? next.length;
                  setSlashQuery(detectSlashQueryAt(next, caret));
                  setSlashIdx(0);
                }}
                onKeyDown={onTextareaKeyDown}
                onBlur={() => {
                  // Delay so a click on a suggestion still registers.
                  setTimeout(() => setSlashQuery(null), 120);
                }}
                autoFocus
                rows={5}
                placeholder="Type your message — /shortcut for quick replies"
                className={cn(
                  "w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none",
                  "focus:border-primary focus:ring-2 focus:ring-primary/10",
                )}
                disabled={sending}
              />

              {slashOpen ? (
                <div className="absolute bottom-full left-0 right-0 mb-2 z-40 max-h-64 overflow-auto rounded-lg border bg-card shadow-xl">
                  <div className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Quick replies · ↑↓ to navigate, Enter to insert
                  </div>
                  <ul>
                    {slashSuggestions.map((qr, i) => (
                      <li key={qr.id}>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            // Prevent textarea blur (which would close the
                            // popover before our click handler fires).
                            e.preventDefault();
                            applyQuickReply(qr);
                          }}
                          onMouseEnter={() => setSlashIdx(i)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition",
                            i === slashIdx ? "bg-emerald-50" : "hover:bg-secondary",
                          )}
                        >
                          <code className="self-start rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">
                            /{qr.shortcut}
                          </code>
                          <span className="line-clamp-2 text-xs text-foreground/80">
                            {qr.body}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="mt-1 flex items-center justify-end text-[10px] text-muted-foreground">
              <span>{trimmed.length} chars</span>
            </div>
          </div>

          {/* "Send from" — only shown when the contact has NO number of its
              own. From inside a chat the contact already has a number, so the
              send routes through it and the picker is hidden (the API ignores
              it anyway). It only appears for number-less contacts that need an
              explicit choice. */}
          {!defaultBusinessPhoneNumberId && numbers.length > 0 ? (
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0">Send from</span>
              <select
                value={fromNumber}
                onChange={(e) => setFromNumber(e.target.value)}
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
              >
                {numbers.map((n) => (
                  <option key={n.phone_number_id} value={n.phone_number_id}>
                    {n.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {needsNumberPick && numbers.length > 0 ? (
            <div className="rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              This contact has no number yet — choose which number to send from
              above before sending.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-semibold text-white shadow-sm",
              "bg-fuchsia-600 hover:bg-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <WandSparkles className="h-3.5 w-3.5" />
                Send Magic Message
              </>
            )}
          </button>
        </div>
    </ModalShell>
  );
}
