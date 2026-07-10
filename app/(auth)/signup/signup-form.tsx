"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, MailCheck } from "lucide-react";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { resendConfirmationAction, signUpAction } from "../login/actions";

// Default cooldown after a successful resend so the user doesn't spam
// the resend button before Supabase's rate-limit window expires (60s).
const DEFAULT_RESEND_COOLDOWN_SEC = 60;

export function SignUpForm() {
  const [error, setError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [resendErr, setResendErr] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [isPending, startTransition] = useTransition();

  // Tick the cooldown every second. Auto-clears the rate-limit error
  // when it reaches 0 so the resend button re-enables itself.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          setResendErr(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  function onSubmit(formData: FormData) {
    setError(null);
    setResendInfo(null);
    setResendErr(null);
    setCooldown(0);
    const email = String(formData.get("email") ?? "").trim();
    startTransition(async () => {
      const result = await signUpAction(formData);
      if (result && "error" in result) {
        setError(result.error);
        return;
      }
      if (result && "ok" in result && result.needsEmailConfirmation) {
        setSubmittedEmail(email);
        // Start the cooldown immediately — the verification email was
        // just sent during signup, so a resend within 60s would 429.
        setCooldown(DEFAULT_RESEND_COOLDOWN_SEC);
      }
    });
  }

  async function resend() {
    if (!submittedEmail || cooldown > 0) return;
    setResending(true);
    setResendInfo(null);
    setResendErr(null);
    try {
      const fd = new FormData();
      fd.set("email", submittedEmail);
      const r = await resendConfirmationAction(fd);
      if (r && "error" in r) {
        setResendErr(r.error);
        // Supabase rate-limit message looks like
        // "you can only request this after 41 seconds". Parse the
        // number so the UI can tick it down.
        const m = r.error.match(/after\s+(\d+)\s+seconds?/i);
        if (m) setCooldown(parseInt(m[1], 10));
      } else {
        setResendInfo("Email resent. Check your inbox again.");
        setCooldown(DEFAULT_RESEND_COOLDOWN_SEC);
      }
    } finally {
      setResending(false);
    }
  }

  // Post-submit success screen — premium layout. The wrapping page
  // header ("Create your account") still shows above, but the body
  // here visually re-centers the user on what to do next.
  if (submittedEmail) {
    return (
      <div className="space-y-5 text-center">
        {/* Animated icon with pulse rings */}
        <div className="relative mx-auto h-20 w-20">
          <span className="auth-pulse-ring absolute inset-0 rounded-full bg-[#6098FF]/30" />
          <span
            className="auth-pulse-ring absolute inset-0 rounded-full bg-[#6098FF]/20"
            style={{ animationDelay: "1.2s" }}
          />
          <div className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#6098FF] to-[#6098FF] text-white shadow-lg shadow-primary/20 ring-4 ring-primary/10">
            <MailCheck className="h-9 w-9" />
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Check your inbox
          </h2>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to
          </p>
          <p className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm font-semibold text-foreground ring-1 ring-inset ring-border">
            {submittedEmail}
          </p>
        </div>

        {/* 3-step indicator */}
        <ol className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-medium">
          <li className="rounded-lg border border-primary/25 bg-primary/10 px-2 py-2 text-primary">
            <span className="block text-[9px] font-bold uppercase tracking-wide text-primary">Step 1</span>
            <span className="block">Email sent ✓</span>
          </li>
          <li className="rounded-lg border bg-card px-2 py-2 text-foreground/80">
            <span className="block text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Step 2</span>
            <span className="block">Click the link</span>
          </li>
          <li className="rounded-lg border bg-card px-2 py-2 text-foreground/80">
            <span className="block text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Step 3</span>
            <span className="block">Sign in</span>
          </li>
        </ol>

        {resendInfo ? (
          <div className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/25">
            <CheckCircle2 className="h-3 w-3" />
            {resendInfo}
          </div>
        ) : null}
        {resendErr && cooldown === 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {resendErr}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Didn&apos;t get it? Check spam or
          {cooldown > 0 ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
              resend in {cooldown}s
            </span>
          ) : (
            <button
              type="button"
              onClick={resend}
              disabled={resending}
              className="ml-1 font-semibold text-primary hover:underline disabled:opacity-60"
            >
              {resending ? "sending…" : "resend the email"}
            </button>
          )}
          .
        </p>

        <Link
          href="/login"
          className="inline-flex w-full items-center justify-center rounded-md border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-secondary"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <GoogleSignInButton next="/dashboard" disabled={isPending} />
      <div className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>or sign up with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="full_name" className="text-sm font-medium text-foreground">
          Full name <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          autoComplete="name"
          className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="Dr. Jane Doe"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="you@americanhairline.com"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium text-foreground">
          Password <span className="text-muted-foreground font-normal">(8+ characters)</span>
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
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
        {isPending ? "Creating account…" : "Create account"}
      </button>
    </form>
    </div>
  );
}
