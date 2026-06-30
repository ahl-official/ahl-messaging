// GET /api/bookings/calendar-check
//
// Owner-only Google Calendar connection diagnostic. Forces a fresh token +
// a wide events probe and reports exactly what failed (auth / domain-wide
// delegation / calendar id) or how many events were found — so a blank
// Date Align calendar can be diagnosed without SSH-ing into the box.
// Never returns secrets (no token, no private key).

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { diagnoseGoogleCalendar } from "@/lib/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const diag = await diagnoseGoogleCalendar();

  // A plain-English verdict so the operator knows the next step at a glance.
  let verdict: string;
  if (!diag.configured) {
    verdict =
      "Not configured — set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY and GOOGLE_CALENDAR_ID in .env.local, then restart.";
  } else if (!diag.tokenOk) {
    verdict =
      "Auth failed — usually the private key is mangled (must be one line with \\n), or Domain-Wide Delegation for the service account's Client ID + calendar scope isn't authorized yet (can take a few minutes). See `error`.";
  } else if (diag.error) {
    verdict =
      "Authed, but reading the calendar failed — check GOOGLE_CALENDAR_ID and that the impersonated user can access it. See `error`.";
  } else if (diag.eventCount === 0) {
    verdict =
      "Connected OK, but this calendar has 0 events in the -7…+120 day window. The Date Align calendar is empty because there's nothing to show — create an event in this calendar (or confirm a booking) and it'll appear.";
  } else {
    verdict = `Connected OK — ${diag.eventCount} event(s) visible. Date Align should show data.`;
  }

  return NextResponse.json(
    { ok: true, verdict, ...diag },
    { headers: { "Cache-Control": "no-store" } },
  );
}
