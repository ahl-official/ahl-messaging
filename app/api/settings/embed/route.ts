// GET  /api/settings/embed → CRM origins allowed to frame /embed + context.
// PUT  /api/settings/embed → save the origin list. Admin or above only.
//
// The runtime CSP (frame-ancestors) header is built from this list in
// middleware, so adding a CRM domain takes effect within ~1 min — no rebuild.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  getEmbedAllowedOrigins,
  setEmbedAllowedOrigins,
} from "@/lib/app-settings";

export const runtime = "nodejs";

function context() {
  return {
    // The shared parent cookie domain (build-time env) — informational so the
    // owner knows session-sharing only works under this same parent domain.
    cookie_domain:
      process.env.NEXT_PUBLIC_COOKIE_DOMAIN ||
      process.env.COOKIE_DOMAIN ||
      null,
  };
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }
  return NextResponse.json({
    origins: await getEmbedAllowedOrigins(),
    ...context(),
  });
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }

  let body: { origins?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.origins)) {
    return NextResponse.json({ error: "origins must be an array" }, { status: 400 });
  }
  // setEmbedAllowedOrigins normalizes (drops invalid / non-http(s), dedupes).
  const origins = await setEmbedAllowedOrigins(body.origins);
  return NextResponse.json({ ok: true, origins, ...context() });
}
