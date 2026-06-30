"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Lock, Mail, ShieldAlert } from "lucide-react";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { signInAction } from "./actions";

export function LoginForm({ next, initialError }: { next: string; initialError?: string | null }) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [isPending, startTransition] = useTransition();
  const [showPassword, setShowPassword] = useState(false);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await signInAction(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="space-y-4">
      {/* Google OAuth — primary path for QHT staff */}
      <div className="auth-slide-up" style={{ animationDelay: "0.05s" }}>
        <GoogleSignInButton next={next} disabled={isPending} />
      </div>

      {/* Or divider */}
      <div
        className="auth-fade-in flex items-center gap-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground"
        style={{ animationDelay: "0.15s" }}
      >
        <span className="h-px flex-1 bg-border" />
        <span>or continue with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={onSubmit} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        {/* Honeypot — visually hidden but submitted with the form. Real
            users can't see/tab into it; spambots that blindly fill every
            input will trip it and get rejected server-side. */}
        <div aria-hidden className="hidden">
          <label htmlFor="website">Website</label>
          <input
            id="website"
            type="text"
            name="website"
            autoComplete="off"
            tabIndex={-1}
            defaultValue=""
          />
        </div>

      {/* Email */}
      <div className="auth-slide-up space-y-1.5" style={{ animationDelay: "0.1s" }}>
        <label
          htmlFor="email"
          className="text-xs font-semibold tracking-wide text-foreground"
        >
          Email address
        </label>
        <div className="group relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@americanhairline.com"
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-all placeholder:text-muted-foreground/70 focus:border-primary focus:ring-4 focus:ring-primary/10"
          />
        </div>
      </div>

      {/* Password */}
      <div className="auth-slide-up space-y-1.5" style={{ animationDelay: "0.2s" }}>
        <div className="flex items-center justify-between">
          <label
            htmlFor="password"
            className="text-xs font-semibold tracking-wide text-foreground"
          >
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-[11px] font-medium text-muted-foreground hover:text-primary"
          >
            Forgot password?
          </Link>
        </div>
        <div className="group relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder="Enter your password"
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-10 text-sm outline-none transition-all placeholder:text-muted-foreground/70 focus:border-primary focus:ring-4 focus:ring-primary/10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            tabIndex={-1}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Error */}
      {error ? (
        <div
          role="alert"
          className="auth-slide-up flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="auth-slide-up auth-shimmer-button group relative inline-flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-lg text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition-all hover:shadow-lg hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ animationDelay: "0.3s" }}
      >
        <span className="relative z-10">{isPending ? "Signing in…" : "Sign in"}</span>
        {!isPending ? (
          <ArrowRight className="relative z-10 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        ) : null}
      </button>

        {/* Divider with secure badge */}
        <div
          className="auth-fade-in flex items-center gap-2 pt-1 text-[11px] text-muted-foreground"
          style={{ animationDelay: "0.45s" }}
        >
          <span className="h-px flex-1 bg-border" />
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" />
            End-to-end encrypted
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </form>
    </div>
  );
}
