"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Mail } from "lucide-react";
import { forgotPasswordAction } from "../login/actions";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    const email = String(formData.get("email") ?? "").trim();
    startTransition(async () => {
      const result = await forgotPasswordAction(formData);
      if (result && "error" in result) {
        setError(result.error);
        return;
      }
      setSentTo(email);
    });
  }

  // Success state — show a clean "check inbox" confirmation
  if (sentTo) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-semibold text-foreground">Reset link sent</p>
          <p className="text-sm text-muted-foreground">
            We sent a password reset link to{" "}
            <span className="font-medium text-foreground">{sentTo}</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            Check spam / promotions if you don&apos;t see it in a minute.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSentTo(null)}
          className="text-xs font-medium text-primary hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="w-full h-10 rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="you@americanhairline.com"
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
        {isPending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
