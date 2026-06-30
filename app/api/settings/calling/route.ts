// Calling settings (Ozonetel + Tata Tele) — owner / superadmin only.
//
//   GET   → { ozonetel, tatatele, agents }   current accounts + the
//           per-operator agent bindings for both providers.
//   POST  → upsert one provider's account. body { provider, ...fields }.
//   PATCH → set one operator's agent bindings (any provider field).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getActiveOzonetelSettings, saveOzonetelSettings } from "@/lib/ozonetel";
import { getActiveTataTeleSettings, saveTataTeleSettings } from "@/lib/tatatele";

export const runtime = "nodejs";

async function requireOwner() {
  const me = await getCurrentMember();
  if (!me) return { error: "Unauthorized", status: 401 as const };
  if (me.role !== "owner" && me.role !== "superadmin")
    return { error: "Owners only", status: 403 as const };
  return { me };
}

export async function GET() {
  const gate = await requireOwner();
  if ("error" in gate)
    return NextResponse.json({ error: gate.error }, { status: gate.status });

  const [ozonetel, tatatele] = await Promise.all([
    getActiveOzonetelSettings(),
    getActiveTataTeleSettings(),
  ]);
  const admin = createServiceRoleClient();
  const { data: agents, error: agentsErr } = await admin
    .from("team_members")
    .select(
      "id, email, full_name, first_name, last_name, role, is_active, pending_approval, ozonetel_agent_id, ozonetel_phone, tatatele_agent_number",
    )
    .eq("is_active", true)
    .order("role", { ascending: true });
  if (agentsErr) {
    // Don't swallow — every column miss landed silently as agents:[].
    console.error(
      `[settings/calling] team_members query failed: ${agentsErr.message}. ` +
        `Check that migrations 0074_ozonetel.sql + 0075_tatatele.sql have run on this DB.`,
    );
  }

  return NextResponse.json({
    ozonetel: ozonetel
      ? {
          base_url: ozonetel.base_url,
          user_name: ozonetel.user_name,
          api_key: ozonetel.api_key,
          campaign_name: ozonetel.campaign_name,
          is_env_fallback: ozonetel.is_env_fallback,
        }
      : null,
    tatatele: tatatele
      ? {
          base_url: tatatele.base_url,
          api_token: tatatele.api_token,
          caller_id: tatatele.caller_id,
          is_env_fallback: tatatele.is_env_fallback,
        }
      : null,
    // Surface every active member. The old code also excluded
    // pending_approval=true rows, but some workspaces have older
    // members where that flag was never cleared — the result was an
    // empty Agent mapping list despite dozens of active operators.
    agents: agents ?? [],
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireOwner();
  if ("error" in gate)
    return NextResponse.json({ error: gate.error }, { status: gate.status });

  let body: Record<string, string | undefined>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (body.provider === "ozonetel") {
    const user_name = body.user_name?.trim();
    const api_key = body.api_key?.trim();
    const campaign_name = body.campaign_name?.trim();
    if (!user_name || !api_key || !campaign_name) {
      return NextResponse.json(
        { error: "user_name, api_key and campaign_name are required" },
        { status: 400 },
      );
    }
    await saveOzonetelSettings({
      base_url: body.base_url?.trim() || "https://in1-ccaas-api.ozonetel.com",
      user_name,
      api_key,
      campaign_name,
      created_by: gate.me.email ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.provider === "tatatele") {
    const api_token = body.api_token?.trim();
    const caller_id = body.caller_id?.trim();
    if (!api_token || !caller_id) {
      return NextResponse.json(
        { error: "api_token and caller_id are required" },
        { status: 400 },
      );
    }
    await saveTataTeleSettings({
      base_url:
        body.base_url?.trim() || "https://api-smartflo.tatateleservices.com",
      api_token,
      caller_id,
      created_by: gate.me.email ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "provider must be 'ozonetel' or 'tatatele'" },
    { status: 400 },
  );
}

export async function PATCH(request: NextRequest) {
  const gate = await requireOwner();
  if ("error" in gate)
    return NextResponse.json({ error: gate.error }, { status: gate.status });

  let body: {
    member_id?: string;
    ozonetel_agent_id?: string;
    ozonetel_phone?: string;
    tatatele_agent_number?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.member_id) {
    return NextResponse.json({ error: "member_id required" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  await admin
    .from("team_members")
    .update({
      ozonetel_agent_id: body.ozonetel_agent_id?.trim() || null,
      ozonetel_phone: body.ozonetel_phone?.trim() || null,
      tatatele_agent_number: body.tatatele_agent_number?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.member_id);
  return NextResponse.json({ ok: true });
}
