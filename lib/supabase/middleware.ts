import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_SESSION_MS,
  SESSION_STARTED_COOKIE,
  sessionStartedCookieOptions,
} from "@/lib/auth";
import { withEmbedCookieOptions } from "@/lib/supabase/cookie-options";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

// Role lookup cache — middleware runs on every request, so we don't
// want a Supabase round-trip each time just to decide if the user is
// an owner (and therefore exempt from the 4h session cap). 60s TTL is
// loose enough that a freshly-demoted user gets kicked within a
// minute of the role change.
const roleCache = new Map<string, { role: string; ts: number }>();
const ROLE_CACHE_TTL_MS = 60_000;

async function getRoleForUser(userId: string): Promise<string | null> {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.ts < ROLE_CACHE_TTL_MS) return hit.role;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceKey,
      { auth: { persistSession: false } },
    );
    const { data } = await admin
      .from("team_members")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    const role = (data?.role as string | undefined) ?? null;
    if (role) roleCache.set(userId, { role, ts: Date.now() });
    return role;
  } catch {
    return null;
  }
}

// Refreshes the Supabase auth cookie on every request and gates /dashboard.
export async function updateSession(request: NextRequest) {
  // Demo mode: skip Supabase entirely and bounce auth routes → /dashboard.
  if (DEMO_MODE) {
    if (
      request.nextUrl.pathname === "/login" ||
      request.nextUrl.pathname === "/signup" ||
      request.nextUrl.pathname === "/forgot-password" ||
      request.nextUrl.pathname === "/reset-password"
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            // SameSite=None + COOKIE_DOMAIN so the session also works inside
            // the CRM iframe (/embed/inbox) — see lib/supabase/cookie-options.
            response.cookies.set(name, value, withEmbedCookieOptions(options)),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // Routes that should bounce logged-in users *back* to /dashboard.
  // /reset-password is excluded — Supabase creates a recovery session
  // when the user lands here from the email link, so a redirect would
  // throw them out of the recovery flow.
  const isAuthRoute = pathname === "/login" || pathname === "/signup";
  // Public surfaces — anything else under the dashboard route group
  // (home / contacts / calls / templates / campaigns / automation /
  // tasks / reports / settings / integrations / profile / widget / etc.)
  // requires an active session. Earlier `pathname.startsWith("/dashboard")`
  // only protected the inbox itself, so after signOut the other tabs
  // kept rendering until the operator refreshed.
  const isPublicPath =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname.startsWith("/auth/") ||
    // Client-facing booking page — opened from a shared link, no login.
    pathname.startsWith("/book/") ||
    // CRM iframe embed — must NOT redirect to /login (the login page can't
    // be framed); the page renders its own minimal sign-in screen instead.
    pathname.startsWith("/embed") ||
    pathname.startsWith("/api/");
  const isProtected = !isPublicPath;

  // Hard 12-hour session cap. Owners are exempt — they manage the whole
  // workspace and the operator team explicitly asked to keep them
  // signed in indefinitely. Everyone else gets kicked when the stamp
  // cookie says their session is older than MAX_SESSION_MS.
  if (user) {
    const role = await getRoleForUser(user.id);
    const exempt = role === "owner";
    const startedRaw = request.cookies.get(SESSION_STARTED_COOKIE)?.value;
    const startedAt = startedRaw ? Number(startedRaw) : NaN;
    if (exempt) {
      // Drop any stale cookie so a former-non-owner who got promoted
      // doesn't carry a stale expiry stamp around.
      if (Number.isFinite(startedAt)) {
        response.cookies.delete(SESSION_STARTED_COOKIE);
      }
    } else {
      if (Number.isFinite(startedAt) && Date.now() - startedAt > MAX_SESSION_MS) {
        await supabase.auth.signOut();
        const url = request.nextUrl.clone();
        if (pathname.startsWith("/embed")) {
          // Inside the CRM iframe — bounce back to the embed URL itself; with
          // the session revoked it renders its minimal sign-in screen (the
          // /login page refuses to be framed).
          const expired = NextResponse.redirect(url);
          expired.cookies.delete(SESSION_STARTED_COOKIE);
          return expired;
        }
        url.pathname = "/login";
        url.searchParams.set("error", "session_expired");
        if (isProtected) url.searchParams.set("next", pathname);
        const expired = NextResponse.redirect(url);
        expired.cookies.delete(SESSION_STARTED_COOKIE);
        return expired;
      }
      if (!Number.isFinite(startedAt)) {
        response.cookies.set(
          SESSION_STARTED_COOKIE,
          String(Date.now()),
          sessionStartedCookieOptions,
        );
      }
    }
  }

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }

  return response;
}
