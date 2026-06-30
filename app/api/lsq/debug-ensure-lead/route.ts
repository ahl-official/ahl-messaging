// GET /api/lsq/debug-ensure-lead?contact_id=<uuid>&token=<webhook_token>
//
// Owner / token-only diagnostic. Replays the EXACT pipeline that the
// inbound webhook runs (lookup → upsert → cache prospect_id → push
// FirstName + lead_defaults + Country) so when "lead not created"
// mysteries strike we can see every step's input/output without
// scraping server logs.
//
// Use this when /api/lsq/debug-create-lead says "Success" but no lead
// shows up in LSQ — that means the create path works in isolation but
// something in the ensure-lead flow is short-circuiting.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import {
  getLsqConfig,
  lsqGetLeadByMobile,
  lsqUpsertLeadByPhone,
} from "@/lib/lsq";
import { countryFromCallingCode } from "@/lib/pincode";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const tokenParam = request.nextUrl.searchParams.get("token")?.trim();
  const expectedToken = (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
  const tokenAuthorized =
    tokenParam && expectedToken && tokenParam === expectedToken;

  if (!tokenAuthorized) {
    const member = await getCurrentMember();
    if (!member || member.role !== "owner") {
      return NextResponse.json(
        { error: "Owners only (or pass &token=...)" },
        { status: 403 },
      );
    }
  }

  const contactId = request.nextUrl.searchParams.get("contact_id")?.trim();
  const waIdParam = request.nextUrl.searchParams.get("wa_id")?.trim();
  if (!contactId && !waIdParam) {
    return NextResponse.json(
      { error: "Pass either contact_id=<uuid> or wa_id=<digits>" },
      { status: 400 },
    );
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 500 });
  }

  const admin = createServiceRoleClient();

  // Step 1: load the contact (or fake one from wa_id only).
  interface ContactShape {
    id: string;
    wa_id: string;
    profile_name: string | null;
    business_phone_number_id: string | null;
    lsq_prospect_id: string | null;
  }
  let contact: ContactShape;

  if (contactId) {
    const { data } = await admin
      .from("contacts")
      .select("id, wa_id, profile_name, business_phone_number_id, lsq_prospect_id")
      .eq("id", contactId)
      .maybeSingle();
    if (!data) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    contact = data as ContactShape;
  } else {
    contact = {
      id: "(synthetic)",
      wa_id: waIdParam!,
      profile_name: null,
      business_phone_number_id: null,
      lsq_prospect_id: null,
    };
  }

  const trace: Record<string, unknown> = {
    step_1_contact: contact,
  };

  // Step 2: read lead_defaults from automation_configs (same as ensure-lead).
  let leadDefaults: Array<{ lsq_field: string; value: string }> = [];
  if (contact.business_phone_number_id) {
    const { data: cfgRow, error: cfgErr } = await admin
      .from("automation_configs")
      .select("lead_defaults")
      .eq("business_phone_number_id", contact.business_phone_number_id)
      .maybeSingle();
    if (cfgErr) {
      trace.step_2_config_error = cfgErr.message;
    }
    if (cfgRow?.lead_defaults && Array.isArray(cfgRow.lead_defaults)) {
      leadDefaults = cfgRow.lead_defaults as Array<{ lsq_field: string; value: string }>;
    }
    trace.step_2_lead_defaults = leadDefaults;
  } else {
    trace.step_2_lead_defaults = "no business_phone_number_id on contact — skipping";
  }

  // Step 3: build the field array exactly like ensure-lead does.
  const extraFields = leadDefaults
    .filter((d) => d.lsq_field && d.value)
    .map((d) => ({ Attribute: d.lsq_field.trim(), Value: d.value.trim() }));

  const country = countryFromCallingCode(contact.wa_id);
  if (country && !extraFields.some((f) => f.Attribute === "Country")) {
    extraFields.push({ Attribute: "Country", Value: country });
  }

  const profileName = (contact.profile_name ?? "").trim();
  if (profileName && !extraFields.some((f) => f.Attribute === "FirstName")) {
    extraFields.push({ Attribute: "FirstName", Value: profileName });
  }
  trace.step_3_fields_to_push = extraFields;

  // Step 4: standalone phone lookup so we can see what (if anything) matches
  // before the upsert collapses lookup + create into one return value.
  const lookup = await lsqGetLeadByMobile(contact.wa_id);
  trace.step_4_lookup = {
    ok: lookup.ok,
    found: lookup.found,
    matched_variant: lookup.matched_variant,
    error: lookup.error,
    lead_id: lookup.lead?.prospect_id ?? null,
    lead_number: lookup.lead?.lead_number ?? null,
    first_name: lookup.lead?.first_name ?? null,
    phone: lookup.lead?.phone ?? null,
  };

  // Step 5: run the upsert. This is the function the webhook actually calls.
  const upsert = await lsqUpsertLeadByPhone(contact.wa_id, extraFields);
  trace.step_5_upsert = upsert;

  // Step 6: if we got a prospect_id back AND we have a real contact row,
  // cache it (the webhook does this — replicate so debug runs leave the
  // contact in the same state as a real msg would).
  if (upsert.ok && upsert.prospect_id && contact.id !== "(synthetic)") {
    const { error: updateErr } = await admin
      .from("contacts")
      .update({
        lsq_prospect_id: upsert.prospect_id,
        lsq_synced_at: new Date().toISOString(),
      })
      .eq("id", contact.id);
    trace.step_6_cache_updated = updateErr ? `ERROR: ${updateErr.message}` : "ok";
  } else {
    trace.step_6_cache_updated = "skipped";
  }

  return NextResponse.json({
    summary: upsert.ok
      ? upsert.created
        ? `CREATED new lead — id=${upsert.prospect_id}`
        : `UPDATED existing lead — id=${upsert.prospect_id}`
      : `FAILED — ${upsert.error}`,
    trace,
  });
}
