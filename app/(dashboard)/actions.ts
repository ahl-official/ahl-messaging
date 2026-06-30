"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { WHATSAPP_WINDOW_HOURS } from "@/lib/whatsapp-window";

async function requireUser() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null as never } as const;
  return { supabase, user } as const;
}

// ---------- Contact name ----------
export async function updateContactNameAction(
  contactId: string,
  name: string,
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const trimmed = name.trim();
  if (trimmed.length > 200) return { error: "Name too long" };

  const { data: contact, error } = await supabase
    .from("contacts")
    .update({ name: trimmed || null })
    .eq("id", contactId)
    .select("id, lsq_prospect_id")
    .single();

  if (error) return { error: error.message };

  // Mirror the new name onto the LSQ lead's FirstName so CRM and inbox
  // never drift apart. Fire-and-forget — operator already saw the local
  // save succeed, and an LSQ outage shouldn't block the inbox edit.
  if (contact?.lsq_prospect_id && trimmed) {
    void (async () => {
      try {
        const { lsqUpdateLead } = await import("@/lib/lsq");
        const result = await lsqUpdateLead(contact.lsq_prospect_id!, [
          { Attribute: "FirstName", Value: trimmed },
        ]);
        if (!result.ok) {
          console.warn(
            `[contacts] name → LSQ FirstName push failed for ${contactId}: ${result.error}`,
          );
        }
      } catch (e) {
        console.warn(
          "[contacts] name → LSQ push threw:",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }

  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------- Tags ----------
export async function setContactTagsAction(
  contactId: string,
  tags: string[],
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const cleaned = Array.from(
    new Set(
      tags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ).slice(0, 30);

  const { error } = await supabase.from("contacts").update({ tags: cleaned }).eq("id", contactId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------- Notes ----------
export async function addContactNoteAction(
  contactId: string,
  body: string,
): Promise<{ ok: true; id: string } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const trimmed = body.trim();
  if (!trimmed) return { error: "Note can't be empty" };
  if (trimmed.length > 2000) return { error: "Note too long (2000 max)" };

  const { data, error } = await supabase
    .from("contact_notes")
    .insert({
      contact_id: contactId,
      body: trimmed,
      created_by: user.id,
      created_by_email: user.email ?? null,
    })
    .select("id")
    .single();

  if (error || !data) return { error: error?.message ?? "Failed to add note" };
  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export async function deleteContactNoteAction(
  noteId: string,
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  // .select() so we can tell whether the row was actually deleted —
  // .delete().eq(...).eq("created_by", user.id) returns no error when 0 rows
  // matched, which would silently mask "you can't delete someone else's note".
  const { data, error } = await supabase
    .from("contact_notes")
    .delete()
    .eq("id", noteId)
    .eq("created_by", user.id)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return { error: "Note not found or you don't have permission to delete it." };
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------- Assignment ----------
export async function assignContactToMeAction(
  contactId: string,
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase
    .from("contacts")
    .update({
      assigned_to: user.id,
      assigned_to_email: user.email ?? null,
      assigned_at: new Date().toISOString(),
    })
    .eq("id", contactId);
  if (error) return { error: error.message };
  // Route the assignment to Interakt too (Interakt numbers only). Fire-
  // and-forget — never blocks the dashboard assignment.
  void import("@/lib/interakt")
    .then(({ syncInteraktAssignment }) => syncInteraktAssignment(contactId, user.email))
    .catch(() => {});
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function unassignContactAction(
  contactId: string,
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase
    .from("contacts")
    .update({ assigned_to: null, assigned_to_email: null, assigned_at: null })
    .eq("id", contactId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}

/** Assign a contact to a specific teammate (not necessarily the caller).
 *  Gated by the `can_assign_contacts` permission — operators without it
 *  can only assign themselves via assignContactToMeAction. When the
 *  assigner additionally has `can_sync_lsq_owner`, the same assignment
 *  is pushed to LSQ so the lead owner there matches the dashboard. */
export async function assignContactToUserAction(
  contactId: string,
  targetUserId: string,
  targetEmail: string,
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  // Permission check — owner bypasses.
  const { getCurrentEffectivePermissions } = await import("@/lib/permissions");
  const ctx = await getCurrentEffectivePermissions();
  if (
    ctx &&
    ctx.member.role !== "owner" &&
    !ctx.perms.can_assign_contacts
  ) {
    return { error: "You don't have permission to assign contacts." };
  }

  const { error } = await supabase
    .from("contacts")
    .update({
      assigned_to: targetUserId,
      assigned_to_email: targetEmail,
      assigned_at: new Date().toISOString(),
    })
    .eq("id", contactId);
  if (error) return { error: error.message };

  // Route the assignment to Interakt too (Interakt numbers only).
  void import("@/lib/interakt")
    .then(({ syncInteraktAssignment }) => syncInteraktAssignment(contactId, targetEmail))
    .catch(() => {});

  // Best-effort LSQ owner sync — only when the assigner has the
  // `can_sync_lsq_owner` capability AND LSQ is configured. We don't
  // block the dashboard assignment on LSQ — a failed sync logs but
  // doesn't surface as an error.
  if (ctx?.perms.can_sync_lsq_owner) {
    void import("@/lib/lsq-owner-sync")
      .then(({ syncLeadOwnerForContact }) =>
        syncLeadOwnerForContact({
          contactId,
          assigneeEmail: targetEmail,
        }),
      )
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(
          "[lsq-owner-sync] failed:",
          e instanceof Error ? e.message : e,
        );
      });
  }

  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------- Status ----------
export async function setContactStatusAction(
  contactId: string,
  status: "open" | "closed",
): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const { error } = await supabase
    .from("contacts")
    .update({ status })
    .eq("id", contactId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}

// ---------- 24-hour customer service window auto-close ----------
//
// Meta's rule: a business can only send free-form messages for 24 hours after
// the customer's last inbound message. Once that window expires, the only way
// to re-engage is via an approved template — and the customer must reply to
// reopen the window.
//
// This action sweeps every contact whose latest inbound is > 24h old and
// flips their status to 'closed'. We call it lazily on dashboard mount, so
// stale conversations get tidied up the moment any agent visits.
export async function autoCloseStaleConversationsAction(): Promise<{
  closed: number;
  error?: string;
}> {
  const { user } = await requireUser();
  if (!user) return { closed: 0, error: "Unauthorized" };

  // Bypass RLS — this is a system-level sweep that should run regardless of
  // the calling user's per-row visibility. We still gate by auth above.
  const admin = createServiceRoleClient();

  const cutoff = new Date(
    Date.now() - WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // The 24h customer-service window only OPENS on an inbound (patient)
  // message — an outbound (incl. marketing templates) never does. So a
  // chat's window is open iff the patient messaged in the last 24h.
  // Pull just the recent inbound slice (cheap) → the set of "open window"
  // contacts. Applies to ALL providers (Meta + Evolution + Interakt).
  const { data: recent, error: inErr } = await admin
    .from("messages")
    .select("contact_id")
    .eq("direction", "inbound")
    .gte("timestamp", cutoff);
  if (inErr) return { closed: 0, error: inErr.message };
  const windowOpen = new Set((recent ?? []).map((r) => r.contact_id as string));

  // Every non-closed contact that has activity (a message) but NO inbound
  // in the last 24h has a closed window → move it to "Closed".
  const { data: openContacts, error: cErr } = await admin
    .from("contacts")
    .select("id")
    .neq("status", "closed")
    .not("last_message_at", "is", null);
  if (cErr) return { closed: 0, error: cErr.message };
  const staleIds = (openContacts ?? [])
    .map((c) => c.id as string)
    .filter((id) => !windowOpen.has(id));

  if (staleIds.length === 0) return { closed: 0 };

  // Flip to 'closed' in chunks (a busy blast can leave hundreds stale).
  let closed = 0;
  for (let i = 0; i < staleIds.length; i += 500) {
    const chunk = staleIds.slice(i, i + 500);
    const { data: updated, error: updateErr } = await admin
      .from("contacts")
      .update({ status: "closed" })
      .in("id", chunk)
      .neq("status", "closed")
      .select("id");
    if (updateErr) return { closed, error: updateErr.message };
    closed += updated?.length ?? 0;
  }

  if (closed > 0) revalidatePath("/dashboard");
  return { closed };
}

