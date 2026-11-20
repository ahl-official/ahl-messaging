// GET/POST /api/automation/process-pending
//
// Worker route — cron / in-process scheduler. Claims contacts whose
// `automation_pending_at` has elapsed and fires `runAutomation` once.
//
// Auth: same shared `webhook_internal_token` as /process.

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { drainPendingAutomation } from "@/lib/drain-pending-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  let token: string | null = null;
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    token = auth.slice(7).trim();
  }
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { token?: string };
      if (!token) token = body.token ?? null;
    } catch {
      /* allow empty body */
    }
  }
  if (!token) {
    token = request.nextUrl.searchParams.get("token");
  }
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  if (token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await drainPendingAutomation();
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
