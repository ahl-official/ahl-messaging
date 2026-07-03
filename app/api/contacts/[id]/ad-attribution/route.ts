// GET /api/contacts/[id]/ad-attribution
//
// Resolves a Click-to-WhatsApp lead's ad → ad set → campaign NAMES from the
// referral `source_id` (the Meta ad id captured in utm_params at first inbound).
// Uses the Meta Marketing API with META_ADS_TOKEN (needs ads_read on the ad
// account). Read-only; safe to call lazily from the contact panel.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdsTokenForPhoneNumberId } from "@/lib/ads-tokens";
import { getCredential } from "@/lib/credentials";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";

/** Fire-and-forget re-sync to LSQ so freshly-resolved ad fields (campaign
 *  / ad set / ad) get pushed via the number's "Facebook Ads fields"
 *  mappings. force=true so an already-linked lead re-runs. */
async function pushFbAdFieldsToLsq(contactId: string): Promise<void> {
  try {
    const token = await getCredential("webhook_internal_token");
    if (!token) return;
    const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    await fetch(`${origin}/api/lsq/ensure-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, token, force: true }),
    });
  } catch {
    /* best-effort */
  }
}

interface MetaAd {
  name?: string;
  adset?: { name?: string; id?: string };
  campaign?: { name?: string; id?: string };
  error?: { message?: string; code?: number };
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("utm_params, business_phone_number_id")
    .eq("id", params.id)
    .maybeSingle();

  const utm = (contact?.utm_params as Record<string, string> | null) ?? null;
  const sourceId = utm?.source_id?.trim();
  if (!sourceId || !/^\d+$/.test(sourceId)) {
    return NextResponse.json({ ok: true, attribution: null });
  }

  // Already resolved + stored on a previous load → serve from the table,
  // never hit Meta again.
  if (utm?._ad_resolved) {
    return NextResponse.json({
      ok: true,
      cached: true,
      attribution: {
        source_id: sourceId,
        ad_name: utm.ad_name ?? null,
        adset_id: utm.adset_id ?? null,
        adset_name: utm.adset_name ?? null,
        campaign_id: utm.campaign_id ?? null,
        campaign_name: utm.campaign_name ?? null,
      },
    });
  }

  const phoneNumberId = (contact?.business_phone_number_id as string | null) ?? "";
  const token = phoneNumberId
    ? await resolveAdsTokenForPhoneNumberId(phoneNumberId)
    : null;
  if (!token) {
    return NextResponse.json(
      { error: "No ads token for this number's portfolio — set one in Settings → Ads / Marketing." },
      { status: 400 },
    );
  }

  const apiVersion = await getApiVersion();
  const url = `https://graph.facebook.com/${apiVersion}/${sourceId}?fields=name,adset{name,id},campaign{name,id}&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = (await res.json()) as MetaAd;
    if (!res.ok || json.error) {
      return NextResponse.json(
        { error: json.error?.message ?? `Meta API ${res.status}` },
        { status: 502 },
      );
    }
    const resolved = {
      ad_name: json.name ?? null,
      adset_id: json.adset?.id ?? null,
      adset_name: json.adset?.name ?? null,
      campaign_id: json.campaign?.id ?? null,
      campaign_name: json.campaign?.name ?? null,
    };
    // Persist into utm_params so future loads read from the table (and we
    // mark it resolved so a lead with no campaign isn't retried forever).
    await admin
      .from("contacts")
      .update({ utm_params: { ...(utm ?? {}), ...resolved, _ad_resolved: "1" } })
      .eq("id", params.id);

    // Now that campaign / ad set / ad names exist, re-run the CRM sync so
    // any "Facebook Ads fields" mappings (campaign etc.) reach the CRM.
    // Fire-and-forget; the route gates on the per-number config itself.
    void pushFbAdFieldsToLsq(params.id);

    return NextResponse.json({ ok: true, attribution: { source_id: sourceId, ...resolved } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lookup failed" },
      { status: 502 },
    );
  }
}
