// GET /api/portfolios — read-only listing of env-defined portfolios.
//
// IMPORTANT: We never send the actual secrets (access_token, verify_token,
// app_id, business_account_id) over the wire. The client only needs to
// know whether each value is set — booleans are enough to render
// "Configured" / "Missing" indicators. Keeping secrets server-side
// prevents leakage via DOM, browser dev-tools, screenshots, or HAR
// captures during screen-shares.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { invalidatePortfolioCache, listPortfolios } from "@/lib/portfolios";
import {
  addPortfolioBlock,
  removePortfolioBlock,
  sanitizePortfolioKey,
} from "@/lib/env-writer";

export const runtime = "nodejs";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Strip every secret-bearing field. Send only what the UI needs to
  // display labels + status. Owners and non-owners get the same shape
  // — there's no value in showing the secrets to anyone in a browser.
  const portfolios = listPortfolios().map((p) => ({
    key: p.key,
    name: p.name,
    display_name: p.display_name,
    is_active: p.is_active,
    phone_number_ids: p.phone_number_ids,
    // Boolean status only — actual values stay server-side (in process.env).
    access_token: p.access_token ? "set" : "",
    verify_token: p.verify_token ? "set" : "",
    app_id: p.app_id ? "set" : null,
    business_account_id: p.business_account_id ? "set" : null,
  }));

  return NextResponse.json({ portfolios });
}

// =====================================================================
// POST — create a new portfolio. Owner-only. Body:
//   { key, name, access_token, verify_token,
//     app_id?, business_account_id?, display_name?, phone_number_ids?[] }
//
// Writes a complete PORTFOLIO_<key>_* block to .env.local AND updates
// process.env so the running server picks it up without a restart. In
// production the file write fails silently and we report `persisted: false`
// — operator must mirror the values in their hosting env vars before
// the next deploy.
// =====================================================================
interface PostBody {
  key?: string;
  name?: string;
  access_token?: string;
  verify_token?: string;
  app_id?: string | null;
  business_account_id?: string | null;
  display_name?: string | null;
  phone_number_ids?: string[];
  /** 'meta' (default) | 'interakt'. Interakt portfolios need only an
   *  account id — no Meta access/verify tokens. */
  provider?: string;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  let key: string;
  try {
    key = sanitizePortfolioKey(body.key ?? "");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid key" },
      { status: 400 },
    );
  }

  const provider = (body.provider?.trim().toLowerCase() || "meta");
  const isInterakt = provider === "interakt";
  const name = body.name?.trim();
  const accessToken = body.access_token?.trim();
  const verifyToken = body.verify_token?.trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  // Interakt portfolios carry only an account id — skip the Meta token
  // requirements. Meta portfolios still require both tokens.
  if (!isInterakt) {
    if (!accessToken)
      return NextResponse.json({ error: "Access token is required" }, { status: 400 });
    if (!verifyToken)
      return NextResponse.json({ error: "Verify token is required" }, { status: 400 });
  } else if (!body.business_account_id?.trim()) {
    return NextResponse.json({ error: "Account ID is required" }, { status: 400 });
  }

  // Validate phone ids — numeric only.
  const phoneIds = (body.phone_number_ids ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  for (const p of phoneIds) {
    if (!/^\d{6,}$/.test(p)) {
      return NextResponse.json(
        { error: `Invalid phone number ID: ${p}` },
        { status: 400 },
      );
    }
  }

  try {
    const result = await addPortfolioBlock({
      key,
      name,
      access_token: accessToken ?? "",
      verify_token: verifyToken ?? "",
      app_id: body.app_id?.trim() || null,
      business_account_id: body.business_account_id?.trim() || null,
      display_name: body.display_name?.trim() || null,
      phone_number_ids: phoneIds,
      provider,
    });
    invalidatePortfolioCache();
    return NextResponse.json({
      ok: true,
      key,
      persisted: result.persisted,
      message: result.message,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to add portfolio" },
      { status: 400 },
    );
  }
}

// =====================================================================
// DELETE — remove a portfolio block. Owner-only. ?key=<KEY>.
// Refuses if the portfolio still owns phone numbers — those would
// orphan into an inbox no one can send from. Reassign or detach first.
// =====================================================================
export async function DELETE(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const key = request.nextUrl.searchParams.get("key")?.trim();
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });

  const target = listPortfolios().find((p) => p.key === key);
  if (!target) {
    return NextResponse.json({ error: `Portfolio "${key}" not found` }, { status: 404 });
  }
  if (target.phone_number_ids.length > 0) {
    return NextResponse.json(
      {
        error: `Portfolio still has ${target.phone_number_ids.length} phone number(s). Detach them in Settings → Numbers first.`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await removePortfolioBlock(key);
    invalidatePortfolioCache();
    return NextResponse.json({
      ok: true,
      key,
      persisted: result.persisted,
      message: result.message,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to remove portfolio" },
      { status: 400 },
    );
  }
}
