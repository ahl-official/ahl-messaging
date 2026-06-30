"use client";

import { useEffect, useState, useTransition } from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import { resetPasswordAction } from "../login/actions";

export function ResetPasswordForm({ isInvite = false }: { isInvite?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Supabase invite + recovery links arrive with the token in the URL
  // *fragment* (#access_token=…&refresh_token=…). The server can't see
  // the fragment, so on mount we parse it client-side and hand it to
  // supabase-js, which writes the session cookies our server actions
  // need. Once the session is set we strip the hash so a back-forward
  // navigation doesn't re-try the token.
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapErr, setBootstrapErr] = useState<string | null>(null);

  useEffect(() => {
    // Recovery (forgot-password) links now arrive with the session
    // already established server-side by /auth/recovery — the URL here
    // is a clean /reset-password, so this effect just falls through and
    // shows the form.
    //
    // Invite links still carry the token in the URL *fragment*
    // (#access_token=…&refresh_token=…) — admin-generated, no PKCE
    // verifier — so those are bootstrapped client-side here.
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (!hash || !hash.includes("access_token=")) {
      setBootstrapping(false);
      return;
    }
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (!accessToken || !refreshToken) {
      setBootstrapErr("Invalid or expired link. Request a new email.");
      setBootstrapping(false);
      return;
    }
    const supabase = createBrowserClient();
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error) {
          setBootstrapErr(
            error.message || "Couldn't open the session. Request a new email.",
          );
        } else {
          // Strip the hash so the token doesn't sit in browser history.
          window.history.replaceState(
            null,
            "",
            window.location.pathname + window.location.search,
          );
        }
      })
      .finally(() => setBootstrapping(false));
  }, []);

  function onSubmit(formData: FormData) {
    setError(null);
    const pw = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (pw !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    startTransition(async () => {
      const result = await resetPasswordAction(formData);
      if (result && "error" in result) setError(result.error);
      // Success → server action redirects to /dashboard; nothing to do here.
    });
  }

  if (bootstrapping) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening your session…
      </div>
    );
  }

  if (bootstrapErr) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {bootstrapErr}
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium text-foreground">
          {isInvite ? "Choose a password" : "New password"}
        </label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full h-10 rounded-md border border-input bg-background pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="At least 8 characters"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="confirm" className="text-sm font-medium text-foreground">
          {isInvite ? "Confirm password" : "Confirm new password"}
        </label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="confirm"
            name="confirm"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full h-10 rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="Repeat the new password"
          />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-600 disabled:opacity-60 transition"
      >
        {isPending
          ? "Saving…"
          : isInvite
            ? "Activate my account"
            : "Save new password"}
      </button>
    </form>
  );
}
