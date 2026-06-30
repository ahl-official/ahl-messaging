import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  SESSION_STARTED_COOKIE,
  isAllowedEmail,
  sessionStartedCookieOptions,
} from "@/lib/auth";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/user-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
// GET /auth/callback?code=...&next=/dashboard
//
// Exchanges the OAuth code from Supabase for a session, then enforces our
// corporate-domain policy. Non-allowed users are signed out before being
// bounced back to /login with a readable error.
// =====================================================================
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const nextParam = url.searchParams.get("next") ?? "/dashboard";
  // Only allow same-origin relative paths. Reject protocol-relative ("//host")
  // and backslash variants which resolve to an external origin (open redirect).
  const next =
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//") &&
    !nextParam.startsWith("/\\")
      ? nextParam
      : "/dashboard";

  // Provider returned an error directly (user denied, misconfigured app, etc.)
  if (oauthError) {
    return NextResponse.redirect(buildLoginUrl(url, oauthError));
  }
  if (!code) {
    return NextResponse.redirect(buildLoginUrl(url, "missing_code"));
  }

  const supabase = await createServerClient();

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) {
    return NextResponse.redirect(buildLoginUrl(url, error?.message ?? "auth_failed"));
  }

  if (!isAllowedEmail(data.user.email)) {
    // Tear down the session we just created — this user shouldn't be in.
    await supabase.auth.signOut();
    return NextResponse.redirect(buildLoginUrl(url, "domain_not_allowed"));
  }

  // Distinguish three blocked states so the user-facing message can be
  // accurate:
  //   - pending_approval: self-signup waiting for owner review (new in 0020)
  //   - is_active=false: previously approved, then deactivated by an admin
  //   - row missing: very rare race with the DB trigger
  const { data: member } = await supabase
    .from("team_members")
    .select("is_active, pending_approval")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (member && member.pending_approval === true) {
    await supabase.auth.signOut();
    return NextResponse.redirect(buildLoginUrl(url, "pending_approval"));
  }
  if (member && member.is_active === false) {
    await supabase.auth.signOut();
    return NextResponse.redirect(buildLoginUrl(url, "deactivated"));
  }

  const response = NextResponse.redirect(new URL(next, publicBase(url)));
  response.cookies.set(SESSION_STARTED_COOKIE, String(Date.now()), sessionStartedCookieOptions);

  // App-level session row + cookie. Mirrors what signInAction does
  // for the password flow. Failure here is non-fatal — login still
  // succeeds; the session just won't appear in the Profile sessions
  // list until next login.
  try {
    const admin = createServiceRoleClient();
    const { data: memberRow } = await admin
      .from("team_members")
      .select("id")
      .eq("user_id", data.user.id)
      .maybeSingle();
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      request.headers.get("x-real-ip") ??
      null;
    const sessionId = await createSession({
      userId: data.user.id,
      memberId: memberRow?.id ?? null,
      ip,
      userAgent: request.headers.get("user-agent"),
    });
    if (sessionId) {
      response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
  } catch {
    /* don't block sign-in on session-ledger failure */
  }

  return response;
}

// When the app sits behind a reverse proxy that doesn't forward the
// original Host header, request.nextUrl resolves to the internal
// upstream (127.0.0.1:3000 / localhost:3000) and any redirect built
// from it points the browser at the wrong host. Prefer the explicit
// public URL when configured so OAuth post-auth lands on the canonical
// domain instead of the loopback address.
function publicBase(url: URL): URL {
  const envUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (envUrl) {
    try {
      return new URL(envUrl);
    } catch {
      /* fall through */
    }
  }
  return url;
}

function buildLoginUrl(base: URL, error: string): URL {
  const u = new URL("/login", publicBase(base));
  u.searchParams.set("error", error);
  return u;
}
