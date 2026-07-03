// GET /api/healthz — trivial liveness endpoint.
//
// Also used as the surl/furl placeholder on PayU DBQR (UPI QR) calls,
// which require a redirect URL even though the QR flow never actually
// redirects the client.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST() {
  return NextResponse.json({ ok: true });
}
