// Minimal Google Calendar client for the booking feature — service-account
// auth with ZERO new npm deps (RS256 JWT signed via Node's built-in crypto,
// exchanged for an access token, then the Calendar REST API over fetch).
//
// Setup (salon does this once):
//   1. Google Cloud Console → enable "Google Calendar API".
//   2. Create a Service Account → create a JSON key.
//   3. Share the salon's Google Calendar with the service-account email,
//      giving it "Make changes to events".
//   4. Set env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//      (the PEM, newlines escaped as \n), GOOGLE_CALENDAR_ID (usually the
//      calendar's email/id).
//
// Everything here is best-effort: if creds are missing or a call fails, it
// degrades to "no calendar" so the booking flow still works app-side.

import crypto from "node:crypto";

const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

// The PEM private key is the #1 source of setup pain — .env mangles its
// newlines, keeps wrapping quotes, or truncates it on a multi-line paste,
// all of which make Node's crypto throw "DECODER routines::unsupported".
// Resolution order:
//   1. GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64 — base64 of the raw PEM.
//      Immune to every newline/quote problem; the recommended way.
//   2. GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY — normalise escaped newlines
//      (\\n / \n), strip accidental wrapping quotes + CRs.
function loadPrivateKey(): string {
  const b64 = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64 || "").trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (decoded.includes("PRIVATE KEY")) return decoded.trim() + "\n";
    } catch {
      /* fall through to the raw key */
    }
  }
  let k = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  k = k
    .replace(/\\\\n/g, "\n") // double-escaped \\n
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n") // the common case: literal \n
    .replace(/\r/g, "");
  return k.trim() ? k.trim() + "\n" : "";
}
const SA_KEY = loadPrivateKey();
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
// Domain-wide delegation (opt-in): when the calendar lives in a Google
// Workspace that blocks external "make changes" sharing, set this to the
// Workspace user the service account should act AS (usually the calendar
// owner, e.g. khushnaseeb@qhtclinic.com). ONLY set this AFTER granting the
// SA's client ID the calendar scope under Admin Console → Security → API
// Controls → Domain-wide Delegation — otherwise the token exchange fails.
const IMPERSONATE_USER = process.env.GOOGLE_IMPERSONATE_USER?.trim() || undefined;
const SCOPE = "https://www.googleapis.com/auth/calendar";

export function isGoogleCalendarConfigured(): boolean {
  return Boolean(SA_EMAIL && SA_KEY && CALENDAR_ID);
}

export interface CalEvent {
  id: string;
  summary: string;
  /** YYYY-MM-DD for all-day events, else null. */
  allDayDate: string | null;
  startIso: string | null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Cache the access token across calls within its lifetime.
let tokenCache: { token: string; expiresAt: number } | null = null;

// Last auth/list error surfaced for the diagnostic endpoint. The normal
// helpers degrade to "no calendar" silently (so a booking never fails on a
// calendar hiccup); this lets /api/bookings/calendar-check show WHY.
let lastGcalError: string | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!isGoogleCalendarConfigured()) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: SA_EMAIL,
        scope: SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
        // Impersonate this Workspace user via domain-wide delegation so the
        // SA can write to their calendar even when external sharing is locked.
        ...(IMPERSONATE_USER ? { sub: IMPERSONATE_USER } : {}),
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = base64url(
      crypto.createSign("RSA-SHA256").update(signingInput).sign(SA_KEY!),
    );
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[gcal] token exchange failed:", res.status, text);
      lastGcalError = `Token exchange ${res.status}: ${text.slice(0, 300)}`;
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      lastGcalError = "Token exchange returned no access_token";
      return null;
    }
    lastGcalError = null;
    tokenCache = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[gcal] token error:", msg);
    lastGcalError = `Token error: ${msg}`;
    return null;
  }
}

/** Events in [timeMin, timeMax). Used to detect all-day holiday/closed blocks. */
export async function listCalendarEvents(
  timeMinIso: string,
  timeMaxIso: string,
): Promise<CalEvent[]> {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID!)}/events`,
    );
    url.searchParams.set("timeMin", timeMinIso);
    url.searchParams.set("timeMax", timeMaxIso);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "2500");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[gcal] list failed:", res.status, text);
      lastGcalError = `Events list ${res.status}: ${text.slice(0, 300)}`;
      return [];
    }
    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        start?: { date?: string; dateTime?: string };
      }>;
    };
    lastGcalError = null;
    return (json.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary ?? "",
      allDayDate: e.start?.date ?? null,
      startIso: e.start?.dateTime ?? null,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[gcal] list error:", msg);
    lastGcalError = `Events list error: ${msg}`;
    return [];
  }
}

/** Owner-facing connection check. Forces a fresh token + a wide events probe
 *  and reports exactly what failed (auth / DWD / calendar id) or how many
 *  events were found — so a blank Date Align calendar can be diagnosed
 *  without grepping server logs. Never returns secrets. */
export async function diagnoseGoogleCalendar(): Promise<{
  configured: boolean;
  hasEmail: boolean;
  hasPrivateKey: boolean;
  hasCalendarId: boolean;
  calendarId: string | null;
  impersonateUser: string | null;
  /** Safe shape checks on the PEM (no key material) so a mangled key is
   *  obvious: a valid key starts with -----BEGIN, ends with PRIVATE KEY-----,
   *  is ~28 lines and ~1700 chars. lineCount 1 = newlines lost; tiny length =
   *  truncated; startsWithBegin false = stray quote / junk prefix. */
  keyStartsWithBegin: boolean;
  keyEndsWithEnd: boolean;
  keyLineCount: number;
  keyLength: number;
  tokenOk: boolean;
  eventCount: number;
  error: string | null;
}> {
  lastGcalError = null;
  tokenCache = null; // bypass any cached token so we see live errors
  const configured = isGoogleCalendarConfigured();
  let tokenOk = false;
  let eventCount = 0;
  if (configured) {
    const token = await getAccessToken();
    tokenOk = Boolean(token);
    if (token) {
      const now = Date.now();
      const timeMin = new Date(now - 7 * 86_400_000).toISOString();
      const timeMax = new Date(now + 120 * 86_400_000).toISOString();
      eventCount = (await listCalendarEvents(timeMin, timeMax)).length;
    }
  }
  return {
    configured,
    hasEmail: Boolean(SA_EMAIL),
    hasPrivateKey: Boolean(SA_KEY),
    hasCalendarId: Boolean(CALENDAR_ID),
    calendarId: CALENDAR_ID ?? null,
    impersonateUser: IMPERSONATE_USER ?? null,
    keyStartsWithBegin: SA_KEY.startsWith("-----BEGIN"),
    keyEndsWithEnd: SA_KEY.trimEnd().endsWith("PRIVATE KEY-----"),
    keyLineCount: SA_KEY ? SA_KEY.replace(/\n+$/, "").split("\n").length : 0,
    keyLength: SA_KEY.length,
    tokenOk,
    eventCount,
    error: lastGcalError,
  };
}

/** Create an all-day event for a date-only booking. Returns the event id. */
export async function createCalendarEvent(opts: {
  date: string; // YYYY-MM-DD
  summary: string;
  description?: string;
  /** Google Calendar event colour id "1"–"11" (Lavender…Tomato). */
  colorId?: string;
}): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    // All-day event: end.date is exclusive, so it's the day after.
    const end = new Date(`${opts.date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const endDate = end.toISOString().slice(0, 10);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID!)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: opts.summary,
          description: opts.description ?? "",
          start: { date: opts.date },
          end: { date: endDate },
          ...(opts.colorId ? { colorId: opts.colorId } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      console.warn("[gcal] create failed:", res.status, await res.text());
      return null;
    }
    const json = (await res.json()) as { id?: string };
    return json.id ?? null;
  } catch (e) {
    console.warn("[gcal] create error:", e instanceof Error ? e.message : e);
    return null;
  }
}
