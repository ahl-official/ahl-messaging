"use client";

import { useEffect, useState, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { CalendarDays, CircleDollarSign, Loader2, Paperclip, SpellCheck2, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, imageFromClipboard } from "@/lib/utils";
import type { ComposerMode } from "@/components/ComposerTabs";
import { TemplatePicker, type TemplateSummary } from "@/components/TemplatePicker";
import { AttachButton } from "@/components/AttachButton";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";
import { EmojiPicker } from "@/components/composer/EmojiPicker";
import { QuickRepliesButton, isRichQuickReply } from "@/components/composer/QuickRepliesButton";
import { VoiceRecordButton } from "@/components/composer/VoiceRecordButton";
import { SuggestReplyButton } from "@/components/contact-panel/SuggestReplyButton";
import { PolishButton } from "@/components/PolishButton";
import { PaymentLinkButton } from "@/components/composer/PaymentLinkButton";
import type { QuickReply } from "@/components/QuickRepliesManager";

interface Props {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onSend: (text: string) => Promise<void>;
  onSaveNote: (text: string) => Promise<void>;
  /** Sends a rich quick reply (media / button) directly. */
  onSendRich?: (q: QuickReply) => Promise<void> | void;
  onSendTemplate?: (template: TemplateSummary) => Promise<void>;
  onSendFile?: (file: File, caption: string) => Promise<void>;
  /** Sends a recorded voice note (audio File). Separate from onSendFile —
   *  voice goes through /api/voice-note (Supabase) so it works on Evolution
   *  numbers too (sendWhatsAppAudio), not just Meta. */
  onSendVoice?: (file: File) => Promise<void>;
  /** Opens the Magic Message composer — used to send a `magic_message`
   *  utility template with dynamic text + image even when the 24h window
   *  is closed. Parent supplies the actual flow. */
  onMagicMessage?: () => void;
  /** Opens Date Align (booking). Only passed when the operator has the
   *  can_align_dates permission — the composer icon hides otherwise. */
  onDateAlign?: () => void;
  /** Fires on each composer keystroke (reply mode only). Throttled by parent. */
  onTyping?: () => void;
  /** False = WhatsApp 24h window is closed; only templates may be sent. */
  windowOpen?: boolean;
  disabled?: boolean;
  /** Contact's business_phone_number_id — scopes the template picker to
   *  the portfolio that owns this number. Without it the picker would
   *  default to the legacy single-tenant env-var portfolio and leak
   *  templates from the wrong account. */
  phoneNumberId?: string | null;
  /** Contact id — powers the AI "Suggest reply" toolbar button. */
  contactId?: string | null;
  /** Quoted-reply context. When non-null, the composer renders a
   *  small preview banner above the textarea (snippet + cancel) so
   *  the operator can confirm or back out before sending. The parent
   *  (ChatWindow) owns the actual reply-to wamid + clears it after a
   *  successful send. */
  replyingTo?: {
    content: string | null;
    direction: "inbound" | "outbound" | null;
  } | null;
  onCancelReply?: () => void;
  /** Files dropped onto the chat (drag-and-drop) — staged as attachments here.
   *  The parent clears them via onIncomingFilesConsumed once staged. */
  incomingFiles?: File[] | null;
  onIncomingFilesConsumed?: () => void;
  /** Tighter padding + shorter textarea for embedded/narrow panels
   *  (e.g. the bird's-eye wall). Leaves the inbox composer unchanged. */
  compact?: boolean;
}

export function MessageInput({
  mode,
  onModeChange,
  onSend,
  onSaveNote,
  onSendRich,
  onSendTemplate,
  onSendFile,
  onSendVoice,
  onMagicMessage,
  onDateAlign,
  onTyping,
  windowOpen = true,
  disabled,
  phoneNumberId,
  contactId,
  replyingTo,
  onCancelReply,
  incomingFiles,
  onIncomingFilesConsumed,
  compact = false,
}: Props) {
  // Notes are internal — always allowed regardless of the WhatsApp window.
  // Free-form replies + file attachments only when the window is open.
  const freeformLocked = !windowOpen && mode !== "note";
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  // A picked/pasted file waiting for the operator to confirm. We show a
  // preview + let them type a caption, then Send fires it — instead of the
  // old behaviour of sending the instant a file was chosen.
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ id: string; file: File; previewUrl: string | null }>
  >([]);
  const attachIdRef = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Mirrors the staged attachments' blob URLs so the unmount cleanup can revoke
  // them (an empty-dep effect would close over a stale value).
  const pendingPreviewsRef = useRef<string[]>([]);
  // Synchronous lock — `sending` state alone isn't enough because a quick
  // double-click / double-Enter can fire two `handleSubmit` calls before
  // React applies the `setSending(true)` update. Both closures see
  // `sending=false` and proceed, sending the same message twice.
  const sendingLockRef = useRef(false);

  // Quick-reply autocomplete. We fetch the list lazily on first slash, then
  // cache it for the lifetime of the composer. The popover only appears in
  // reply mode while the cursor is at the end of a `/word` token.
  const [quickReplies, setQuickReplies] = useState<QuickReply[] | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);

  // Spell-correct — runs the draft through OpenAI for conservative
  // typo/grammar fixes (no rewrites). Disabled while empty or sending.
  const [correcting, setCorrecting] = useState(false);
  async function handleSpellCorrect() {
    const text = value.trim();
    if (!text || correcting || disabled || sending) return;
    setCorrecting(true);
    try {
      const res = await fetch("/api/spell-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json()) as { text?: string; error?: string };
      if (res.ok && j.text) setValue(j.text);
    } catch {
      /* silent — operator can re-trigger */
    } finally {
      setCorrecting(false);
    }
  }

  useEffect(() => {
    if (slashQuery === null || quickReplies !== null) return;
    // Scope to this chat's business number — server filters out
    // snippets that target a different number. Global snippets (empty
    // bpid list) always pass through.
    const url = phoneNumberId
      ? `/api/quick-replies?phone_number_id=${encodeURIComponent(phoneNumberId)}`
      : "/api/quick-replies";
    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { quick_replies?: QuickReply[] }) => {
        setQuickReplies(j.quick_replies ?? []);
      })
      .catch(() => setQuickReplies([]));
  }, [slashQuery, quickReplies, phoneNumberId]);

  // When the active chat switches to another business number, clear the
  // cached list so the next /trigger refetches against the new number.
  useEffect(() => {
    setQuickReplies(null);
  }, [phoneNumberId]);

  const slashSuggestions = (() => {
    if (slashQuery === null || !quickReplies) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return quickReplies.slice(0, 8);
    return quickReplies.filter((qr) => qr.shortcut.toLowerCase().startsWith(q)).slice(0, 8);
  })();
  const slashOpen = slashQuery !== null && slashSuggestions.length > 0;

  const isNote = mode === "note";

  function handleSubmit() {
    if (sendingLockRef.current || disabled) return;

    // Staged attachments → send each file. The typed caption rides the FIRST
    // file (WhatsApp-style single caption for the batch). Sits before the
    // text-empty guard so caption-less images can still go out.
    if (pendingAttachments.length > 0) {
      if (!onSendFile || freeformLocked) return;
      const batch = pendingAttachments;
      const caption = value.trim();
      // WhatsApp-style: clear + FREE the composer instantly and fire every file
      // in PARALLEL. Each onSendFile renders its own optimistic bubble and
      // uploads in the background + owns its failure state — so there's no
      // sending-lock and nothing to wait for. The operator can keep sending
      // straight away instead of staring at "Sending…". Clearing pending now
      // also guards against a double-submit re-sending the batch.
      setPendingAttachments([]);
      setValue("");
      batch.forEach((a, i) => {
        void onSendFile(a.file, i === 0 ? caption : "").catch(() => {});
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
      ref.current?.focus();
      return;
    }

    if (freeformLocked) return; // window expired, only templates allowed
    const text = value.trim();
    if (!text) return;
    // Synchronous guard against a same-tick double-Enter (two keydowns
    // before React clears the value). Released on the NEXT tick — not after
    // the network round-trip — so the operator can immediately type + send
    // the next message. WhatsApp-style: type, Enter, type, Enter.
    sendingLockRef.current = true;
    setTimeout(() => {
      sendingLockRef.current = false;
    }, 0);
    const previous = value;
    setValue("");
    // Keep the cursor in the box. We deliberately do NOT set `sending`
    // (which disables + blurs the textarea) or await the round-trip on the
    // text path — the optimistic bubble already renders the message
    // instantly, so blocking the composer just made it feel slow and stole
    // focus. Fire the send and move on.
    ref.current?.focus();
    const task = isNote ? onSaveNote(text) : onSend(text);
    task.catch(() => {
      // Restore the draft only if the operator hasn't started a new one.
      setValue((v) => (v.trim() ? v : previous));
    });
  }

  async function handleTemplatePick(t: TemplateSummary) {
    if (!onSendTemplate || sendingLockRef.current || disabled) return;
    sendingLockRef.current = true;
    setSending(true);
    try {
      await onSendTemplate(t);
    } finally {
      sendingLockRef.current = false;
      setSending(false);
      ref.current?.focus();
    }
  }

  // Stage a picked/pasted file as a preview instead of sending it. The actual
  // send happens from handleSubmit (Send button / Enter) with the typed
  // caption. Replaces any previous pending file (revokes its blob first).
  function handlePendingAttachments(files: File[]) {
    if (!onSendFile || disabled || freeformLocked || isNote || files.length === 0)
      return;
    const staged = files.map((file) => ({
      id: `att-${attachIdRef.current++}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setPendingAttachments((prev) => [...prev, ...staged]);
    ref.current?.focus();
  }

  function handleRemovePending(id: string) {
    setPendingAttachments((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function clearPending() {
    setPendingAttachments((prev) => {
      prev.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
      return [];
    });
  }

  // Drop staged attachments when we leave reply mode — Notes is text-only.
  useEffect(() => {
    if (isNote) clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNote]);

  // Files dragged onto the chat (handled by ChatWindow) get staged here.
  useEffect(() => {
    if (incomingFiles && incomingFiles.length > 0) {
      handlePendingAttachments(incomingFiles);
      onIncomingFilesConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingFiles]);
  // Revoke staged blobs on unmount. ChatWindow is keyed by contact id, so
  // switching chats unmounts this composer entirely (no contactId-change to
  // hook); the ref lets the mount-scoped cleanup see the current URLs.
  useEffect(() => {
    pendingPreviewsRef.current = pendingAttachments
      .map((a) => a.previewUrl)
      .filter((u): u is string => u !== null);
  }, [pendingAttachments]);
  useEffect(
    () => () => {
      pendingPreviewsRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  // Paste an image straight into the composer — copied screenshot / image is
  // staged as a preview (same as the Attach button) so the operator can add a
  // caption and confirm before it sends. Non-image pastes fall through to the
  // normal text paste. Notes are internal text-only, so we skip them. When the
  // 24h window is closed the textarea is disabled and never receives a paste —
  // that case is handled by the Magic Message flow in ChatWindow instead.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (isNote || !onSendFile) return;
    const file = imageFromClipboard(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    handlePendingAttachments([file]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Slash-autocomplete keys (only when popover is open + has matches).
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Returns the active `/word` query at the caret, or null if not present.
  // Matches at start-of-text or after whitespace so a literal slash inside
  // a URL ("https://example.com/foo") never triggers the popover.
  function detectSlashQuery(text: string, caret: number): string | null {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)\/([a-z0-9_-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  }

  function applyQuickReply(qr: QuickReply) {
    // Rich (media / button) snippets can't be inserted into the textarea —
    // send them directly. Strip the `/token` and clear the slash menu first.
    if (isRichQuickReply(qr) && onSendRich) {
      const caret = ref.current?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const tokenMatch = before.match(/\/[a-z0-9_-]*$/i);
      const head = before.slice(0, before.length - (tokenMatch ? tokenMatch[0].length : 0));
      setValue(head + value.slice(caret));
      setSlashQuery(null);
      void onSendRich(qr);
      return;
    }
    const ta = ref.current;
    const caret = ta?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    // Strip the `/word` token immediately preceding the caret.
    const tokenMatch = before.match(/\/[a-z0-9_-]*$/i);
    const tokenLen = tokenMatch ? tokenMatch[0].length : 0;
    const head = before.slice(0, before.length - tokenLen);
    const newValue = head + qr.body + after;
    setValue(newValue);
    setSlashQuery(null);
    const newCaret = head.length + qr.body.length;
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(newCaret, newCaret);
    });
  }

  function insertText(text: string) {
    const ta = ref.current;
    if (!ta) {
      setValue((v) => v + text);
      return;
    }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      const pos = start + text.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function insertEmoji(emoji: string) {
    insertText(emoji);
  }

  return (
    <div
      className={cn(
        "flex items-stretch gap-2 border-t",
        compact ? "px-1.5 py-1.5 gap-1.5" : "px-2.5 py-2 sm:gap-3 sm:py-4",
        isNote ? "bg-amber-50 border-amber-200" : "bg-card",
      )}
    >
      {/* Composer card: tabs + icons header, textarea below. min-w-0 lets it
          shrink so the Send button stays visible on narrow / embedded views. */}
      <div
        className={cn(
          "composer-card min-w-0 flex-1 rounded-lg border",
          isNote ? "border-amber-300 bg-white" : "border-input bg-background",
        )}
      >
        {/* Header — desktop: tabs left + icons right. Compact (narrow panels):
            icons in a horizontal-scroll row ABOVE the tabs so they don't wrap
            into a tall block. */}
        <div
          className={cn(
            "border-b px-2 py-1",
            compact ? "flex flex-col-reverse items-stretch gap-1" : "flex items-center justify-between gap-2",
          )}
        >
          <div className="flex items-center">
            <InlineTab
              label="Reply"
              active={!isNote}
              onClick={() => onModeChange("reply")}
            />
            <InlineTab
              label="Notes"
              active={isNote}
              tintNote
              onClick={() => onModeChange("note")}
            />
          </div>

          {!isNote ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-0.5",
                compact ? "w-full flex-nowrap justify-between overflow-x-auto" : "flex-wrap justify-end",
              )}
            >
              <PaymentLinkButton
                contactId={contactId ?? null}
                disabled={disabled || sending || freeformLocked}
                onPrefill={(text) => setValue(text)}
              />
              {contactId ? (
                <SuggestReplyButton
                  contactId={contactId}
                  onPick={setValue}
                  disabled={disabled || sending || freeformLocked}
                />
              ) : null}
              <QuickRepliesButton
                onPick={insertText}
                onSendRich={onSendRich}
                disabled={disabled || sending || freeformLocked}
                phoneNumberId={phoneNumberId}
                overlay
              />
              {/* Spell-correct — runs the draft through the AI on click.
                  Conservative: fixes typos/grammar only, no rewrites. */}
              <ComposerIconButton
                icon={correcting ? Loader2 : SpellCheck2}
                label={correcting ? "Correcting…" : "Fix spelling & grammar"}
                disabled={!value.trim() || disabled || sending || freeformLocked || correcting}
                onClick={handleSpellCorrect}
                className={cn(correcting && "[&_svg]:animate-spin")}
              />
              {/* Hinglish → professional English rewrite. */}
              <PolishButton
                text={value}
                onResult={setValue}
                disabled={disabled || sending || freeformLocked}
              />
              {/* Magic Message — sends a `magic_message` utility template
                  (with dynamic text + image) to bypass the 24h window.
                  Wiring TBD once the flow is confirmed. */}
              <ComposerIconButton
                icon={WandSparkles}
                label="Magic Message"
                disabled={disabled || sending}
                onClick={onMagicMessage}
                className="text-fuchsia-600 hover:bg-fuchsia-50 hover:text-fuchsia-700"
              />
              {/* Date Align — booking. Only rendered when the operator has the
                  permission (parent passes the handler only then). */}
              {onDateAlign ? (
                <ComposerIconButton
                  icon={CalendarDays}
                  label="Date Align"
                  disabled={disabled || sending}
                  onClick={onDateAlign}
                  className="text-primary hover:bg-primary/10 hover:text-primary"
                />
              ) : null}
              {onSendFile ? (
                <AttachButton
                  disabled={disabled || sending || freeformLocked}
                  onFiles={handlePendingAttachments}
                />
              ) : (
                <ComposerIconButton icon={CircleDollarSign} label="Attach" comingSoon />
              )}
              {/* Voice note — Evolution numbers only (parent passes onSendVoice). */}
              {onSendVoice && !isNote ? (
                <VoiceRecordButton disabled={disabled || freeformLocked} onRecorded={onSendVoice} />
              ) : null}
              {/* Templates always available — they're the only way to message
                  outside the 24-hour window. */}
              {onSendTemplate ? (
                <TemplatePicker
                  disabled={disabled || sending}
                  onSelect={handleTemplatePick}
                  phoneNumberId={phoneNumberId}
                  overlay
                />
              ) : null}
              <EmojiPicker
                disabled={disabled || sending || freeformLocked}
                onPick={insertEmoji}
              />
            </div>
          ) : null}
        </div>

        {/* Quoted-reply preview banner — appears when the operator
            clicks Reply on a bubble. Snippet + cancel chip; sending
            picks up the context.message_id automatically (ChatWindow
            owns the wamid). */}
        {replyingTo ? (
          <div
            className={cn(
              "mb-1.5 flex items-start gap-2 rounded-md border-l-4 bg-secondary/60 px-2.5 py-1.5",
              replyingTo.direction === "outbound"
                ? "border-primary"
                : "border-sky-500",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Replying to {replyingTo.direction === "outbound" ? "yourself" : "customer"}
              </div>
              <div className="line-clamp-2 whitespace-pre-wrap break-words text-[12px] text-foreground/80">
                {replyingTo.content?.trim() || (
                  <span className="italic text-muted-foreground">[no preview]</span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Cancel reply"
              aria-label="Cancel reply"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {/* Staged attachments — appear after a paste / attach / drop. Each is a
            small thumbnail tile with its own remove button. The caption typed
            below rides the FIRST file; Send fires them all. */}
        {pendingAttachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-2 rounded-md border border-sky-200 bg-sky-50/70 px-2.5 py-2">
            {pendingAttachments.map((a) => (
              <div
                key={a.id}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded ring-1 ring-sky-200"
                title={a.file.name}
              >
                {a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.previewUrl}
                    alt={a.file.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center bg-white px-1 text-center text-sky-600">
                    <Paperclip className="h-4 w-4" />
                    <span className="mt-0.5 w-full truncate text-[8px] text-foreground/70">
                      {a.file.name}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleRemovePending(a.id)}
                  disabled={sending}
                  className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-60"
                  title="Remove"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Textarea + slash-autocomplete popover. The popover is positioned
            relative to this wrapper so it floats just above the textarea. */}
        <div className="relative">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              // Recompute slash query from the new value and current caret.
              if (!isNote) {
                const caret = e.target.selectionStart ?? next.length;
                const q = detectSlashQuery(next, caret);
                setSlashQuery(q);
                setSlashIdx(0);
              } else {
                setSlashQuery(null);
              }
              // Fire typing indicator only in reply mode + only when there's
              // actual content. Parent throttles to one Meta API call per 20s.
              if (!isNote && onTyping && next.trim().length > 0) {
                onTyping();
              }
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              // Delay so a click on a suggestion still registers.
              setTimeout(() => setSlashQuery(null), 120);
            }}
            rows={2}
            // Native spell-check + mobile autocorrect/autocapitalize so the
            // operator sees red squiggles on typos and iOS/Android keyboards
            // fix common misspellings before the message goes out. No AI/API
            // calls — just the browser/OS keyboard doing the work.
            spellCheck
            autoCorrect="on"
            autoCapitalize="sentences"
            placeholder={
              isNote
                ? "Write an internal note…"
                : pendingAttachments.length > 0
                  ? "Add a caption… (optional)"
                  : freeformLocked
                    ? "Window closed — use Magic Message"
                    : "Reply — type /shortcut for quick replies"
            }
            disabled={disabled || sending || freeformLocked}
            className={cn(
              "w-full resize-none bg-transparent text-base sm:text-sm",
              "placeholder:text-muted-foreground focus:outline-none",
              compact ? "px-2 py-1.5 min-h-[34px] max-h-28" : "px-3 py-2.5 min-h-[44px] max-h-40 sm:min-h-[60px]",
              isNote && "placeholder:text-amber-700/60",
              freeformLocked && "cursor-not-allowed opacity-70",
            )}
          />

          {!isNote && slashOpen ? (
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
                        // Prevent textarea blur (which would close the popover
                        // before our click handler fires).
                        e.preventDefault();
                        applyQuickReply(qr);
                      }}
                      onMouseEnter={() => setSlashIdx(i)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition",
                        i === slashIdx ? "bg-primary/10" : "hover:bg-secondary",
                      )}
                    >
                      <code className="self-start rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-primary/25">
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
      </div>

      {/* Send button — large, outside the card */}
      <Button
        type="button"
        onClick={handleSubmit}
        disabled={
          disabled || sending || freeformLocked || (!value.trim() && pendingAttachments.length === 0)
        }
        className={cn(
          "h-auto self-stretch font-semibold rounded-lg",
          compact ? "px-2.5 text-xs" : "px-4 text-sm sm:px-6",
          isNote
            ? "bg-amber-600 hover:bg-amber-700 text-white shadow-md shadow-amber-600/20"
            : "btn-send text-white",
        )}
      >
        {isNote ? (sending ? "Saving…" : "Save") : sending ? "Sending…" : "Send"}
      </Button>
    </div>
  );
}

function InlineTab({
  label,
  active,
  onClick,
  tintNote,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tintNote?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-3 py-1.5 text-sm font-medium transition",
        active
          ? tintNote
            ? "text-amber-800"
            : "text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {active ? (
        <span
          className={cn(
            "absolute -bottom-1 left-3 right-3 h-0.5 rounded-full",
            tintNote ? "bg-amber-500" : "bg-primary",
          )}
        />
      ) : null}
    </button>
  );
}
