"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Phone, UserPlus, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  assignContactToMeAction,
  assignContactToUserAction,
  unassignContactAction,
} from "@/app/(dashboard)/actions";
import { cn } from "@/lib/utils";
import type { Contact } from "@/lib/types";
import { DEMO_MODE } from "@/lib/demo";
import { emitWaCallDial } from "@/lib/call-events";
import {
  getCallWindowState,
  formatCallWindowLeft,
  type CallPermissionLike,
} from "@/lib/whatsapp-call-window";
import { contactDisplayName } from "@/lib/types";
import { startTelephonyCallWidget } from "@/components/TelephonyCallWidget";
import { useMemberName } from "@/components/MembersContext";

interface TeamMemberMini {
  id: string;
  user_id: string | null;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  is_active: boolean;
  pending_approval: boolean;
}

interface Props {
  contact: Contact;
  currentUserId: string | null;
  windowOpen: boolean;
}

// Available call providers — UI only for now. Each item gets wired to its
// real integration later (WhatsApp Cloud API call, Tata Tele click-to-call,
// Ozonetel click2call). Until then the click is a no-op + console log.
const CALL_PROVIDERS: { key: string; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp Call" },
  { key: "tata",     label: "Tata Tele" },
  { key: "ozonetel", label: "Ozonetel" },
  { key: "telephony", label: "Telephony connector" },
];

// PSTN dialers that hit a backend route and ring the operator's agent
// first. WhatsApp is handled separately (Call Permission Request flow).
const EXTERNAL_DIALERS: Record<
  string,
  { endpoint: string; dialing: string; queued: string }
> = {
  tata: {
    endpoint: "/api/tatatele-call/initiate",
    dialing: "Dialing via Tata Tele…",
    queued: "Call started — pick up on your phone.",
  },
  ozonetel: {
    endpoint: "/api/ozonetel-call/initiate",
    dialing: "Dialing via Ozonetel…",
    queued: "Call queued — pick up on your CloudAgent phone.",
  },
  telephony: {
    endpoint: "/api/telephony/click-to-call",
    dialing: "Dialing via Telephony connector…",
    queued: "Call started — pick up on your phone.",
  },
};

export function ChatToolbar({ contact, currentUserId, windowOpen }: Props) {
  const [isPending, startTransition] = useTransition();
  // Pretty-print the assignee instead of just their email — picks up
  // first/last name from the workspace members map when available.
  const assigneeName = useMemberName(contact.assigned_to_email ?? "");

  const mine = currentUserId && contact.assigned_to === currentUserId;
  const assigned = Boolean(contact.assigned_to);

  function run(fn: () => Promise<{ ok: true } | { error: string }>) {
    startTransition(async () => {
      await fn();
    });
  }

  if (DEMO_MODE) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Assign / call disabled in demo mode
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {assigned && !mine ? (
        <span className="hidden md:inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
          Assigned · {assigneeName || contact.assigned_to_email || "agent"}
        </span>
      ) : null}

      <div className="hidden md:inline-flex">
        <AssignControl
          contact={contact}
          mine={!!mine}
          assigned={assigned}
          disabled={isPending}
          runSelf={() => run(() => assignContactToMeAction(contact.id))}
          runUnassign={() => run(() => unassignContactAction(contact.id))}
        />
      </div>


      <CallButton contact={contact} windowOpen={windowOpen} />
    </div>
  );
}

// Assign control. The old plain "Assign to me" button has been
// replaced with a split dropdown so an admin / supervisor can hand a
// chat to any teammate, not just take it themselves. When the operator
// is already assigned, the primary action becomes Unassign. The
// dropdown menu always lists the full team so reassignment is one
// click away.
function AssignControl({
  contact,
  mine,
  assigned,
  disabled,
  runSelf,
  runUnassign,
}: {
  contact: Contact;
  mine: boolean;
  assigned: boolean;
  disabled: boolean;
  runSelf: () => void;
  runUnassign: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<TeamMemberMini[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Lazy-load team list the first time the dropdown opens. Caches for
  // the session — refresh-on-each-open felt slow.
  useEffect(() => {
    if (!open || members) return;
    void fetch("/api/team", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        const rows = ((j.members ?? []) as TeamMemberMini[])
          .filter((m) => m.is_active && !m.pending_approval && m.user_id);
        setMembers(rows);
      })
      .catch(() => setMembers([]));
  }, [open, members]);

  async function pickUser(m: TeamMemberMini) {
    if (!m.user_id) return;
    setBusy(true);
    try {
      await assignContactToUserAction(contact.id, m.user_id, m.email);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel = mine
    ? "Unassign"
    : assigned
      ? "Take over"
      : "Assign to me";
  const PrimaryIcon = mine ? UserX : UserPlus;
  const primaryAction = mine ? runUnassign : runSelf;

  const visibleMembers = (members ?? []).filter((m) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    const label = (
      m.full_name ||
      [m.first_name, m.last_name].filter(Boolean).join(" ") ||
      m.email
    ).toLowerCase();
    return label.includes(q) || m.email.toLowerCase().includes(q);
  });

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={primaryAction}
        className="rounded-r-none border-r-0"
      >
        <PrimaryIcon className="h-3.5 w-3.5" />
        <span className="hidden min-[1700px]:inline">{primaryLabel}</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="rounded-l-none px-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Assign to a teammate"
      >
        <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-lg border bg-card shadow-lg"
        >
          <div className="border-b px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Assign to teammate
            </p>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search by name or email…"
              autoFocus
              className="mt-1.5 w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {members === null ? (
              <li className="px-3 py-2 text-[11px] text-muted-foreground">
                Loading…
              </li>
            ) : visibleMembers.length === 0 ? (
              <li className="px-3 py-2 text-[11px] text-muted-foreground">
                {filter ? "No matches." : "No active teammates."}
              </li>
            ) : (
              visibleMembers.map((m) => {
                const label =
                  m.full_name ||
                  [m.first_name, m.last_name].filter(Boolean).join(" ") ||
                  m.email;
                const isCurrent = contact.assigned_to === m.user_id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => pickUser(m)}
                      disabled={busy || isCurrent}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50",
                        isCurrent && "bg-secondary",
                      )}
                    >
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                        {(label[0] ?? "?").toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{label}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {m.email} · {m.role}
                        </p>
                      </div>
                      {isCurrent ? (
                        <span className="text-[9px] font-semibold text-primary">
                          Current
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {assigned ? (
            <div className="border-t bg-secondary/40 p-1.5">
              <button
                type="button"
                onClick={() => {
                  runUnassign();
                  setOpen(false);
                }}
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-50"
              >
                <UserX className="h-3.5 w-3.5" />
                Unassign current
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Call dropdown — picking "WhatsApp Call" fires a Call Permission
// Request to the user. Tata / Ozonetel are still TBD and just log
// the chosen provider for now.
function CallButton({ contact, windowOpen }: { contact: Contact; windowOpen: boolean }) {
  const [open, setOpen] = useState(false);
  // Which provider's request is in flight (null = idle). Tracked per-key
  // so only the clicked row shows its loading label — a shared boolean
  // lit up "Sending…" and "Dialing…" on both at once.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const busy = pendingKey !== null;
  const [feedback, setFeedback] = useState<string | null>(null);
  // Call-permission ("calling window") for this contact — fetched lazily
  // when the dropdown opens so we can show whether a WhatsApp call is
  // allowed right now and how long the ~7-day permission lasts.
  const [perm, setPerm] = useState<CallPermissionLike | null>(null);
  const [permLoaded, setPermLoaded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Evolution (Baileys) numbers can't originate WhatsApp calls — the
  // protocol itself doesn't expose call origination to linked devices.
  // We mark the contact by the synthetic `evo:` prefix on its
  // business_phone_number_id and hide the WhatsApp Call option for
  // those contacts. Tata / Ozonetel are external dialers so they
  // stay available regardless of provider.
  const isEvolutionContact =
    typeof contact.business_phone_number_id === "string" &&
    contact.business_phone_number_id.startsWith("evo:");
  const providers = isEvolutionContact
    ? CALL_PROVIDERS.filter((p) => p.key !== "whatsapp")
    : CALL_PROVIDERS;

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset the cached permission when the chat switches.
  useEffect(() => {
    setPerm(null);
    setPermLoaded(false);
  }, [contact.id]);

  // Fetch the calling-window state when the dropdown opens (WhatsApp-capable
  // contacts only — Evolution numbers can't place WhatsApp calls).
  useEffect(() => {
    if (!open || isEvolutionContact || permLoaded || DEMO_MODE) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/whatsapp-call/permission?contact_id=${encodeURIComponent(contact.id)}`,
          { cache: "no-store" },
        );
        const j = (await res.json().catch(() => ({}))) as {
          permission?: CallPermissionLike | null;
        };
        if (!cancelled) {
          setPerm(j.permission ?? null);
          setPermLoaded(true);
        }
      } catch {
        if (!cancelled) setPermLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isEvolutionContact, permLoaded, contact.id]);

  const callWindow = getCallWindowState(perm);
  const callWindowLeft = formatCallWindowLeft(callWindow);

  async function pick(providerKey: string) {
    // External PSTN dialers (Tata Tele, Ozonetel) share the same shape:
    // POST contact_id, they ring the operator's agent first then bridge
    // the contact. The provider replies with origination, not pickup.
    const dialer = EXTERNAL_DIALERS[providerKey];
    if (dialer) {
      if (busy) return;
      // We used to pop the CloudAgent dashboard in a side window on
      // every Ozonetel dial, but Ozonetel enforces a single-session
      // policy — the new window stole the auth and killed the
      // operator's already-Ready tab. Now we just dial via the API
      // and let the call ring whichever CloudAgent tab the operator
      // already has open.
      setPendingKey(providerKey);
      setFeedback(dialer.dialing);
      try {
        const res = await fetch(dialer.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: contact.id }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !json.ok) {
          setFeedback(json.error ?? `HTTP ${res.status}`);
          return;
        }
        // Telephony connector → pop the live call widget.
        if (providerKey === "telephony") {
          startTelephonyCallWidget({ name: contactDisplayName(contact), phone: contact.wa_id, provider: "telephony" });
        }
        setFeedback(dialer.queued);
        setTimeout(() => {
          setFeedback(null);
          setOpen(false);
        }, 2200);
      } catch (e) {
        setFeedback(e instanceof Error ? e.message : "Network error");
      } finally {
        setPendingKey(null);
      }
      return;
    }
    if (providerKey !== "whatsapp") {
      // eslint-disable-next-line no-console
      console.log("[call]", { provider: providerKey, wa_id: contact.wa_id, contact_id: contact.id });
      setOpen(false);
      return;
    }
    // 24h window closed → Meta rejects the CPR with re-engagement error.
    // Block at UI; agent must reopen via Magic Message first.
    if (!windowOpen) {
      setFeedback("Window closed — send a Magic Message first to call.");
      return;
    }
    if (busy) return;
    setPendingKey("whatsapp");
    setFeedback(null);
    try {
      const res = await fetch("/api/whatsapp-call/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        permission_state?: "pending" | "granted" | "error";
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setFeedback(json.error ?? `HTTP ${res.status}`);
        return;
      }
      // permission_state="granted" means Meta replied with #138017
      // ("can already call this consumer") OR a previous CPR is still
      // valid. In either case we skip the wait and dial right now.
      if (json.permission_state === "granted") {
        emitWaCallDial({
          contactId: contact.id,
          contactName: contactDisplayName(contact),
        });
        setFeedback("Calling…");
        setTimeout(() => {
          setFeedback(null);
          setOpen(false);
        }, 1000);
      } else {
        setFeedback("Permission request sent — waiting for Allow.");
        setTimeout(() => {
          setFeedback(null);
          setOpen(false);
        }, 1800);
      }
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Network error");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Phone className="h-3.5 w-3.5" />
        <span className="hidden min-[1700px]:inline">Call</span>
        <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded-lg border bg-card shadow-lg"
        >
          <div className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Place a call
          </div>
          {/* Calling window — WhatsApp calls need an explicit ~7-day call
              permission (separate from the 24h messaging window). */}
          {!isEvolutionContact ? (
            <div className="border-b px-3 py-1.5 text-[11px] leading-snug">
              {!windowOpen ? (
                <span className="text-amber-700">
                  Calling window closed — send a Magic Message first.
                </span>
              ) : !permLoaded ? (
                <span className="text-muted-foreground">Checking calling window…</span>
              ) : callWindow.canCall ? (
                <span className="font-medium text-primary">
                  WhatsApp calling open · {callWindowLeft}
                </span>
              ) : callWindow.state === "expired" ? (
                <span className="text-amber-700">
                  Call permission expired — calling re-asks Allow (7-day window).
                </span>
              ) : callWindow.state === "denied" ? (
                <span className="text-rose-700">Client denied call permission.</span>
              ) : callWindow.state === "pending" ? (
                <span className="text-muted-foreground">
                  Permission requested — waiting for Allow.
                </span>
              ) : (
                <span className="text-muted-foreground">
                  No call permission yet — calling asks the client to Allow
                  (7-day window).
                </span>
              )}
            </div>
          ) : null}
          <ul className="py-1">
            {providers.map((p) => {
              const waDisabled = p.key === "whatsapp" && (!windowOpen || busy);
              const extDisabled = !!EXTERNAL_DIALERS[p.key] && busy;
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    disabled={waDisabled || extDisabled}
                    onClick={() => void pick(p.key)}
                    title={
                      p.key === "whatsapp" && !windowOpen
                        ? "24h window closed — send a Magic Message first"
                        : undefined
                    }
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-secondary disabled:opacity-50"
                  >
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1">{p.label}</span>
                    {pendingKey === "whatsapp" && p.key === "whatsapp" ? (
                      <span className="text-[10px] text-muted-foreground">Sending…</span>
                    ) : p.key === "whatsapp" && !windowOpen ? (
                      <span className="text-[10px] text-muted-foreground">Window closed</span>
                    ) : p.key === "whatsapp" && callWindow.canCall ? (
                      <span className="text-[10px] font-medium text-primary">
                        {callWindowLeft}
                      </span>
                    ) : pendingKey === p.key && EXTERNAL_DIALERS[p.key] ? (
                      <span className="text-[10px] text-muted-foreground">Dialing…</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t bg-secondary/40 px-3 py-1.5 text-[10px] text-muted-foreground">
            {feedback ??
              (isEvolutionContact
                ? "Unofficial (Baileys) numbers can't place WhatsApp calls. Use Tata Tele or Ozonetel."
                : "WhatsApp asks the user to grant permission first.")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
