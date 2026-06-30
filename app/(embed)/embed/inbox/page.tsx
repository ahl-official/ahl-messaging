// /embed/inbox — chats-only inbox for the CRM iframe.
//
// Same session, same permission resolution, same components as the main
// dashboard — just none of its chrome. The CRM frames this at:
//   https://wa.hairmedindia.com/embed/inbox?wa=<E.164 digits, no +>
// When `wa` is present the embed LOCKS to that one patient's conversation:
// the inbox sidebar is hidden and only that chat opens. If no thread exists
// yet, an empty chat for that number opens ready to send the first message —
// it never falls back to the inbox or auto-selects another contact. Optional
// `?from=<business phone_number_id>` chooses which WhatsApp number a brand-new
// chat is created under (defaults to the agent's only/first allowed number).
// Without `wa`, the full scoped inbox renders (with optional ?c=<contact id>).
//
// No valid session → a minimal sign-in screen (middleware deliberately does
// NOT redirect /embed to /login — the login page refuses to be framed).

import { createServerClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { numberAccessMode } from "@/lib/permission-types";
import { PermissionsProvider } from "@/components/PermissionsContext";
import { MembersProvider } from "@/components/MembersContext";
import { EmbedInboxView } from "@/components/EmbedInboxView";
import type { BusinessNumber, Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

// Same non-secret column list the dashboard page uses — these rows serialize
// into the page HTML, so secret columns must never be selected here.
const NUMBER_COLUMNS =
  "phone_number_id, display_phone_number, verified_name, nickname, memo, is_active, created_at, meta_status, meta_checked_at, waba_id, provider, evolution_instance_name, evolution_jid, evolution_connection_state, evolution_group_id, profile_pic_url";

function SignInScreen() {
  return (
    <div className="grid h-full place-items-center px-4">
      <div className="w-full max-w-xs rounded-2xl border bg-card p-6 text-center shadow-sm">
        <p className="text-sm font-semibold text-foreground">
          Sign in to QHT Messaging
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your WhatsApp inbox session has expired or you’re not signed in.
        </p>
        {/* target=_top: Google OAuth won't run inside an iframe. */}
        <a
          href="/login?next=/embed/inbox"
          target="_top"
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          Open sign-in
        </a>
      </div>
    </div>
  );
}

/** A terminal locked-mode message (invalid number / no access). Stays inside
 *  the embed — never reveals the inbox. */
function LockedMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-4 text-center">
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** Repeated query keys arrive as string[] at runtime — take the first. */
function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

const digitsOf = (s: string | null | undefined): string =>
  (s ?? "").replace(/\D/g, "");

export default async function EmbedInboxPage({
  searchParams,
}: {
  searchParams?: {
    wa?: string | string[];
    c?: string | string[];
    from?: string | string[];
  };
}) {
  const member = await getCurrentMember();
  if (!member) return <SignInScreen />;

  // Identical scoping to the main dashboard: resolve effective permissions
  // and filter both contacts and numbers to allowed_number_ids.
  const perms = await getEffectivePermissionsFor(member);
  const allowed = perms.allowed_number_ids;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Business numbers (scoped) — needed in both modes.
  const { data: bnData } = await supabase
    .from("business_numbers")
    .select(NUMBER_COLUMNS);
  let businessNumbers = (bnData ?? []) as BusinessNumber[];
  if (allowed !== null) {
    businessNumbers = businessNumbers.filter((n) =>
      allowed.includes(n.phone_number_id),
    );
  }

  // ── LOCKED single-contact mode (?wa present) ───────────────────────
  // ANY present ?wa hides the inbox and opens ONLY this number's chat — it
  // must never fall back to the inbox or another contact.
  const waRaw = firstParam(searchParams?.wa);
  const waPresent = waRaw.trim().length > 0;
  if (waPresent) {
    const wa = waRaw.replace(/\D/g, "");
    if (wa.length < 7) {
      return <LockedMessage>That phone number looks invalid.</LockedMessage>;
    }

    const fromParam = firstParam(searchParams?.from).trim();
    // Which business number a brand-new chat is created under: an explicit
    // ?from that the agent is allowed, else their only/first allowed number.
    const fromBpid =
      fromParam && businessNumbers.some((n) => n.phone_number_id === fromParam)
        ? fromParam
        : businessNumbers[0]?.phone_number_id ?? null;

    // Find an existing thread for this number within the agent's scope.
    // Normalize the country code by comparing the trailing 10-digit national
    // part on BOTH sides (CRM may send "9190…", stored may be "90…" or vice
    // versa). Short numbers (<10 digits) match exact-only — a loose suffix
    // would lock onto an unrelated patient. We pick by national EQUALITY,
    // never an arbitrary most-recent suffix hit.
    const reqNat = wa.length >= 10 ? wa.slice(-10) : wa;
    const orClause =
      reqNat.length === 10
        ? `wa_id.eq.${wa},wa_id.ilike.%${reqNat}`
        : `wa_id.eq.${wa}`;
    let lookup = supabase
      .from("contacts")
      .select("*")
      .or(orClause)
      .order("last_message_at", { ascending: false })
      .limit(20);
    if (allowed !== null) {
      lookup =
        allowed.length === 0
          ? lookup.in("business_phone_number_id", ["__none__"])
          : lookup.in("business_phone_number_id", allowed);
    }
    const { data: matches } = await lookup;
    const rows = (matches ?? []) as Contact[];

    // Exact wa_id wins. Else a SINGLE unambiguous national match (same patient,
    // possibly on >1 of their numbers → most-recent row). Two distinct numbers
    // sharing the trailing 10 digits = ambiguous → open a fresh empty chat for
    // the exact requested number rather than guessing the wrong patient.
    let existing: Contact | null = rows.find((c) => c.wa_id === wa) ?? null;
    if (!existing && reqNat.length === 10) {
      const natMatches = rows.filter(
        (c) => digitsOf(c.wa_id).slice(-10) === reqNat,
      );
      if (new Set(natMatches.map((c) => c.wa_id)).size === 1) {
        existing = natMatches[0] ?? null;
      }
    }

    // Enforce the per-number assigned-only (LSQ-owner) visibility tier — same
    // rule GET /api/contacts applies: on an assigned-only number an agent may
    // only see chats they own. A matched thread that isn't theirs is refused,
    // not opened (and not re-created, which would just surface the same row).
    if (existing && member.role !== "owner") {
      const bpid = existing.business_phone_number_id;
      if (bpid && numberAccessMode(perms, bpid) === "assigned_only") {
        const mine =
          (existing.lsq_owner_email ?? "").toLowerCase() ===
          (member.email ?? "").toLowerCase();
        if (!mine) {
          return (
            <LockedMessage>
              You don’t have access to this conversation.
            </LockedMessage>
          );
        }
      }
    }

    return (
      <PermissionsProvider value={perms}>
        <MembersProvider>
          <EmbedInboxView
            locked
            lockedContact={existing}
            lockedWa={wa}
            lockedFromBpid={fromBpid}
            businessNumbers={businessNumbers}
            currentUserId={user?.id ?? null}
          />
        </MembersProvider>
      </PermissionsProvider>
    );
  }

  // ── Full scoped inbox (no ?wa) ─────────────────────────────────────
  let contactsQuery = supabase
    .from("contacts")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (allowed !== null) {
    contactsQuery =
      allowed.length === 0
        ? contactsQuery.in("business_phone_number_id", ["__none__"])
        : contactsQuery.in("business_phone_number_id", allowed);
  }
  const { data: contactsData } = await contactsQuery;
  let contacts = (contactsData ?? []) as Contact[];

  // ?c=<contact uuid> — in-app deep link (e.g. CrmLookupModal's "Open chat").
  const cParam = firstParam(searchParams?.c).trim();
  let initialSelectedId: string | null = null;
  if (cParam) {
    const inSlice = contacts.find((c) => c.id === cParam);
    if (inSlice) {
      initialSelectedId = inSlice.id;
    } else {
      let cQuery = supabase.from("contacts").select("*").eq("id", cParam).limit(1);
      if (allowed !== null) {
        cQuery =
          allowed.length === 0
            ? cQuery.in("business_phone_number_id", ["__none__"])
            : cQuery.in("business_phone_number_id", allowed);
      }
      const { data: found } = await cQuery;
      const row = (found?.[0] as Contact | undefined) ?? null;
      if (row) {
        contacts = [row, ...contacts];
        initialSelectedId = row.id;
      }
    }
  }

  return (
    <PermissionsProvider value={perms}>
      <MembersProvider>
        <EmbedInboxView
          initialContacts={contacts}
          businessNumbers={businessNumbers}
          currentUserId={user?.id ?? null}
          initialSelectedId={initialSelectedId}
        />
      </MembersProvider>
    </PermissionsProvider>
  );
}
