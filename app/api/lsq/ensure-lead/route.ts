// POST /api/lsq/ensure-lead
//
// Ensures the LSQ lead matching a contact's phone number exists, then
// caches the prospect_id back on the contact row. Called fire-and-
// forget by the inbound webhook for every new conversation so the
// "WhatsApp message → CRM lead" handoff is automatic — no need for
// an agent to open the chat first.
//
// Cheap-idempotent: every call does a phone lookup first via
// `lsqUpsertLeadByPhone` — if a lead exists we just push the latest
// fields onto it; only when the phone is genuinely new do we create.
// This means a stale cached prospect_id (e.g. from a lead deleted in
// LSQ by an admin) self-heals — we don't trust the cache blindly.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN. Same handshake the webhook
// uses to call /api/automation/process.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { getCurrentMember } from "@/lib/team";
import {
  getLsqConfig,
  lsqCreateLeadByPhone,
  lsqGetLeadById,
  lsqGetLeadByMobile,
  lsqUpdateLead,
} from "@/lib/lsq";
import { isWaIdLikelyReal } from "@/lib/evolution";
import { getLsqEvolutionLeadCreateEnabled } from "@/lib/app-settings";
import { countryFromCallingCode } from "@/lib/pincode";
import { buildFbAdLeadFields, type FbAdFieldMapping } from "@/lib/utm";

export const runtime = "nodejs";

/** Concatenate two LSQ attribute lists, dropping later duplicates of an
 *  Attribute already present (base list wins). */
function mergeAttrs(
  base: Array<{ Attribute: string; Value: string }>,
  extra: Array<{ Attribute: string; Value: string }>,
): Array<{ Attribute: string; Value: string }> {
  const seen = new Set(base.map((f) => f.Attribute));
  return [...base, ...extra.filter((f) => !seen.has(f.Attribute))];
}

interface Body {
  contact_id?: string;
  /** Caller's shared secret. */
  token?: string;
  /** Force re-run even if prospect_id is already cached. */
  force?: boolean;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  // Accept the internal token (header / body) OR a logged-in dashboard
  // member (so the "Retry sync" / "Re-push fields" buttons work from the UI).
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const tokenOk = auth === expected || body.token === expected;
  if (!tokenOk) {
    const member = await getCurrentMember();
    if (!member) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const contactId = body.contact_id?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    // Silent success — no LSQ configured, nothing to do.
    return NextResponse.json({ ok: true, skipped: "lsq_not_configured" });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, business_phone_number_id, lsq_prospect_id, profile_name, utm_params")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  // Capture into a local so TS keeps the non-null narrowing inside the
  // nested helper closures.
  const c = contact;

  // Interakt numbers run their own CRM/routing by default, so a WhatsApp
  // inbound must not create or re-attribute an LSQ lead — UNLESS this specific
  // number has been opted in via its automation_config (enabled = true). Keeps
  // every other Interakt number untouched. (bpid is prefixed "interakt:".)
  if ((c.business_phone_number_id ?? "").startsWith("interakt:")) {
    const { data: icfg } = await admin
      .from("automation_configs")
      .select("enabled")
      .eq("business_phone_number_id", c.business_phone_number_id)
      .maybeSingle();
    if (!icfg?.enabled) {
      return NextResponse.json({ ok: true, skipped: "interakt_number" });
    }
  }

  // Reject WhatsApp synthetic IDs (LID / privacy / business / etc.).
  // These come through as 15-digit "numbers" with no real country code
  // and were the source of 718 garbage LSQ leads at QHT before this
  // guard was added. Stamp lsq_synced_at so the nightly sync stops
  // retrying — there's nothing to retry.
  if (!isWaIdLikelyReal(c.wa_id)) {
    await admin
      .from("contacts")
      .update({
        lsq_synced_at: new Date().toISOString(),
        lsq_last_sync_at: new Date().toISOString(),
        lsq_last_sync_status: "skipped",
        lsq_last_sync_error: "wa_id_not_a_real_phone_number",
      })
      .eq("id", c.id);
    console.log(
      `[lsq/ensure-lead] skipping non-phone wa_id=${c.wa_id} contact=${c.id} — likely a WhatsApp LID / privacy ID`,
    );
    return NextResponse.json({
      ok: true,
      skipped: "not_a_real_phone_number",
      wa_id: c.wa_id,
    });
  }

  // Helper: persist sync outcome onto the contact so the dashboard can
  // surface it without polling LSQ. Also logs each call so VPS pm2
  // logs carry a breadcrumb trail.
  async function persistOutcome(
    status: "created" | "linked" | "skipped" | "error",
    opts: { error?: string; fields?: string[]; prospect_id?: string } = {},
  ) {
    const patch: Record<string, unknown> = {
      lsq_last_sync_at: new Date().toISOString(),
      lsq_last_sync_status: status,
      lsq_last_sync_error: opts.error ?? null,
      lsq_last_sync_fields: opts.fields ?? null,
    };
    if (opts.prospect_id) {
      patch.lsq_prospect_id = opts.prospect_id;
      patch.lsq_synced_at = new Date().toISOString();
    }
    await admin.from("contacts").update(patch).eq("id", c.id);
    console.log(
      `[lsq/ensure-lead] contact=${c.id} wa_id=${c.wa_id} status=${status}` +
        (opts.error ? ` error="${opts.error}"` : "") +
        (opts.fields?.length ? ` fields=${opts.fields.join(",")}` : ""),
    );
  }

  // Pull this number's lead_defaults (Source / Sub Source / etc.) so
  // they get stamped on every NEW lead from this WhatsApp number. Plus
  // the re-attribution controls (0027) so we know whether/when to also
  // patch existing leads.
  let leadDefaults: Array<{ lsq_field: string; value: string }> = [];
  // Separate list of fields to patch onto EXISTING leads. Empty = fall back
  // to leadDefaults (old behaviour — push all the create defaults).
  let updateLeadFields: Array<{ lsq_field: string; value: string }> = [];
  let updateExistingSource = false;
  let updateExistingMaxAgeDays: number | null = null;
  // Meta ad-attribution → LSQ field pushes, resolved from this contact's
  // utm_params (Source ID / Ad Click ID / Campaign …).
  let fbAdFields: Array<{ Attribute: string; Value: string }> = [];
  if (contact.business_phone_number_id) {
    const { data: cfg } = await admin
      .from("automation_configs")
      .select(
        "lead_defaults, update_lead_fields, lsq_lead_create_enabled, update_existing_lead_source, update_existing_lead_max_age_days, lsq_fb_ads_fields",
      )
      .eq("business_phone_number_id", contact.business_phone_number_id)
      .maybeSingle();

    if (cfg && cfg.lsq_lead_create_enabled === false) {
      await persistOutcome("skipped", { error: "lsq_lead_create_disabled" });
      return NextResponse.json({ ok: true, skipped: "lsq_lead_create_disabled" });
    }

    // Workspace-wide kill switch for Evolution (Baileys) numbers — when
    // OFF, every Evolution-provider inbound is dropped before the LSQ
    // round-trip. Used when Evolution numbers are flooding the CRM with
    // junk leads. Meta numbers are unaffected.
    const evoEnabled = await getLsqEvolutionLeadCreateEnabled();
    if (!evoEnabled) {
      const { data: bn } = await admin
        .from("business_numbers")
        .select("provider")
        .eq("phone_number_id", contact.business_phone_number_id)
        .maybeSingle();
      if (bn?.provider === "evolution") {
        await persistOutcome("skipped", {
          error: "lsq_evolution_lead_create_disabled",
        });
        return NextResponse.json({
          ok: true,
          skipped: "lsq_evolution_lead_create_disabled",
        });
      }
    }
    if (cfg?.lead_defaults && Array.isArray(cfg.lead_defaults)) {
      leadDefaults = cfg.lead_defaults as Array<{ lsq_field: string; value: string }>;
    }
    if (cfg?.update_lead_fields && Array.isArray(cfg.update_lead_fields)) {
      updateLeadFields = cfg.update_lead_fields as Array<{ lsq_field: string; value: string }>;
    }
    updateExistingSource = cfg?.update_existing_lead_source === true;
    const rawAge = cfg?.update_existing_lead_max_age_days;
    updateExistingMaxAgeDays =
      typeof rawAge === "number" && rawAge > 0 ? rawAge : null;
    fbAdFields = buildFbAdLeadFields(
      contact.utm_params as Record<string, unknown> | null,
      cfg?.lsq_fb_ads_fields as FbAdFieldMapping[] | null,
    );
  }


  // Existing lead path. Default: just link locally — never overwrite
  // attribution. If the operator turned on "Also update existing leads'
  // source", patch the lead's Source / mx_Sub_source from this number's
  // defaults, optionally gated by lead-age.
  const existing = await lsqGetLeadByMobile(contact.wa_id);
  if (existing.found && existing.lead?.prospect_id) {
    const prospectId = existing.lead.prospect_id;

    // `force` (manual "Re-push fields" button) overrides the operator's
    // update-existing toggle AND the age gate — re-pushes Source / fb-ad /
    // default fields onto the existing lead on demand (e.g. when an earlier
    // sync dropped them due to an LSQ rate-limit).
    if ((updateExistingSource || body.force) && (leadDefaults.length > 0 || fbAdFields.length > 0)) {
      // Age gate: skip when lead is older than max_age_days (ignored on force).
      let tooOld = false;
      let ageDays: number | null = null;
      if (!body.force && updateExistingMaxAgeDays != null && existing.lead.created_on) {
        const createdMs = Date.parse(existing.lead.created_on);
        if (!Number.isNaN(createdMs)) {
          ageDays = Math.floor((Date.now() - createdMs) / 86_400_000);
          if (ageDays > updateExistingMaxAgeDays) tooOld = true;
        }
      }
      if (tooOld) {
        await persistOutcome("linked", {
          prospect_id: prospectId,
          error: `lead_too_old (${ageDays}d > ${updateExistingMaxAgeDays}d cap)`,
        });
        return NextResponse.json({
          ok: true,
          prospect_id: prospectId,
          created: false,
          fields_pushed: [],
          note: "existing_lead_too_old",
        });
      }

      // Which fields to patch onto the existing lead — the operator's
      // dedicated "update fields" list if set, otherwise the create
      // defaults (back-compat). Lets them pick e.g. only Source on update
      // while still stamping more fields on brand-new leads.
      const patchSource = updateLeadFields.length > 0 ? updateLeadFields : leadDefaults;
      const patchFields = mergeAttrs(
        patchSource
          .filter((d) => d.lsq_field && d.value)
          .map((d) => ({ Attribute: d.lsq_field.trim(), Value: d.value.trim() })),
        fbAdFields,
      );

      if (patchFields.length > 0) {
        console.log(
          `[lsq/ensure-lead] re-attributing existing lead ${prospectId} wa_id=${contact.wa_id} fields=${patchFields.map((f) => f.Attribute).join(",")}`,
        );
        const upd = await lsqUpdateLead(prospectId, patchFields);
        if (!upd.ok) {
          await persistOutcome("linked", {
            prospect_id: prospectId,
            error: `re_attribute_failed: ${upd.error ?? "unknown"}`,
            fields: patchFields.map((f) => f.Attribute),
          });
          return NextResponse.json({
            ok: true,
            prospect_id: prospectId,
            created: false,
            fields_pushed: [],
            note: "existing_lead_re_attribute_failed",
            error: upd.error,
          });
        }
        const dropped = upd.dropped_attrs ?? [];
        const accepted = patchFields
          .map((f) => f.Attribute)
          .filter((a) => !dropped.includes(a));
        await persistOutcome("linked", {
          prospect_id: prospectId,
          fields: accepted,
          error:
            dropped.length > 0
              ? `dropped_unknown_attrs: ${dropped.join(", ")} — fix the schema name in Lead defaults`
              : undefined,
        });
        return NextResponse.json({
          ok: true,
          prospect_id: prospectId,
          created: false,
          fields_pushed: accepted,
          dropped_attrs: dropped,
          note: dropped.length > 0
            ? "existing_lead_re_attributed_partial"
            : "existing_lead_re_attributed",
        });
      }
    }

    await persistOutcome("linked", { prospect_id: prospectId });
    return NextResponse.json({
      ok: true,
      prospect_id: prospectId,
      created: false,
      fields_pushed: [],
      note: "existing_lead_linked",
    });
  }

  // NEW lead path. The phone lookup above said "not found", but the
  // LSQ Lead.CreateOrUpdate SearchBy=Phone matcher is stricter than our
  // RetrieveLeadByPhoneNumber lookup, so it CAN still match an existing
  // lead (the lookup occasionally misses). To never re-attribute such a
  // lead when "Also update existing leads' source" is OFF — yet still
  // avoid creating a duplicate — we split the write:
  //
  //   • Operator attribution defaults (Source / Sub Source / Brand …) +
  //     FB-ad fields — must NOT overwrite an existing lead's Source.
  //   • Neutral auto-fields (FirstName / mx_Country) — safe on any lead.
  const attributionFields = mergeAttrs(
    leadDefaults
      .filter((d) => d.lsq_field && d.value)
      .map((d) => ({ Attribute: d.lsq_field.trim(), Value: d.value.trim() })),
    fbAdFields,
  );
  const neutralFields: { Attribute: string; Value: string }[] = [];
  const profileName = (contact.profile_name ?? "").trim();
  if (profileName) neutralFields.push({ Attribute: "FirstName", Value: profileName });
  const country = countryFromCallingCode(contact.wa_id);
  if (country) neutralFields.push({ Attribute: "mx_Country", Value: country });

  let prospectId: string;
  let accepted: string[] = [];
  let dropped: string[] = [];

  if (updateExistingSource) {
    // Re-attribution ON — operator opted in. Upsert everything; existing
    // leads get their Source overwritten by design.
    const all = mergeAttrs(attributionFields, neutralFields);
    const created = await lsqCreateLeadByPhone(contact.wa_id, all, { upsert: true });
    if (!created.ok || !created.prospect_id) {
      await persistOutcome("error", {
        error: created.error ?? "LSQ Create failed",
        fields: all.map((f) => f.Attribute),
      });
      return NextResponse.json(
        { ok: false, error: created.error ?? "LSQ Create failed", status: created.status },
        { status: 502 },
      );
    }
    prospectId = created.prospect_id;
    dropped = created.dropped_attrs ?? [];
    accepted = all.map((f) => f.Attribute).filter((a) => !dropped.includes(a));
  } else {
    // Re-attribution OFF — if the lead already exists, touch NOTHING.
    // Step 1: upsert with ONLY the phone (no field values). SearchBy
    // matches an existing lead but changes no field; a genuinely-new
    // phone creates a bare lead. Either way, no existing value is
    // overwritten and no duplicate is made.
    const created = await lsqCreateLeadByPhone(contact.wa_id, [], { upsert: true });
    if (!created.ok || !created.prospect_id) {
      await persistOutcome("error", {
        error: created.error ?? "LSQ Create failed",
      });
      return NextResponse.json(
        { ok: false, error: created.error ?? "LSQ Create failed", status: created.status },
        { status: 502 },
      );
    }
    prospectId = created.prospect_id;

    // Step 2: read the lead back. Source blank = genuinely new → stamp
    // the schema values (defaults + name/country). Source present =
    // pre-existing lead → leave it completely untouched.
    const lead = await lsqGetLeadById(prospectId);
    const hasSource = !!(lead.ok && lead.fields.Source && lead.fields.Source.trim());
    if (!hasSource) {
      const newLeadFields = mergeAttrs(attributionFields, neutralFields);
      if (newLeadFields.length > 0) {
        const upd = await lsqUpdateLead(prospectId, newLeadFields);
        dropped = upd.dropped_attrs ?? [];
        accepted = newLeadFields.map((f) => f.Attribute).filter((a) => !dropped.includes(a));
      }
    } else {
      console.log(
        `[lsq/ensure-lead] existing lead ${prospectId} (Source "${lead.fields.Source}") — toggle off, nothing updated`,
      );
    }
  }

  await persistOutcome("created", {
    prospect_id: prospectId,
    fields: accepted,
    error:
      dropped.length > 0
        ? `dropped_unknown_attrs: ${dropped.join(", ")} — fix the schema name in Lead defaults`
        : undefined,
  });

  return NextResponse.json({
    ok: true,
    prospect_id: prospectId,
    created: true,
    fields_pushed: accepted,
    dropped_attrs: dropped,
  });
}
