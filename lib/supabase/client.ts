// Browser-side Supabase client (uses anon key + cookie session).
// Phase 2 will add the real implementation. Stub keeps imports resolvable.

import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";

// Mirror of the server-side COOKIE_DOMAIN (lib/supabase/cookie-options.ts) for
// client-side token refreshes. Must be NEXT_PUBLIC_* to reach the browser —
// set BOTH to the same value (e.g. ".hairmedindia.com") or a client refresh
// writes a host-only cookie next to the domain-wide one (split-brain session).
const COOKIE_DOMAIN =
  process.env.NEXT_PUBLIC_COOKIE_DOMAIN?.trim() || undefined;

export function createBrowserClient() {
  return createSupabaseBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    COOKIE_DOMAIN
      ? {
          cookieOptions: {
            domain: COOKIE_DOMAIN,
            sameSite: "none",
            secure: true,
          },
        }
      : undefined,
  );
}
