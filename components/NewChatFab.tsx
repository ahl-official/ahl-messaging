"use client";

// Floating "Start new chat" launcher. Sits above the AI assistant FAB
// in the bottom-right cluster. Lets the operator key in a fresh phone
// number, pick a business number to send FROM (filtered to numbers
// they have access to), and dispatch the first message — Meta numbers
// route through Magic Message (templates required outside the 24h
// window), Evolution numbers send directly.
//
// After send, the dashboard navigates to /dashboard?c=<contact_id> so
// the operator lands in the new chat thread.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { emitFabClose, emitFabOpen, useFabsFlat } from "@/lib/fab-layout";
import {
  dockHideClasses,
  useFloatingDock,
} from "@/components/FloatingDockToggle";

interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  provider?: "meta" | "evolution" | null;
  /** Per-user toggle — true when the operator has this number switched ON. */
  is_active?: boolean;
}

export function NewChatFab() {
  const [open, setOpen] = useState(false);
  const flat = useFabsFlat();
  const { collapsed: dockCollapsed, mounted: dockMounted } = useFloatingDock();

  // Notify the shared layout that we're open so sibling FABs flatten
  // out of the popover's way. Cleanup ensures the state can't get
  // wedged "open" if the dialog unmounts unexpectedly.
  useEffect(() => {
    if (open) emitFabOpen("new-chat");
    else emitFabClose("new-chat");
    return () => emitFabClose("new-chat");
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Two positions, smoothly animated:
        //   flat (any FAB open) → bottom row, right-[11.5rem]
        //   stacked (idle)      → above AI assistant, right-5
        className={cn(
          "group fixed z-[55] hidden md:inline-flex h-16 w-16 items-center justify-center rounded-full bg-card text-foreground shadow-lg ring-1 ring-border transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl",
          flat
            ? "bottom-5 right-[11.5rem]"
            : "bottom-[11rem] right-5",
          dockHideClasses(dockCollapsed, dockMounted),
        )}
        title="Start a new chat"
        aria-label="Start a new chat"
      >
        {/* Animated glow ring — pulses softly so the button reads as
            "an action you can take" without being noisy. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[-3px] rounded-full bg-gradient-to-br from-sky-400/40 via-violet-400/40 to-pink-400/40 opacity-70 blur-[6px] transition group-hover:opacity-100 group-hover:blur-[8px]"
        />
        {/* Gradient core. Conic so the hue rotates slightly across the
            disc and looks alive instead of a flat fill. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] rounded-full bg-[conic-gradient(from_220deg_at_50%_50%,#0ea5e9_0deg,#6366f1_120deg,#a855f7_220deg,#ec4899_320deg,#0ea5e9_360deg)] shadow-inner"
        />
        {/* Glassy highlight on top half. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] rounded-full bg-gradient-to-b from-white/30 via-white/0 to-transparent"
        />
        <MessageSquarePlus
          className="relative h-7 w-7 text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]"
          strokeWidth={2.4}
        />
      </button>
      {open ? <NewChatDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// =====================================================================
// Dialog
// =====================================================================
// Most-common country codes for QHT salon's client base. Operator
// can still type any code by picking "Other" and editing the field —
// but 95% of inputs are India / Gulf so prioritise those at the top.
const COUNTRY_CODES: Array<{ code: string; flag: string; label: string }> = [
  { code: "91",  flag: "🇮🇳", label: "India" },
  { code: "971", flag: "🇦🇪", label: "UAE" },
  { code: "966", flag: "🇸🇦", label: "Saudi Arabia" },
  { code: "974", flag: "🇶🇦", label: "Qatar" },
  { code: "973", flag: "🇧🇭", label: "Bahrain" },
  { code: "965", flag: "🇰🇼", label: "Kuwait" },
  { code: "968", flag: "🇴🇲", label: "Oman" },
  { code: "1",   flag: "🇺🇸", label: "USA / Canada" },
  { code: "44",  flag: "🇬🇧", label: "UK" },
  { code: "61",  flag: "🇦🇺", label: "Australia" },
  { code: "60",  flag: "🇲🇾", label: "Malaysia" },
  { code: "65",  flag: "🇸🇬", label: "Singapore" },
  { code: "977", flag: "🇳🇵", label: "Nepal" },
  { code: "880", flag: "🇧🇩", label: "Bangladesh" },
  { code: "92",  flag: "🇵🇰", label: "Pakistan" },
];

function NewChatDialog({ onClose }: { onClose: () => void }) {
  const [countryCode, setCountryCode] = useState("91");
  const [phone, setPhone] = useState("");
  const [bpid, setBpid] = useState("");
  const [numbers, setNumbers] = useState<BusinessNumber[]>([]);
  // Lead-number lookup state. Operator types an CRM lead #, we resolve
  // it to a phone via /api/lsq/lookup, ask "yeh number hai, add karun?",
  // and auto-fill the client-number fields on confirm.
  const [leadNum, setLeadNum] = useState("");
  const [leadLooking, setLeadLooking] = useState(false);
  const [leadHit, setLeadHit] = useState<
    | null
    | {
        wa_id: string;
        cc: string;
        national: string;
        leadName: string | null;
        leadNumberDisplay: string;
        source: "primary" | "secondary";
        primaryLabel: string | null;
        secondaryLabel: string | null;
        ownerPrimary: string | null;
        ownerSecondary: string | null;
        existsInPrimary: boolean;
        existsInSecondary: boolean;
      }
  >(null);
  const [leadErr, setLeadErr] = useState<string | null>(null);
  // True when the lookup failed with a transient/HTTP error (401
  // unauthorized, 429 LSQ rate-limit, 5xx) so we show a "Find again"
  // retry. False for a clean "not found" where retrying won't help.
  const [leadErrRetryable, setLeadErrRetryable] = useState(false);
  const [loadingNumbers, setLoadingNumbers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Existing-contact check for (resolved phone, selected sender). null =
  // not checked yet; { contact: null } = checked, none; { contact: {...} }
  // = a chat already exists on the SELECTED number. We keep status +
  // last_message_at too so we can tell if the 24h window is open.
  const [existing, setExisting] = useState<
    | null
    | {
        contact: {
          id: string;
          name: string | null;
          wa_id: string;
          status: string | null;
          last_message_at: string | null;
        } | null;
      }
  >(null);
  // True while that existence/window check is in flight — gates Send so we
  // never pick the wrong channel before the window state is known.
  const [checkingExisting, setCheckingExisting] = useState(false);
  // First-message composer. Empty = just open the chat. With text we send
  // immediately, auto-routing the channel (see sendMode below).
  const [message, setMessage] = useState("");
  const leadInputRef = useRef<HTMLInputElement | null>(null);

  // Pull numbers the operator has access to. Live-syncs in three ways:
  //   1. Fetch on dialog mount.
  //   2. Re-fetch whenever the UserMenu's on/off toggle (or any other
  //      surface) fires `business-numbers-changed`.
  //   3. 15s background poll while the dialog stays open — covers the
  //      case where a teammate adds a brand-new number from Settings
  //      while this dialog is sitting on screen.
  // The endpoint already returns the FULL list (hidden toggle returns
  // `is_active: false` rather than dropping the row) so the dropdown
  // sees every number the workspace owns, not just inbox-visible ones.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/business-numbers", { cache: "no-store" });
        const j = (await res.json()) as { numbers?: BusinessNumber[] };
        if (cancelled) return;
        // Only the operator's toggled-ON numbers — same rule as the Magic
        // Message / CRM-lookup pickers, so a new chat never goes from a
        // number the operator has switched off.
        const list = (j.numbers ?? []).filter((n) => n.is_active === true);
        setNumbers((prev) => {
          // Don't auto-pick when there's a choice — the operator must
          // consciously choose which number to send from (auto-picking the
          // first one silently routed new chats to an arbitrary number).
          // Only when exactly one number is available do we preselect it,
          // since there's nothing to choose.
          if (prev.length === 0 && list.length === 1) {
            setBpid((cur) => cur || list[0]!.phone_number_id);
          }
          return list;
        });
      } catch {
        /* dialog is still usable — operator can retry */
      } finally {
        if (!cancelled) setLoadingNumbers(false);
      }
    }
    void load();
    function onChanged() {
      void load();
    }
    window.addEventListener("business-numbers-changed", onChanged);
    const poll = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.removeEventListener("business-numbers-changed", onChanged);
      clearInterval(poll);
    };
  }, []);

  // Focus the lead-# field once mounted — the form starts with a
  // lookup now, so that's the operator's first move.
  useEffect(() => {
    leadInputRef.current?.focus();
  }, []);

  const selected = useMemo(
    () => numbers.find((n) => n.phone_number_id === bpid) ?? null,
    [numbers, bpid],
  );

  // wa_id is country code + national number, digits only. We assemble
  // them here so the rest of the flow doesn't have to know about the
  // split-input UI choice.
  const normalizedWa =
    countryCode.replace(/\D/g, "") + phone.replace(/\D/g, "");

  // Proactively check whether a chat already exists for (resolved phone,
  // selected sender). Powers two things: the "already exists on <number>"
  // notice, and the send-channel choice (open window → normal, else magic).
  // Re-runs whenever the resolved phone or the sender changes.
  useEffect(() => {
    if (normalizedWa.length < 7 || !bpid) {
      setExisting(null);
      setCheckingExisting(false);
      return;
    }
    let cancelled = false;
    setCheckingExisting(true);
    void (async () => {
      try {
        const res = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: leadHit?.leadName?.trim() || "Client",
            phone: normalizedWa,
            business_phone_number_id: bpid,
            dry_run: true,
          }),
        });
        const j = (await res.json()) as {
          exists?: boolean;
          contact?:
            | {
                id: string;
                name: string | null;
                wa_id: string;
                status: string | null;
                last_message_at: string | null;
              }
            | null;
        };
        if (cancelled) return;
        setExisting({ contact: j.exists && j.contact ? j.contact : null });
      } catch {
        if (!cancelled) setExisting({ contact: null });
      } finally {
        if (!cancelled) setCheckingExisting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalizedWa, bpid, leadHit?.leadName]);

  const existingContact = existing?.contact ?? null;
  // 24h window is "open" only for an existing chat that isn't closed and
  // has had activity. A brand-new number (no existing row) is always
  // treated as closed → on Meta it must go via Magic Message.
  const windowOpen =
    !!existingContact &&
    (existingContact.status ?? "open") !== "closed" &&
    !!existingContact.last_message_at;
  // Channel the first message will use:
  //   evolution           → "direct"  (unofficial, no window limit)
  //   meta + window open   → "normal"  (free-form text)
  //   meta + window closed → "magic"   (magic_message template; incl. new)
  const sendMode: "direct" | "normal" | "magic" | null = !selected
    ? null
    : selected.provider === "evolution"
      ? "direct"
      : windowOpen
        ? "normal"
        : "magic";

  // Resolve the typed Lead # OR mobile number to a client phone via
  // /api/lsq/lookup. Extracted so both the Find button and the "Find
  // again" retry (shown on an unauthorized / rate-limited lookup) reuse
  // it. The endpoint accepts either: >=10 digits = phone number, shorter
  // = lead number.
  const runLookup = useCallback(async () => {
    const q = leadNum.trim();
    if (q.length < 3 || leadLooking) return;
    setLeadLooking(true);
    setLeadErr(null);
    setLeadErrRetryable(false);
    setLeadHit(null);
    try {
      const res = await fetch(`/api/lsq/lookup?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const j = (await res.json()) as {
        resolved?: boolean;
        wa_id?: string;
        primary?: {
          label?: string | null;
          found?: boolean;
          lead?: {
            first_name?: string | null;
            lead_number?: string | null;
            owner_name?: string | null;
          } | null;
        };
        secondary?: {
          label?: string | null;
          found?: boolean;
          lead?: {
            first_name?: string | null;
            lead_number?: string | null;
            owner_name?: string | null;
          } | null;
        };
        error?: string;
      };
      if (!res.ok) {
        // 401 unauthorized / 429 LSQ rate-limit / 5xx — usually transient.
        // Offer a retry instead of a dead end.
        setLeadErr(j.error ?? `HTTP ${res.status}`);
        setLeadErrRetryable(true);
        return;
      }
      if (!j.resolved || !j.wa_id) {
        setLeadErr(
          "Is Lead # / mobile number ka lead nahi mila. Number sahi hai to client ne kam-se-kam ek baar kisi connected number par message kiya ho, ya CRM me lead hona chahiye.",
        );
        setLeadErrRetryable(false);
        return;
      }
      const winner =
        j.primary?.found ? { src: "primary" as const, lead: j.primary.lead }
        : j.secondary?.found ? { src: "secondary" as const, lead: j.secondary.lead }
        : null;
      const digits = j.wa_id.replace(/\D/g, "");
      let cc = "91";
      let national = digits;
      for (let len = Math.min(3, digits.length - 4); len >= 1; len--) {
        const candidate = digits.slice(0, len);
        if (COUNTRY_CODES.some((c) => c.code === candidate)) {
          cc = candidate;
          national = digits.slice(len);
          break;
        }
      }
      setLeadHit({
        wa_id: digits,
        cc,
        national,
        leadName: winner?.lead?.first_name ?? null,
        leadNumberDisplay: winner?.lead?.lead_number ?? q,
        source: winner?.src ?? "primary",
        primaryLabel: j.primary?.label ?? "Primary",
        secondaryLabel: j.secondary?.label ?? "Secondary",
        ownerPrimary: j.primary?.lead?.owner_name ?? null,
        ownerSecondary: j.secondary?.lead?.owner_name ?? null,
        existsInPrimary: !!j.primary?.found,
        existsInSecondary: !!j.secondary?.found,
      });
      // Auto-apply — load phone into the hidden state right away so the
      // operator just clicks "Open chat". No separate confirm step.
      setCountryCode(cc);
      setPhone(national);
      setExisting(null);
    } catch (e) {
      setLeadErr(e instanceof Error ? e.message : "Lookup failed");
      setLeadErrRetryable(true);
    } finally {
      setLeadLooking(false);
    }
  }, [leadNum, leadLooking]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    if (!normalizedWa || normalizedWa.length < 7) {
      setErr("Enter a valid phone number with country code.");
      return;
    }
    if (!bpid) {
      setErr("Pick a business number to open the chat under.");
      return;
    }

    setBusy(true);
    try {
      // Upsert the contact row for (wa_id, bpid) and navigate straight
      // into it. No first-message send — the inbox composer handles
      // sending once the operator is in the chat (Magic Message for Meta,
      // freeform for Evolution).
      const createRes = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Name comes from CRM lead lookup (when applicable). Falls
          // back to a generic "Lead #..." / "Client" placeholder — NOT
          // the phone — so the Magic Message greeting doesn't read
          // "Hi +91-XXXXXXXXXX". Operator can rename from the panel.
          name:
            leadHit?.leadName?.trim() ||
            (leadHit?.leadNumberDisplay
              ? `Lead #${leadHit.leadNumberDisplay}`
              : "Client"),
          phone: normalizedWa,
          business_phone_number_id: bpid,
        }),
      });
      const createJson = (await createRes.json()) as {
        contact?: { id: string; wa_id: string };
        error?: string;
      };
      if (!createRes.ok || !createJson.contact) {
        throw new Error(createJson.error ?? "Failed to create contact");
      }
      const contactId = createJson.contact.id;
      onClose();
      // Hard navigate — DashboardView's URL-hydrator runs once on
      // mount, so router.push() to the same /dashboard path doesn't
      // re-select the contact. window.location.assign() forces a fresh
      // mount which picks up ?c=<id>.
      const url = new URL(window.location.href);
      url.pathname = "/dashboard";
      url.searchParams.set("c", contactId);
      window.location.assign(url.toString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Open failed");
    } finally {
      setBusy(false);
    }
  }

  // Direct first-message send from the dialog. Ensures the contact row,
  // then auto-routes the message: Magic Message on a closed Meta window
  // (incl. brand-new numbers), normal text when the window is open or the
  // number is Evolution. Lands the operator in the chat afterwards.
  async function handleSendMessage() {
    setErr(null);
    const text = message.trim();
    if (!normalizedWa || normalizedWa.length < 7) {
      setErr("Enter a valid phone number with country code.");
      return;
    }
    if (!bpid) {
      setErr("Pick a business number to send from.");
      return;
    }
    if (!text) {
      setErr("Type a message to send.");
      return;
    }
    setBusy(true);
    try {
      const createRes = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:
            leadHit?.leadName?.trim() ||
            (leadHit?.leadNumberDisplay
              ? `Lead #${leadHit.leadNumberDisplay}`
              : "Client"),
          phone: normalizedWa,
          business_phone_number_id: bpid,
        }),
      });
      const createJson = (await createRes.json()) as {
        contact?: { id: string; wa_id: string };
        error?: string;
      };
      if (!createRes.ok || !createJson.contact) {
        throw new Error(createJson.error ?? "Failed to create contact");
      }
      const contact = createJson.contact;

      if (sendMode === "magic") {
        const res = await fetch("/api/magic-message/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: contact.id,
            wa_id: contact.wa_id,
            text,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      } else {
        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "text",
            contact_id: contact.id,
            wa_id: contact.wa_id,
            text,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      }

      onClose();
      const url = new URL(window.location.href);
      url.pathname = "/dashboard";
      url.searchParams.set("c", contact.id);
      window.location.assign(url.toString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  if (typeof document === "undefined") return null;


  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-[460px] overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95"
      >
        {/* Slim, refined header. No big gradient block — just a thin
            tinted bar with title + close, so the form itself is the hero. */}
        <div className="relative flex items-center justify-between border-b bg-gradient-to-r from-sky-50 via-white to-violet-50 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-600 text-white shadow-sm ring-1 ring-inset ring-white/40">
              <MessageSquarePlus className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-[15px] font-bold leading-tight text-foreground">
                Start a new chat
              </h3>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Type a number, pick a sender, send the first message.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Look up by LSQ Lead # — resolves to a wa_id via the cached
              column. Confirm → auto-fills the client-number fields
              below. Sits at the top because lead-first lookup is the
              most common entry point for the clinic's manual outreach. */}
          <Field label="Look up by Lead # or mobile number">
            <div className="flex items-stretch gap-2">
              <input
                ref={leadInputRef}
                value={leadNum}
                onChange={(e) => {
                  setLeadNum(e.target.value.replace(/[^\d]/g, ""));
                  setLeadHit(null);
                  setLeadErr(null);
                  setLeadErrRetryable(false);
                }}
                onKeyDown={(e) => {
                  // Enter inside the lookup field runs the lookup, not the
                  // form submit (which would try to Open chat prematurely).
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runLookup();
                  }
                }}
                placeholder="Lead # or mobile — e.g. 451531 or 9876543210"
                inputMode="numeric"
                className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
              />
              <button
                type="button"
                disabled={leadLooking || leadNum.trim().length < 3}
                onClick={() => void runLookup()}
                className="inline-flex h-11 items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {leadLooking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Find
              </button>
            </div>

            {leadHit ? (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[12px] text-emerald-900">
                {/* Compact confirmation — name + lead # only. Phone is
                    auto-loaded into form state on Find; we don't reveal
                    it here on purpose. Owner / CRM badges hidden too —
                    the operator only needs to know which lead matched
                    before they hit Open chat. */}
                <div className="min-w-0 truncate font-semibold">
                  <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white">
                    <Check className="h-3 w-3" />
                  </span>
                  Loaded: {leadHit.leadName?.trim() || "Lead"} · #{leadHit.leadNumberDisplay}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLeadHit(null);
                    setLeadNum("");
                    setPhone("");
                    setLeadErr(null);
                    setLeadErrRetryable(false);
                    setMessage("");
                    setExisting(null);
                  }}
                  className="shrink-0 rounded-md text-[11px] font-semibold text-emerald-700 hover:underline"
                >
                  Clear
                </button>
              </div>
            ) : null}

            {leadErr ? (
              <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11.5px] text-rose-700">
                <div>{leadErr}</div>
                {leadErrRetryable ? (
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] leading-snug text-rose-600/90">
                      LSQ ki request limit cross ho sakti hai — &quot;Find again&quot;
                      dabakar dobara try karein.
                    </span>
                    <button
                      type="button"
                      onClick={() => void runLookup()}
                      disabled={leadLooking}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-300 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {leadLooking ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Search className="h-3 w-3" />
                      )}
                      Find again
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Field>

          {/* Phone number is no longer a visible field — it's filled
              from the Lead # lookup above. Country code / phone state
              still drives the contact creation, just hidden from the
              operator. */}

          {/* From-number searchable dropdown */}
          <Field label="Send from">
            <NumberCombobox
              numbers={numbers}
              loading={loadingNumbers}
              selectedId={bpid}
              onSelect={(id) => {
                setBpid(id);
                setExisting(null);
              }}
            />
          </Field>

          {/* Already-exists notice — tells the operator a chat for this
              lead is already on the SELECTED number, so the message below
              (or "Open chat") continues that same thread, not a duplicate. */}
          {existingContact && selected ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1">
                <strong className="font-bold">A chat already exists on</strong>{" "}
                <span className="font-semibold">{numberLabel(selected)}</span>
                {selected.display_phone_number ? (
                  <span className="font-mono text-[11px]">
                    {" "}
                    · {selected.display_phone_number}
                  </span>
                ) : null}
                . Sending below continues that same thread — or open it directly.
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      const cid = existingContact.id;
                      onClose();
                      const url = new URL(window.location.href);
                      url.pathname = "/dashboard";
                      url.searchParams.set("c", cid);
                      window.location.assign(url.toString());
                    }}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    Open existing chat
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* First-message composer. Appears once a client is loaded. The
              channel auto-switches by provider + 24h window (badge below):
              empty → just "Open chat"; typed → "Send" via the right path. */}
          {leadHit ? (
            <Field label="Message" optional>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 600))}
                placeholder={
                  sendMode === "magic"
                    ? "Type your message — goes via Magic Message…"
                    : "Type your first message…"
                }
                rows={3}
                maxLength={600}
                className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-relaxed outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                {sendMode ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      sendMode === "magic"
                        ? "bg-violet-50 text-violet-700 ring-1 ring-violet-200"
                        : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
                    )}
                  >
                    {sendMode === "magic" ? (
                      <>
                        <Sparkles className="h-3 w-3" />
                        Magic Message · window closed
                      </>
                    ) : sendMode === "direct" ? (
                      <>
                        <Send className="h-3 w-3" />
                        Direct message
                      </>
                    ) : (
                      <>
                        <Send className="h-3 w-3" />
                        Normal reply · window open
                      </>
                    )}
                  </span>
                ) : (
                  <span />
                )}
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {message.length}/600
                </span>
              </div>
            </Field>
          ) : null}

          {err ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11.5px] font-medium text-rose-700">
              {err}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          {message.trim() ? (
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={busy || loadingNumbers || !sendMode || checkingExisting}
              className="group relative inline-flex items-center gap-1.5 overflow-hidden rounded-lg bg-gradient-to-r from-sky-500 via-indigo-600 to-violet-600 px-4 py-2 text-xs font-bold text-white shadow-md transition hover:shadow-lg disabled:opacity-40"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/0 via-white/30 to-white/0 opacity-0 transition-opacity group-hover:opacity-100"
              />
              {busy || checkingExisting ? (
                <Loader2 className="relative h-3.5 w-3.5 animate-spin" />
              ) : sendMode === "magic" ? (
                <Sparkles className="relative h-3.5 w-3.5" />
              ) : (
                <Send className="relative h-3.5 w-3.5" />
              )}
              <span className="relative">
                {sendMode === "magic" ? "Send Magic Message" : "Send message"}
              </span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || loadingNumbers || numbers.length === 0 || !bpid}
              className="group relative inline-flex items-center gap-1.5 overflow-hidden rounded-lg bg-gradient-to-r from-sky-500 via-indigo-600 to-violet-600 px-4 py-2 text-xs font-bold text-white shadow-md transition hover:shadow-lg disabled:opacity-40"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/0 via-white/30 to-white/0 opacity-0 transition-opacity group-hover:opacity-100"
              />
              {busy ? (
                <Loader2 className="relative h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRight className="relative h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              )}
              <span className="relative">Open chat</span>
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}

// Single source of truth for field layout — keeps labels, hints and
// counters consistent across every input.
function Field({
  icon: Icon,
  label,
  optional,
  hint,
  counter,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  optional?: boolean;
  hint?: string;
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          {Icon ? <Icon className="h-3.5 w-3.5 text-emerald-600" /> : null}
          {label}
          {optional ? (
            <span className="text-[10px] font-medium text-muted-foreground">
              (optional)
            </span>
          ) : null}
        </label>
        {counter ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {counter}
          </span>
        ) : null}
      </div>
      {children}
      {hint ? (
        <p className="mt-1 text-[10.5px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function numberLabel(n: BusinessNumber): string {
  return (
    n.nickname?.trim() ||
    n.verified_name?.trim() ||
    n.display_phone_number ||
    n.phone_number_id
  );
}

// =====================================================================
// Searchable combobox for the "Send from" picker. Plain <select> doesn't
// give us name/number search across dozens of business numbers, so we
// roll a small dropdown that matches the rest of the dialog's look.
// =====================================================================
function NumberCombobox({
  numbers,
  loading,
  selectedId,
  onSelect,
}: {
  numbers: BusinessNumber[];
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The panel is portalled to <body> so the dialog's overflow-hidden can't
  // clip it. Track the trigger's on-screen rect to position it.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function place() {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside click (button + portalled panel both count as "inside").
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      // Focus the search field as soon as the panel opens.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open]);

  const selected = numbers.find((n) => n.phone_number_id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return numbers;
    const qDigits = q.replace(/\D/g, "");
    return numbers.filter((n) => {
      const label = numberLabel(n).toLowerCase();
      const dpn = (n.display_phone_number ?? "").toLowerCase();
      const pid = n.phone_number_id.toLowerCase();
      const verified = (n.verified_name ?? "").toLowerCase();
      const nickname = (n.nickname ?? "").toLowerCase();
      if (label.includes(q)) return true;
      if (verified.includes(q)) return true;
      if (nickname.includes(q)) return true;
      if (qDigits.length >= 3) {
        // Number search — strip non-digits from both sides so "+91 90847"
        // matches "919084723085".
        const dpnDigits = dpn.replace(/\D/g, "");
        if (dpnDigits.includes(qDigits)) return true;
        if (pid.includes(qDigits)) return true;
      }
      return false;
    });
  }, [numbers, query]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={loading || numbers.length === 0}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm font-medium outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40 disabled:opacity-50",
          open && "border-emerald-400 ring-2 ring-emerald-200/40",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <span
                className={cn(
                  "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                  selected.provider === "evolution"
                    ? "bg-violet-500"
                    : "bg-emerald-500",
                )}
              />
              <span className="truncate">{numberLabel(selected)}</span>
              {selected.display_phone_number ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  · {selected.display_phone_number}
                </span>
              ) : null}
              <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {selected.provider === "evolution" ? "Evolution" : "Meta"}
              </span>
            </>
          ) : numbers.length === 0 && !loading ? (
            <span className="text-muted-foreground">No accessible numbers</span>
          ) : (
            <span className="text-muted-foreground">Pick a number…</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-[90] overflow-hidden rounded-lg border bg-popover shadow-xl ring-1 ring-border"
        >
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or number…"
              className="h-9 w-full bg-transparent pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-center text-xs text-muted-foreground">
                No matches.
              </li>
            ) : (
              filtered.map((n) => {
                const isSelected = n.phone_number_id === selectedId;
                return (
                  <li key={n.phone_number_id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(n.phone_number_id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary/70",
                        isSelected && "bg-emerald-50",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                            n.provider === "evolution"
                              ? "bg-violet-500"
                              : "bg-emerald-500",
                          )}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-semibold">
                            {numberLabel(n)}
                          </span>
                          {n.display_phone_number ? (
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {n.display_phone_number}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {n.provider === "evolution" ? "Evolution" : "Meta"}
                        </span>
                        {isSelected ? (
                          <Check className="h-3 w-3 text-emerald-600" />
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>,
            document.body,
          )
        : null}
    </div>
  );
}
