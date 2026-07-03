// PATCH /api/lsq/lead/update
//
// Operator-side edits to CRM lead fields from the contact-details
// panel. Each panel field has its own LSQ schema name; the client
// sends `{contact_id, fields: {schema: value}}` and we push them via
// Lead.Update (no SearchBy → no duplicate risk).
//
// Required: contact_id must already have lsq_prospect_id cached. We
// don't lookup-first here because edits are explicit operator actions
// — if the lead doesn't exist yet, return 404 so the UI can prompt to
// open the chat / wait for the auto-sync. Bi-directional sync between
// LSQ and the inbox is "fetch on open" (useLsqLead) — pulling from
// LSQ is already covered.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getLsqConfig, lsqUpdateLead } from "@/lib/lsq";

export const runtime = "nodejs";

interface PatchBody {
  contact_id?: string;
  /** Map of LSQ schema name → new value. Empty string clears the field. */
  fields?: Record<string, string>;
}

export async function PATCH(request: NextRequest) {
  // Anyone admin+ can edit lead fields — same gate as the rest of the
  // operator surface. Teammates can read but not push edits to CRM.
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const contactId = body.contact_id?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }
  if (!body.fields || typeof body.fields !== "object") {
    return NextResponse.json({ error: "fields is required" }, { status: 400 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "CRM not configured" }, { status: 500 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, lsq_prospect_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (!contact.lsq_prospect_id) {
    return NextResponse.json(
      {
        error:
          "No CRM lead linked yet — the lead is created on the customer's first inbound. Try again after the next message.",
      },
      { status: 409 },
    );
  }

  // Translate `{schema: value}` into the array-of-{Attribute,Value}
  // shape Lead.Update expects. Empty strings are kept (the operator's
  // way to clear a field) — only undefined/null/whitespace-only get
  // dropped so we don't accidentally clear other fields.
  const updates = Object.entries(body.fields)
    .filter(([k]) => typeof k === "string" && k.trim().length > 0)
    .map(([k, v]) => ({
      Attribute: k.trim(),
      Value: typeof v === "string" ? v.trim() : "",
    }));

  if (updates.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const result = await lsqUpdateLead(contact.lsq_prospect_id, updates);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "LSQ update failed", status: result.status },
      { status: 502 },
    );
  }

  // Mirror the panel's "Name" edit onto the local contact row so the
  // inbox / chat header pick it up immediately without waiting for the
  // next LSQ refetch. Other CRM fields stay LSQ-only — the panel reads
  // them through useLsqLead which fetches fresh on open.
  const firstName = body.fields["FirstName"];
  if (typeof firstName === "string" && firstName.trim()) {
    await admin
      .from("contacts")
      .update({ name: firstName.trim() })
      .eq("id", contact.id);
  }

  return NextResponse.json({
    ok: true,
    fields_updated: updates.map((u) => u.Attribute),
  });
}
