// Interakt numbers (owner-only). Each Interakt account = one business_numbers
// row (provider='interakt') with its own API key + webhook secret + URL.
//
//   GET    → list Interakt numbers
//   POST   → add a number { waba, api_key }  (generates a webhook secret)
//   PATCH  → update { phone_number_id, api_key?, nickname?, regenerate_secret? }
//   DELETE → remove ?phone_number_id=interakt:<waba>

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { generateWebhookSecret, getInteraktWebhookBase, parseForwardUrls } from "@/lib/interakt";

export const runtime = "nodejs";

function mask(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

async function ownerGuard() {
  const me = await getCurrentMember();
  if (!me) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (me.role !== "owner")
    return { error: NextResponse.json({ error: "Owners only" }, { status: 403 }) };
  return { me };
}

function normalizeWaba(input: string): string {
  return input.replace(/\D/g, "");
}

export async function GET() {
  const g = await ownerGuard();
  if (g.error) return g.error;

  const admin = createServiceRoleClient();
  const base = await getInteraktWebhookBase();
  const { data } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, nickname, interakt_api_key, interakt_webhook_secret, interakt_forward_url, created_at")
    .eq("provider", "interakt")
    .order("created_at", { ascending: true });

  const numbers = (data ?? []).map((n) => {
    const secret = (n.interakt_webhook_secret as string | null) ?? null;
    return {
      phone_number_id: n.phone_number_id as string,
      waba: (n.display_phone_number as string | null) ?? (n.phone_number_id as string).replace(/^interakt:/, ""),
      nickname: (n.nickname as string | null) ?? null,
      has_api_key: !!n.interakt_api_key,
      api_key_masked: mask((n.interakt_api_key as string | null) ?? null),
      webhook_secret: secret,
      webhook_url: base && secret ? `${base}/api/interakt/webhook/${secret}` : null,
      forward_urls: parseForwardUrls(n.interakt_forward_url as string | null),
    };
  });

  return NextResponse.json({ numbers, base });
}

export async function POST(request: NextRequest) {
  const g = await ownerGuard();
  if (g.error) return g.error;

  let body: { waba?: string; api_key?: string; nickname?: string; forward_urls?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const waba = normalizeWaba(body.waba ?? "");
  if (waba.length < 6) {
    return NextResponse.json({ error: "Valid WhatsApp number (with country code) required" }, { status: 400 });
  }
  const apiKey = (body.api_key ?? "").trim();
  const fwd = Array.isArray(body.forward_urls)
    ? body.forward_urls.map((u) => String(u ?? "").trim()).filter(Boolean)
    : [];
  const phoneNumberId = `interakt:${waba}`;
  const admin = createServiceRoleClient();

  const { error } = await admin.from("business_numbers").upsert(
    {
      phone_number_id: phoneNumberId,
      display_phone_number: waba,
      verified_name: "Interakt",
      nickname: body.nickname?.trim() || null,
      provider: "interakt",
      interakt_api_key: apiKey || null,
      interakt_webhook_secret: generateWebhookSecret(),
      interakt_forward_url: fwd.length > 0 ? JSON.stringify(fwd) : null,
    },
    { onConflict: "phone_number_id" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, phone_number_id: phoneNumberId });
}

export async function PATCH(request: NextRequest) {
  const g = await ownerGuard();
  if (g.error) return g.error;

  let body: {
    phone_number_id?: string;
    api_key?: string;
    nickname?: string;
    forward_urls?: string[];
    regenerate_secret?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const pid = body.phone_number_id?.trim();
  if (!pid?.startsWith("interakt:")) {
    return NextResponse.json({ error: "phone_number_id required" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.api_key === "string") patch.interakt_api_key = body.api_key.trim() || null;
  if (typeof body.nickname === "string") patch.nickname = body.nickname.trim() || null;
  if (Array.isArray(body.forward_urls)) {
    const urls = body.forward_urls.map((u) => String(u ?? "").trim()).filter(Boolean);
    patch.interakt_forward_url = urls.length > 0 ? JSON.stringify(urls) : null;
  }
  if (body.regenerate_secret) patch.interakt_webhook_secret = generateWebhookSecret();
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { error } = await admin.from("business_numbers").update(patch).eq("phone_number_id", pid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const g = await ownerGuard();
  if (g.error) return g.error;

  const pid = request.nextUrl.searchParams.get("phone_number_id")?.trim();
  if (!pid?.startsWith("interakt:")) {
    return NextResponse.json({ error: "phone_number_id required" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { error } = await admin.from("business_numbers").delete().eq("phone_number_id", pid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
