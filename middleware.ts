import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { updateSession } from "@/lib/supabase/middleware";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  EMBED_ORIGINS_KEY,
  DEFAULT_EMBED_ORIGINS,
  normalizeOrigin,
  buildFrameAncestors,
} from "@/lib/embed-csp";

// Runtime CSP frame-ancestors for /embed — built from the owner-managed CRM
// origin list in app_settings (Settings → Embed) so adding a domain needs no
// rebuild. Cached 60s; on any read failure we fall back to the env seed and
// NEVER open framing up wider than that.
let cspCache: { value: string; ts: number } | null = null;
const CSP_TTL_MS = 60_000;

async function embedFrameAncestors(): Promise<string> {
  if (cspCache && Date.now() - cspCache.ts < CSP_TTL_MS) return cspCache.value;
  let origins = DEFAULT_EMBED_ORIGINS;
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (key && url) {
      const admin = createClient(url, key, { auth: { persistSession: false } });
      const { data } = await admin
        .from("app_settings")
        .select("value")
        .eq("key", EMBED_ORIGINS_KEY)
        .maybeSingle();
      const raw = (data?.value as string | undefined) ?? null;
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          origins = arr
            .map((o) => normalizeOrigin(String(o)))
            .filter((o): o is string => o !== null);
        }
      }
    }
  } catch {
    /* fall back to env seed — keep framing restricted on a transient error */
  }
  const value = buildFrameAncestors(origins);
  cspCache = { value, ts: Date.now() };
  return value;
}

// Tight limit ONLY for credential surfaces — blocks brute force without
// throttling the dashboard's heavy polling.
const LOGIN_PATHS = ["/api/login", "/api/signup", "/login", "/signup"];
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 60_000;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return req.ip ?? "unknown";
}

// Mutating API calls must not originate from a cross-site browser context.
// This replaces the CSRF barrier SameSite=Lax used to provide before the
// auth cookies went SameSite=None for the CRM iframe embed (see
// lib/supabase/cookie-options.ts). Browsers always send Sec-Fetch-Site;
// server-to-server callers (LSQ/Interakt webhooks, curl) omit it and pass.
// The CRM iframe itself is same-site (sibling subdomain), so it passes too.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    path.startsWith("/api/") &&
    !SAFE_METHODS.has(request.method) &&
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return new NextResponse("Cross-site request blocked.", { status: 403 });
  }
  if (LOGIN_PATHS.some((p) => path === p || path.startsWith(p + "/"))) {
    const ip = clientIp(request);
    const r = checkRateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!r.allowed) {
      return new NextResponse("Too many login attempts. Try again in a minute.", {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(r.resetMs / 1000)),
          "Content-Type": "text/plain",
        },
      });
    }
  }

  const res = await updateSession(request);
  // /embed is framed by the CRM — set the runtime frame-ancestors CSP from the
  // owner-managed origin list (next.config no longer sets a static one).
  if (path === "/embed" || path.startsWith("/embed/")) {
    res.headers.set("Content-Security-Policy", await embedFrameAncestors());
  }
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
