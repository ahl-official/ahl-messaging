"use client";

// Chats-only inbox for the CRM iframe (/embed/inbox) — a trimmed
// DashboardView. Reuses the exact same ContactList / ChatWindow the main
// dashboard renders, so chat behaviour and permission gating stay identical.
//
// Two modes:
//   • inbox  — conversation list + open thread + composer (no ?wa).
//   • locked — a single client's chat only, no sidebar (?wa=<digits>). If
//     no thread exists yet it creates one on the chosen number and opens an
//     empty chat ready for the first message.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { ContactList } from "@/components/ContactList";
import { ChatWindow } from "@/components/ChatWindow";
import type { BusinessNumber, Contact } from "@/lib/types";

interface Props {
  /** inbox mode */
  initialContacts?: Contact[];
  initialSelectedId?: string | null;
  /** locked mode (?wa=) */
  locked?: boolean;
  lockedContact?: Contact | null;
  lockedWa?: string;
  lockedFromBpid?: string | null;
  /** shared */
  businessNumbers: BusinessNumber[];
  currentUserId: string | null;
}

export function EmbedInboxView(props: Props) {
  if (props.locked) {
    return (
      <LockedChat
        lockedContact={props.lockedContact ?? null}
        lockedWa={props.lockedWa ?? ""}
        lockedFromBpid={props.lockedFromBpid ?? null}
        businessNumbers={props.businessNumbers}
        currentUserId={props.currentUserId}
      />
    );
  }
  return (
    <InboxView
      initialContacts={props.initialContacts ?? []}
      initialSelectedId={props.initialSelectedId ?? null}
      businessNumbers={props.businessNumbers}
      currentUserId={props.currentUserId}
    />
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-4 text-center">
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

// ── Locked single-contact view (?wa=) ────────────────────────────────
function LockedChat({
  lockedContact,
  lockedWa,
  lockedFromBpid,
  businessNumbers,
  currentUserId,
}: {
  lockedContact: Contact | null;
  lockedWa: string;
  lockedFromBpid: string | null;
  businessNumbers: BusinessNumber[];
  currentUserId: string | null;
}) {
  const [contact, setContact] = useState<Contact | null>(lockedContact);
  const [error, setError] = useState<string | null>(null);
  const triedRef = useRef(false);

  // No existing thread → create the contact on the chosen number so the chat
  // (and composer) work exactly like any other. Mirrors the "Start new chat"
  // create path; idempotent upsert on (wa_id, business_phone_number_id).
  useEffect(() => {
    if (contact || triedRef.current) return;
    if (!lockedWa || !lockedFromBpid) return;
    triedRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Client",
            phone: lockedWa,
            business_phone_number_id: lockedFromBpid,
          }),
        });
        const j = (await res.json()) as { contact?: Contact; error?: string };
        if (!res.ok || !j.contact) throw new Error(j.error ?? "Failed to open chat");
        setContact(j.contact);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to open chat");
      }
    })();
  }, [contact, lockedWa, lockedFromBpid]);

  const numbersById = useMemo(() => {
    const map = new Map<string, BusinessNumber>();
    for (const n of businessNumbers) map.set(n.phone_number_id, n);
    return map;
  }, [businessNumbers]);

  const business = contact?.business_phone_number_id
    ? numbersById.get(contact.business_phone_number_id) ?? null
    : null;

  if (error) return <CenterMessage>{error}</CenterMessage>;
  // No number to attach a brand-new chat to (agent has no allowed numbers).
  if (!contact && !lockedFromBpid) {
    return (
      <CenterMessage>
        No WhatsApp number is assigned to your account, so this chat can’t be
        opened.
      </CenterMessage>
    );
  }
  if (!contact) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-w-0">
      {/* No onBack — there is no list to go back to in locked mode. */}
      <ChatWindow
        key={contact.id}
        contact={contact}
        businessNumber={business}
        currentUserId={currentUserId}
      />
    </div>
  );
}

// ── Full inbox view (no ?wa) ─────────────────────────────────────────
function InboxView({
  initialContacts,
  initialSelectedId,
  businessNumbers,
  currentUserId,
}: {
  initialContacts: Contact[];
  initialSelectedId: string | null;
  businessNumbers: BusinessNumber[];
  currentUserId: string | null;
}) {
  const [selected, setSelected] = useState<Contact | null>(() =>
    initialSelectedId
      ? initialContacts.find((c) => c.id === initialSelectedId) ?? null
      : null,
  );

  const numbersById = useMemo(() => {
    const map = new Map<string, BusinessNumber>();
    for (const n of businessNumbers) map.set(n.phone_number_id, n);
    return map;
  }, [businessNumbers]);

  const selectedBusiness = selected?.business_phone_number_id
    ? numbersById.get(selected.business_phone_number_id) ?? null
    : null;

  return (
    <div className="flex h-full min-w-0">
      <div
        className={
          selected
            ? "hidden md:flex md:w-[280px] lg:w-[300px] xl:w-[340px]"
            : "flex w-full md:w-[280px] lg:w-[300px] xl:w-[340px]"
        }
      >
        <ContactList
          initialContacts={initialContacts}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          currentUserId={currentUserId}
          businessNumbersById={numbersById}
        />
      </div>
      <div
        className={
          selected ? "flex min-w-0 flex-1" : "hidden md:flex min-w-0 flex-1"
        }
      >
        {/* key forces a clean remount per contact — same as DashboardView. */}
        <ChatWindow
          key={selected?.id ?? "empty"}
          contact={selected}
          businessNumber={selectedBusiness}
          currentUserId={currentUserId}
          onBack={() => setSelected(null)}
        />
      </div>
    </div>
  );
}
