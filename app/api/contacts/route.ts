import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { getMonitorEmails } from "@/lib/team";
import type { Contact } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Page size for the inbox sidebar. The list infinite-scrolls — each
// fetch pulls the next PAGE_SIZE rows by `?offset=`.
const PAGE_SIZE = 200;

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const offsetParam = parseInt(
    request.nextUrl.searchParams.get("offset") ?? "0",
    10,
  );
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  // Optional LSQ-stage filter — drives the inbox stage strip. Filtering
  // server-side is the whole point: the strip's counts span every
  // contact, but the list only holds the infinitely-scrolled slice, so
  // a client-side filter would miss matches that haven't loaded yet.
  const stageParam = request.nextUrl.searchParams.get("stage")?.trim();
  // "Unreplied" — the customer's last message is still unanswered (last
  // message is inbound), regardless of the 24h window. Server-side so the
  // count/list cover ALL such chats, not just the loaded page.
  const unrepliedParam = request.nextUrl.searchParams.get("unreplied") === "1";
  // "Mine" — contacts assigned to the calling user. Server-side so the list
  // covers EVERY assigned lead, not just the loaded page (contacts.assigned_to
  // stores the auth user id, same value the client compares against).
  const mineParam = request.nextUrl.searchParams.get("mine") === "1";
  // "Unassigned" — contacts with no dashboard assignee (assigned_to IS
  // NULL). Server-side so the full set is covered, like mine/unreplied.
  const unassignedParam =
    request.nextUrl.searchParams.get("unassigned") === "1";

  // Resolve the caller's number-scope. Owner sees everything; everyone
  // else only sees contacts on their allowed business numbers — same
  // gate that filters the inbox/contacts pages server-side.
  const ctx = await getCurrentEffectivePermissions();
  let allowedNumberIds: string[] | null = null;
  if (ctx && ctx.member.role !== "owner") {
    allowedNumberIds = ctx.perms.allowed_number_ids;
  }
  // Empty allow-list = explicit deny.
  if (allowedNumberIds !== null && allowedNumberIds.length === 0) {
    return NextResponse.json(
      { contacts: [], hasMore: false, total: 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Numbers the operator has toggled off in the UserMenu are filtered
  // out here. This is per-user state (team_members.hidden_number_ids)
  // — one operator hiding a number doesn't affect anyone else.
  const hiddenIds = ctx?.member.hidden_number_ids ?? [];

  // count: "estimated" — show the operator their total conversation count
  // WITHOUT a full COUNT scan on every 10s poll (135k+ rows for an owner).
  // Postgres returns an exact count for small/filtered sets and a planner
  // estimate above a threshold. Pagination is driven by `hasMore` (page
  // returned a full PAGE_SIZE), not by this total — so an estimate is safe.
  let query = supabase
    .from("contacts")
    .select("*", { count: "estimated" })
    .order("last_message_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (hiddenIds.length > 0) {
    query = query.not(
      "business_phone_number_id",
      "in",
      `(${hiddenIds.join(",")})`,
    );
  }
  if (allowedNumberIds !== null) {
    query = query.in("business_phone_number_id", allowedNumberIds);
  }
  if (stageParam) {
    // `ilike` with no wildcards = case-insensitive exact match.
    query = query.ilike("lsq_stage", stageParam);
  }
  if (unrepliedParam) {
    query = query.eq("last_message_direction", "inbound");
  }
  // "Unassigned" = available to be picked up. A lead is available when it
  // has no dashboard assignee AND either no LSQ owner OR its owner is a
  // "monitor" user (who only watches, doesn't work leads). Leads owned by
  // a real working agent are NOT available. Server-side so the chip's list
  // + count cover every such lead, not just the loaded page.
  if (unassignedParam) {
    query = query.is("assigned_to", null);
    const monitorEmails = await getMonitorEmails();
    if (monitorEmails.length > 0) {
      const list = monitorEmails.map((e) => `"${e}"`).join(",");
      query = query.or(
        `lsq_owner_email.is.null,lsq_owner_email.in.(${list})`,
      );
    } else {
      query = query.is("lsq_owner_email", null);
    }
  }
  if (mineParam) {
    // "Mine" = leads the caller owns. That's BOTH the dashboard assignment
    // (contacts.assigned_to = my auth id) AND the CRM lead owner
    // (lsq_owner_email = my email) — most leads arrive owned in LSQ and were
    // never explicitly dashboard-assigned, so an assigned_to-only filter
    // showed almost nothing. lsq_owner_email is stored lower(trim()).
    const mineEmail = (user.email ?? "").trim().toLowerCase();
    query = mineEmail
      ? query.or(`assigned_to.eq.${user.id},lsq_owner_email.eq.${mineEmail}`)
      : query.eq("assigned_to", user.id);
  }

  // LSQ-assigned-only visibility. Two layers now:
  //   1. Per-number override (member_number_access.mode === 'assigned_only')
  //      — wins for whichever bpids are listed.
  //   2. Global lsq_assigned_visibility_only — fallback for every other
  //      bpid in the user's allowed list. Backwards-compat.
  //
  // Build the set of bpids this user must only see their LSQ-assigned
  // chats on. Owners + users without an email bypass.
  if (ctx && ctx.member.role !== "owner" && user.email) {
    const explicit = ctx.perms.number_access_modes;
    const globalAssignedOnly = ctx.perms.lsq_assigned_visibility_only;
    const candidateBpids =
      allowedNumberIds ??
      // null = unrestricted → we need the workspace list to apply the
      // per-bpid filter. Cheap one-shot query.
      (await (async () => {
        const admin = createServiceRoleClient();
        const { data: ns } = await admin
          .from("business_numbers")
          .select("phone_number_id");
        return (ns ?? []).map((n) => n.phone_number_id as string);
      })());

    const restrictedBpids = candidateBpids.filter((bpid) => {
      const m = explicit[bpid];
      if (m === "assigned_only") return true;
      if (m === "full") return false;
      return globalAssignedOnly;
    });

    if (restrictedBpids.length > 0) {
      // (bpid NOT IN restricted) OR (lsq_owner_email = me)
      // — equivalent in result to the full predicate
      //   (bpid NOT IN restricted) OR (bpid IN restricted AND
      //    lsq_owner_email = me)
      // because when the user's email matches, they're allowed
      // regardless of which bucket the chat sits in.
      const restrictedList = `(${restrictedBpids
        .map((b) => `"${b}"`)
        .join(",")})`;
      // Email match is case-insensitive: LSQ stores OwnerIdEmailAddress in
      // whatever case it likes (often mixed-case) while the auth email is
      // lower-cased — a plain `.eq.` silently matched nothing, so the agent
      // saw zero chats on their assigned-only numbers. lsq_owner_email is
      // now normalised to lower(trim()) on write + backfilled, so an exact
      // match against the lower-cased email is correct and wildcard-safe.
      query = query.or(
        `business_phone_number_id.not.in.${restrictedList},lsq_owner_email.eq.${(user.email ?? "").toLowerCase()}`,
      );
    }
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sibling avatar fill — the same customer (wa_id) often exists once
  // per business number the operator owns. When the visible contact is
  // on a Meta number (Cloud API can't fetch profile pics) and a sibling
  // contact on an Evolution number has a cached avatar_url, copy it
  // over so the customer's WhatsApp picture renders consistently across
  // both threads. We also PERSIST the borrowed url to the DB so the
  // single-row polling in DashboardView (chat header + contact details
  // panel) sees the same value the sidebar does — without persistence,
  // the sidebar got the borrow but the header/panel stayed on initials.
  const contacts = (data ?? []) as Contact[];
  const missing = contacts.filter((c) => !c.avatar_url && c.wa_id);
  if (missing.length > 0) {
    const waIds = Array.from(new Set(missing.map((c) => c.wa_id)));
    // Use the service role so we can WRITE the borrowed avatar back.
    // The reads stay on the user-scoped client above (so RLS still
    // enforces who sees which rows).
    const admin = createServiceRoleClient();
    const { data: siblings } = await admin
      .from("contacts")
      .select("wa_id, avatar_url")
      .in("wa_id", waIds)
      .not("avatar_url", "is", null);
    if (siblings && siblings.length > 0) {
      const picByWaId = new Map<string, string>();
      for (const s of siblings as Array<{ wa_id: string; avatar_url: string }>) {
        if (!picByWaId.has(s.wa_id)) picByWaId.set(s.wa_id, s.avatar_url);
      }
      const toPersist: Array<{ id: string; avatar_url: string }> = [];
      for (const c of contacts) {
        if (!c.avatar_url && c.wa_id && picByWaId.has(c.wa_id)) {
          const url = picByWaId.get(c.wa_id)!;
          c.avatar_url = url;
          toPersist.push({ id: c.id, avatar_url: url });
        }
      }
      // Fire-and-forget — the response can ship with the borrowed
      // value immediately; the DB catch-up happens in the background
      // so the next single-row fetch reads the same thing.
      if (toPersist.length > 0) {
        void Promise.all(
          toPersist.map((row) =>
            admin
              .from("contacts")
              .update({ avatar_url: row.avatar_url })
              .eq("id", row.id)
              .is("avatar_url", null), // don't overwrite if someone just set one
          ),
        ).catch(() => {});
      }
    }
  }

  return NextResponse.json(
    {
      contacts,
      hasMore: contacts.length === PAGE_SIZE,
      // Real total the operator has access to (all filters applied,
      // pagination ignored) — drives the inbox "of N conversations".
      total: count ?? contacts.length,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface CreateContactBody {
  name: string;
  phone: string;
  tags?: string[];
  /** Explicit business number to attach this contact to. Optional —
   *  falls back to the default WHATSAPP_PHONE_NUMBER_ID credential
   *  when omitted (preserves the old single-number behaviour). */
  business_phone_number_id?: string | null;
  /** When true, only checks if a contact already exists on the given
   *  (wa_id, bpid) pair without inserting. Lets the "New chat" dialog
   *  warn the operator before creating a duplicate. */
  dry_run?: boolean;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CreateContactBody;
  try {
    body = (await request.json()) as CreateContactBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  // Normalize phone → digits only (wa_id is always digits, no +)
  const waId = (body.phone ?? "").replace(/[^\d]/g, "");
  if (waId.length < 7) {
    return NextResponse.json({ error: "Phone number looks invalid" }, { status: 400 });
  }

  const tags = (body.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);

  // Uniqueness moved from `wa_id` → `(wa_id, business_phone_number_id)`
  // in migration 0016. The old `onConflict: "wa_id"` no longer matches
  // any unique index, so Postgres throws "no unique or exclusion
  // constraint matching the ON CONFLICT specification" and the row
  // never lands. Match the composite key.
  //
  // Use the service-role client for the upsert — operator-initiated
  // creates from the Contacts page need to bypass RLS (the user-scoped
  // client returns "new row violates row-level security policy"
  // because contacts insert is gated on the webhook role). Auth is
  // already enforced by the getUser() check above.
  const businessPhoneNumberId =
    body.business_phone_number_id?.toString().trim() ||
    (await getCredential("whatsapp_phone_number_id")) ||
    null;
  const admin = createServiceRoleClient();

  // Dry-run: do an existence check WITHOUT inserting so the New-chat
  // dialog can warn the operator before creating a duplicate row.
  if (body.dry_run === true) {
    let query = admin
      .from("contacts")
      .select("*")
      .eq("wa_id", waId)
      .limit(1);
    if (businessPhoneNumberId) {
      query = query.eq("business_phone_number_id", businessPhoneNumberId);
    } else {
      query = query.is("business_phone_number_id", null);
    }
    const { data: found } = await query.maybeSingle();
    return NextResponse.json({
      exists: Boolean(found),
      contact: found ? (found as Contact) : null,
    });
  }

  const { data, error } = await admin
    .from("contacts")
    .upsert(
      {
        wa_id: waId,
        name,
        tags: tags.length > 0 ? tags : null,
        business_phone_number_id: businessPhoneNumberId,
      },
      { onConflict: "wa_id,business_phone_number_id" },
    )
    .select("*")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });
  }

  // Mirror the new contact onto LSQ — same fire-and-forget pattern as
  // the inbound webhook. ensure-lead looks the phone up first, links if
  // the lead already exists, otherwise creates it using the per-number
  // `lead_defaults` (Source / Sub Source / etc. that the operator set
  // on the LSQ integration page). Idempotent, safe to call on every
  // contact create; failure is non-fatal (we still return the row).
  void (async () => {
    try {
      const internalToken = await getCredential("webhook_internal_token");
      if (!internalToken) return;
      const origin =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      await fetch(`${origin}/api/lsq/ensure-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: (data as Contact).id,
          token: internalToken,
        }),
      });
    } catch (e) {
      console.warn(
        "[contacts] post-create ensure-lead failed:",
        e instanceof Error ? e.message : e,
      );
    }
  })();

  return NextResponse.json({ contact: data as Contact });
}
