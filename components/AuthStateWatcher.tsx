"use client";

// Mounted once in the dashboard layout. Listens to Supabase auth state
// changes and force-navigates to /login the moment a SIGNED_OUT event
// fires — whether triggered locally (this tab's logout button), from
// another tab on the same device, or remotely (admin-revoked session).
//
// Without this, an operator who logs out from one tab keeps seeing the
// previous tab's stale UI until they refresh — the server-side
// middleware only kicks in on the NEXT request, and a tab sitting idle
// never makes one.

import { useEffect } from "react";
import { createBrowserClient } from "@/lib/supabase/client";

export function AuthStateWatcher() {
  useEffect(() => {
    const supabase = createBrowserClient();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        // Hard navigation — `router.push("/login")` would soft-replace
        // and could keep client state hanging around. We want the full
        // app to tear down, including any open realtime channels.
        window.location.assign("/login");
      }
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, []);
  return null;
}
