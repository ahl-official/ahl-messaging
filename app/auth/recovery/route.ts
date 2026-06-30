import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
// GET /auth/recovery?code=...&next=/reset-password
//
// Password-reset emails (Supabase PKCE flow) come back as ?code=… — the
// recovery page is a client component and can't reliably exchange that
// code (supabase-js's auto-detect races the page's own handler). So the
// email link points HERE: a Route Handler exchanges the code for a
// session server-side (cookies persist properly), then forwards to the
// page where the user picks a new password.
//
// Kept separate from /auth/callback — that one is OAuth login and runs
// the corporate-domain + team-member gating. Recovery just needs the
// session established; gating happens when the user hits /dashboard.
// =====================================================================
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const nextParam = url.searchParams.get("next") ?? "/reset-password";
  // Only allow same-origin relative paths — reject "//host" / "/\\host" which
  // resolve to an external origin (open redirect).
  const next =
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//") &&
    !nextParam.startsWith("/\\")
      ? nextParam
      : "/reset-password";
  const base = publicBase(url);

  if (!code) {
    return NextResponse.redirect(
      new URL("/forgot-password?error=missing_code", base),
    );
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL("/forgot-password?error=link_expired", base),
    );
  }

  return NextResponse.redirect(new URL(next, base));
}

// Behind a reverse proxy that drops the original Host header,
// request.nextUrl resolves to the loopback upstream. Prefer the
// configured public URL so the redirect lands on the real domain.
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
