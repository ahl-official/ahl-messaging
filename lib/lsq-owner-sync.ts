// Push the dashboard's chat-assignment over to CRM so the LSQ
// lead owner stays in sync with the dashboard's assigned_to_email.
// Best-effort — failures are logged but never block the dashboard
// assignment (matches every other LSQ helper in this codebase).
//
// Flow:
//   1. Look up the contact row → grab its cached lsq_prospect_id.
//      If missing, exit silently (lead hasn't been created yet; the
//      next inbound message's ensure-lead pass will pick this up
//      naturally).
//   2. Resolve the assignee email → LSQ user. LSQ's user list is
//      keyed by EmailAddress. We hit /Users.svc/Get/All once per
//      sync (cached for 5 minutes in-process) and match
//      case-insensitively.
//   3. PATCH the lead with the new OwnerId via the existing
//      lsqUpdateLead helper.
//   4. Mirror the assignee email back onto contacts.lsq_owner_email
//      so the inbox visibility query can filter without re-hitting
//      LSQ.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { lsqFetch } from "@/lib/lsq";

interface LsqUser {
  ID?: string;
  EmailAddress?: string;
  FirstName?: string;
  LastName?: string;
}

let userCache: { fetchedAt: number; users: LsqUser[] } | null = null;
const USER_CACHE_TTL_MS = 5 * 60 * 1000;

async function getLsqUsers(): Promise<LsqUser[]> {
  if (userCache && Date.now() - userCache.fetchedAt < USER_CACHE_TTL_MS) {
    return userCache.users;
  }
  // LSQ user list — typically dozens to a few hundred entries, fine to
  // pull in one go.
  const resp = await lsqFetch<LsqUser[] | { Users?: LsqUser[] }>({
    method: "GET",
    path: "/Users.svc/Get/All",
  });
  const raw = resp.data;
  const list: LsqUser[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { Users?: LsqUser[] } | null)?.Users)
      ? ((raw as { Users: LsqUser[] }).Users ?? [])
      : [];
  userCache = { fetchedAt: Date.now(), users: list };
  return list;
}

function findLsqUserByEmail(users: LsqUser[], email: string): LsqUser | null {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  return (
    users.find((u) => (u.EmailAddress ?? "").trim().toLowerCase() === target) ??
    null
  );
}

export async function syncLeadOwnerForContact(opts: {
  contactId: string;
  assigneeEmail: string;
}): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id")
    .eq("id", opts.contactId)
    .maybeSingle();
  if (!contact?.wa_id) {
    // No phone number to match against — give up cleanly.
    return;
  }

  const users = await getLsqUsers();
  const user = findLsqUserByEmail(users, opts.assigneeEmail);
  // Cache the assignee email locally regardless of whether we found an
  // LSQ user — the inbox visibility filter only needs the local cache.
  await admin
    .from("contacts")
    .update({ lsq_owner_email: opts.assigneeEmail?.trim().toLowerCase() ?? null })
    .eq("id", opts.contactId);
  if (!user?.ID) {
    // Operator email isn't an LSQ user — nothing to push upstream.
    return;
  }

  // Match the existing n8n flow: Lead.CreateOrUpdate with SearchBy=Phone.
  // This works even when the lead hasn't been pre-created (it'll insert
  // a fresh row), and we don't have to track LSQ prospect IDs locally.
  await lsqFetch({
    method: "POST",
    path: "/v2/LeadManagement.svc/Lead.CreateOrUpdate",
    body: [
      { Attribute: "Phone", Value: contact.wa_id },
      { Attribute: "OwnerId", Value: user.ID },
      { Attribute: "SearchBy", Value: "Phone" },
    ],
    timeoutMs: 15_000,
  });
}
