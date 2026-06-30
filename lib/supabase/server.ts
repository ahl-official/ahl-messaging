// Server-side Supabase clients.
//   createServerClient()      -> per-request, reads/writes auth cookies (RLS-aware)
//   createServiceRoleClient() -> bypasses RLS, server-only (webhook writes)
// Phase 2 will wire cookie handling fully; this stub keeps imports compiling.

import { cookies } from "next/headers";
import {
  createServerClient as createSupabaseServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { withEmbedCookieOptions } from "@/lib/supabase/cookie-options";

export async function createServerClient() {
  const cookieStore = await cookies();
  return createSupabaseServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }: { name: string; value: string; options: CookieOptions }) =>
              // SameSite=None + COOKIE_DOMAIN so the session also works inside
              // the CRM iframe (/embed/inbox) — see lib/supabase/cookie-options.
              cookieStore.set(name, value, withEmbedCookieOptions(options)),
            );
          } catch {
            // Server Components cannot mutate cookies; middleware handles refresh.
          }
        },
      },
    },
  );
}

export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
