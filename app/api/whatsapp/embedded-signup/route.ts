// WhatsApp Embedded Signup — completion endpoint (owner/superadmin only).
//
// The browser finishes Meta's Embedded Signup popup and POSTs us the
// OAuth `code` plus the onboarded `phone_number_id` / `waba_id`. We:
//   1. exchange the code for a business token,
//   2. subscribe our app to the WABA (so inbound hits /api/webhook),
//   3. upsert the business_numbers row, and
//   4. file the number under a portfolio so the Cloud-API pipeline resolves
//      a token for sending.
//
// Coexistence (number stays on the WhatsApp Business App) vs full Cloud-API
// migration is decided by the Meta Embedded Signup *configuration*, not here.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getPortfolioByKey,
  invalidatePortfolioCache,
  listPortfolios,
} from "@/lib/portfolios";
import { appendPhoneIdToPortfolio } from "@/lib/env-writer";
import {
  exchangeCodeForToken,
  subscribeAppToWaba,
  fetchEmbeddedPhoneMeta,
} from "@/lib/embedded-signup";

export const runtime = "nodejs";

// GET — list the apps wired for Embedded Signup. app_id + config_id are
// public (used client-side in the FB SDK); app_secret never leaves here.
export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner" && me.role !== "superadmin") {
    return NextResponse.json({ apps: [] });
  }
  const apps = listPortfolios()
    .filter(
      (p) =>
        p.is_active && p.provider !== "interakt" && p.app_id && p.embedded_config_id,
    )
    .map((p) => ({
      key: p.key,
      name: p.name,
      app_id: p.app_id,
      embedded_config_id: p.embedded_config_id,
    }));
  return NextResponse.json({ apps });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner" && me.role !== "superadmin") {
    return NextResponse.json({ error: "Owners / superadmins only" }, { status: 403 });
  }

  let body: {
    code?: string;
    waba_id?: string;
    phone_number_id?: string;
    portfolio_key?: string;
    nickname?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const code = body.code?.trim();
  const wabaId = body.waba_id?.replace(/\D/g, "");
  const phoneNumberId = body.phone_number_id?.replace(/\D/g, "");
  const portfolioKey = body.portfolio_key?.trim();
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });
  if (!wabaId || !phoneNumberId) {
    return NextResponse.json(
      { error: "Embedded Signup did not return waba_id / phone_number_id" },
      { status: 400 },
    );
  }

  // The onboarding app's credentials live on the chosen portfolio, so we
  // know which of the (possibly several) Meta apps to exchange the code with.
  if (!portfolioKey) {
    return NextResponse.json({ error: "portfolio_key (app) required" }, { status: 400 });
  }
  const portfolio = getPortfolioByKey(portfolioKey);
  if (!portfolio) {
    return NextResponse.json({ error: `Unknown portfolio "${portfolioKey}"` }, { status: 400 });
  }
  if (!portfolio.app_id || !portfolio.app_secret) {
    return NextResponse.json(
      { error: `Portfolio "${portfolioKey}" me APP_ID / APP_SECRET set nahi hai` },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await exchangeCodeForToken(code, portfolio.app_id, portfolio.app_secret);
  } catch (e) {
    return NextResponse.json(
      { error: `Token exchange failed: ${e instanceof Error ? e.message : e}` },
      { status: 502 },
    );
  }

  // Subscribe + read display fields with the fresh token (the portfolio
  // token may not have access to a just-onboarded WABA yet).
  try {
    await subscribeAppToWaba(wabaId, token);
  } catch (e) {
    return NextResponse.json(
      { error: `Webhook subscribe failed: ${e instanceof Error ? e.message : e}` },
      { status: 502 },
    );
  }

  const meta = await fetchEmbeddedPhoneMeta(phoneNumberId, token).catch(() => null);

  const admin = createServiceRoleClient();
  const { error: upsertErr } = await admin.from("business_numbers").upsert(
    {
      phone_number_id: phoneNumberId,
      display_phone_number: meta?.display_phone_number ?? null,
      verified_name: meta?.verified_name ?? null,
      nickname: body.nickname?.trim() || null,
      provider: "meta",
      waba_id: wabaId,
    },
    { onConflict: "phone_number_id" },
  );
  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // File under a portfolio so resolveCredsForPhoneNumberId() finds a token
  // for outbound sends. Inbound text already works (webhook stores it
  // regardless of portfolio mapping).
  const result = await appendPhoneIdToPortfolio(portfolioKey, phoneNumberId);
  invalidatePortfolioCache();
  const assignedPersisted = result.persisted;
  const assignMessage = result.message;

  return NextResponse.json({
    ok: true,
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    platform_type: meta?.platform_type ?? null,
    status: meta?.status ?? null,
    assigned_persisted: assignedPersisted,
    message: assignMessage,
  });
}
