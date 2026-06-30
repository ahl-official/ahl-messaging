"use server";

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  SESSION_STARTED_COOKIE,
  domainNotAllowedMessage,
  isAllowedEmail,
  sessionStartedCookieOptions,
} from "@/lib/auth";
import {
  createSession,
  SESSION_COOKIE_NAME,
} from "@/lib/user-sessions";

const LOCKOUT_WINDOW_MIN = 15;
const LOCKOUT_THRESHOLD = 5;

async function clientIpFromHeaders(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// Returns null if the email+ip combo is allowed to attempt, otherwise
// a user-facing error message. Counts failures across the window for
// EITHER the email OR the IP — whichever trips first wins.
async function checkLoginLockout(email: string, ip: string): Promise<string | null> {
  try {
    const svc = createServiceRoleClient();
    const cutoff = new Date(Date.now() - LOCKOUT_WINDOW_MIN * 60_000).toISOString();
    const [byEmail, byIp] = await Promise.all([
      svc
        .from("auth_attempts")
        .select("id", { count: "exact", head: true })
        .eq("email", email)
        .eq("success", false)
        .gte("created_at", cutoff),
      svc
        .from("auth_attempts")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .eq("success", false)
        .gte("created_at", cutoff),
    ]);
    const emailFails = byEmail.count ?? 0;
    const ipFails = byIp.count ?? 0;
    if (emailFails >= LOCKOUT_THRESHOLD || ipFails >= LOCKOUT_THRESHOLD) {
      return `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MIN} minutes.`;
    }
    return null;
  } catch {
    // Don't block real users if the lockout table is unreachable — fail open.
    return null;
  }
}

async function recordLoginAttempt(
  email: string,
  ip: string,
  success: boolean,
): Promise<void> {
  try {
    const svc = createServiceRoleClient();
    await svc.from("auth_attempts").insert({ email, ip, success });
  } catch {
    /* logging is best-effort */
  }
}

async function recordAppSession(userId: string): Promise<void> {
  // Application-level session ledger — distinct from Supabase's own
  // refresh-tokens. Used by the Profile + Team views to show "where
  // this user is logged in" and to power the logout-from-all-devices
  // action. Geo is filled in asynchronously by createSession.
  const h = await headers();
  const ip = await clientIpFromHeaders();
  const userAgent = h.get("user-agent");
  const admin = createServiceRoleClient();
  const { data: member } = await admin
    .from("team_members")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  const sessionId = await createSession({
    userId,
    memberId: member?.id ?? null,
    ip,
    userAgent,
  });
  if (sessionId) {
    const store = await cookies();
    store.set(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days — Supabase refresh-token equivalent
    });
  }
}

async function stampSessionStart(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_STARTED_COOKIE, String(Date.now()), sessionStartedCookieOptions);
}

function originFromHeaders(h: Headers): string {
  // Local dev fast-path: when running on localhost, the Origin header
  // ALWAYS comes through as http://localhost:3000 (or whatever port).
  // Prefer it so dev OAuth keeps the loopback URL and doesn't bounce
  // to the production domain configured in NEXT_PUBLIC_APP_URL.
  const origin = h.get("origin");
  const host = h.get("host");
  const isLocalRequest =
    (origin?.includes("localhost") || origin?.includes("127.0.0.1") ||
     host?.startsWith("localhost") || host?.startsWith("127.0.0.1")) ?? false;
  if (isLocalRequest) {
    if (origin) return origin;
    if (host) return `http://${host}`;
  }

  // Production: env var is the source of truth — set
  // NEXT_PUBLIC_APP_URL to your real public URL (e.g.
  // https://wa.hairmedindia.com) so OAuth redirects always come back
  // to the canonical domain even if the request arrived via a CDN or
  // alt-host. Falls back to the request's own headers if the env var
  // isn't set, then to localhost as a last resort.
  const envUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (envUrl) return envUrl;

  if (origin) return origin;
  if (host) {
    const proto =
      h.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }

  return "http://localhost:3000";
}

export async function signInAction(formData: FormData): Promise<{ error: string } | void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  // Honeypot — a hidden input no real user can see/fill. Anything in
  // here means a bot auto-filled the form. Pretend it was a normal
  // credential failure so the bot can't tell the trap fired.
  const honeypot = String(formData.get("website") ?? "");
  const ip = await clientIpFromHeaders();
  if (honeypot.trim() !== "") {
    await recordLoginAttempt(email || "honeypot", ip, false);
    return { error: "Invalid email or password." };
  }

  if (!email || !password) return { error: "Email and password are required." };
  if (!isAllowedEmail(email)) return { error: domainNotAllowedMessage() };

  const locked = await checkLoginLockout(email, ip);
  if (locked) return { error: locked };

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    await recordLoginAttempt(email, ip, false);
    return { error: error.message };
  }
  await recordLoginAttempt(email, ip, true);

  // Block login for pending / deactivated members. Sign them out
  // immediately so a stale session cookie isn't left behind. Redirect
  // to /login with the same error code Google sign-in uses so both
  // paths render the same prominent banner instead of an inline string.
  if (data?.user) {
    const { data: member } = await supabase
      .from("team_members")
      .select("is_active, pending_approval")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (member?.pending_approval === true) {
      await supabase.auth.signOut();
      redirect("/login?error=pending_approval");
    }
    if (member && member.is_active === false) {
      await supabase.auth.signOut();
      redirect("/login?error=deactivated");
    }
  }

  await stampSessionStart();
  if (data?.user) await recordAppSession(data.user.id);
  redirect(next.startsWith("/") ? next : "/dashboard");
}

export async function signUpAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true; needsEmailConfirmation: boolean } | void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("full_name") ?? "").trim();

  if (!email || !password) return { error: "Email and password are required." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (!isAllowedEmail(email)) return { error: domainNotAllowedMessage() };

  const supabase = await createServerClient();

  // emailRedirectTo points back to /login after confirmation (if required)
  const h = await headers();
  const origin = originFromHeaders(h);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: fullName ? { full_name: fullName } : undefined,
      emailRedirectTo: `${origin}/login`,
    },
  });

  if (error) return { error: error.message };

  // If Supabase project requires email confirmation, no session is returned.
  if (data.session) {
    await stampSessionStart();
    redirect("/dashboard");
  }
  return { ok: true, needsEmailConfirmation: !data.session };
}

export async function signInWithGoogleAction(formData: FormData): Promise<{ error: string } | void> {
  const next = String(formData.get("next") ?? "/dashboard");
  const supabase = await createServerClient();
  const h = await headers();
  const origin = originFromHeaders(h);

  const callback = new URL(`${origin}/auth/callback`);
  callback.searchParams.set("next", next.startsWith("/") ? next : "/dashboard");

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callback.toString(),
      // No `hd` (hosted-domain) hint: it restricts Google's chooser to a
      // single workspace domain, which would block the other allowed
      // domain(s). The real enforcement is in /auth/callback, which verifies
      // the returned email's domain against ALLOWED_EMAIL_DOMAINS.
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  if (error) return { error: error.message };
  if (!data.url) return { error: "Could not start Google sign-in." };

  redirect(data.url);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  const store = await cookies();
  // Mark the application-level session revoked so the "active
  // sessions" list updates immediately.
  const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
  if (sessionId) {
    const { revokeSession } = await import("@/lib/user-sessions");
    await revokeSession(sessionId, "user_signed_out");
  }
  store.delete(SESSION_STARTED_COOKIE);
  store.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}

// ---------------------------------------------------------------------
// Password reset — request the email
// ---------------------------------------------------------------------
export async function forgotPasswordAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Email is required." };
  if (!isAllowedEmail(email)) return { error: domainNotAllowedMessage() };

  const supabase = await createServerClient();
  const h = await headers();
  const origin = originFromHeaders(h);

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // The recovery email is a PKCE link (?code=…). Land it on the
    // /auth/recovery Route Handler — it exchanges the code for a
    // session server-side, then forwards to /reset-password where the
    // user picks a new password. Doing the exchange on the page itself
    // races supabase-js's auto-detect and fails intermittently.
    redirectTo: `${origin}/auth/recovery?next=/reset-password`,
  });
  if (error) return { error: error.message };

  // Always return ok so we don't reveal whether an email is registered.
  return { ok: true };
}

// ---------------------------------------------------------------------
// Password reset — set the new password (caller must have a recovery
// session, which Supabase creates from the email link).
// ---------------------------------------------------------------------
export async function resetPasswordAction(
  formData: FormData,
): Promise<{ error: string } | void> {
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Recovery link expired or invalid. Request a new reset email." };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };

  await stampSessionStart();
  redirect("/dashboard");
}

// ---------------------------------------------------------------------
// Resend the signup confirmation email
// ---------------------------------------------------------------------
export async function resendConfirmationAction(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Email is required." };

  const supabase = await createServerClient();
  const h = await headers();
  const origin = originFromHeaders(h);

  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${origin}/login` },
  });
  if (error) return { error: error.message };
  return { ok: true };
}
