import Link from "next/link";
import { Check, Clock3, Inbox, Lock, Sparkles } from "lucide-react";
import { Logo } from "@/components/Logo";
import { ALLOWED_EMAIL_DOMAINS } from "@/lib/auth";
import { LoginForm } from "./login-form";

const OAUTH_ERROR_LABELS: Record<string, string> = {
  domain_not_allowed: `Sign-in is restricted to ${ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(" or ")} accounts. Please use your work Google account.`,
  deactivated: "Your account has been deactivated. Please ask an admin to reactivate it.",
  pending_approval:
    "Your account is awaiting owner approval. You'll be able to sign in once an owner approves it.",
  missing_code: "Google sign-in didn't return an authorization code. Please try again.",
  auth_failed: "We couldn't complete your sign-in. Please try again.",
  access_denied: "You declined the Google sign-in.",
  session_expired: "Your session expired after 4 hours. Please sign in again.",
};

function readableOAuthError(raw?: string): string | null {
  if (!raw) return null;
  return OAUTH_ERROR_LABELS[raw] ?? decodeURIComponent(raw);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = next && next.startsWith("/") ? next : "/dashboard";
  // pending_approval gets its own prominent banner above the form, so
  // suppress the inline error to avoid double-rendering the message.
  const isPending = error === "pending_approval";
  const initialError = isPending ? null : readableOAuthError(error);

  return (
    <main className="login-page relative min-h-screen w-full overflow-hidden bg-background">
      {/* Two-column layout. On mobile, only the right panel shows. */}
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        {/* ──────────── LEFT: animated brand showcase ──────────── */}
        <aside className="auth-gradient-bg relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
          {/* Dot grid overlay — separate layer so it doesn't overwrite the gradient */}
          <div aria-hidden className="auth-grid-pattern pointer-events-none absolute inset-0" />
          {/* Animated blobs */}
          <div
            aria-hidden
            className="auth-blob pointer-events-none absolute -top-32 -left-32 h-[420px] w-[420px] rounded-full bg-[#0693e3]/30"
          />
          <div
            aria-hidden
            className="auth-blob pointer-events-none absolute bottom-[-180px] right-[-120px] h-[520px] w-[520px] rounded-full bg-[rgb(46,109,226)]/20"
            style={{ animationDelay: "-6s" }}
          />
          <div
            aria-hidden
            className="auth-blob pointer-events-none absolute top-1/3 right-1/4 h-[260px] w-[260px] rounded-full bg-[#0693e3]/15"
            style={{ animationDelay: "-12s" }}
          />

          {/* Brand bar */}
          <header className="auth-slide-in-left relative z-10 flex items-center gap-3 text-white">
            <div className="relative">
              <Logo variant="dark" size={36} />
              <span className="auth-pulse-ring pointer-events-none absolute inset-0 rounded-xl" aria-hidden />
            </div>
            <div className="leading-tight">
              <div className="text-base font-semibold">AHL Messaging</div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/70">
                Hair care, reimagined
              </div>
            </div>
          </header>

          {/* Centerpiece: floating chat preview */}
          <div className="auth-fade-in relative z-10 flex flex-1 items-center justify-center py-10">
            <ChatShowcase />
          </div>

          {/* Footer pillars — internal tool, no marketing claims */}
          <footer
            className="auth-slide-up relative z-10 grid grid-cols-3 gap-3 text-white"
            style={{ animationDelay: "0.3s" }}
          >
            <Pillar
              icon={Inbox}
              title="Unified inbox"
              subtitle="Every patient chat, one place"
            />
            <Pillar
              icon={Sparkles}
              title="Smart templates"
              subtitle="Approved replies in one click"
            />
            <Pillar
              icon={Lock}
              title="In-house tool"
              subtitle="Built for American Hairline"
            />
          </footer>
        </aside>

        {/* ──────────── RIGHT: form panel ──────────── */}
        <section className="relative flex items-center justify-center px-5 py-10 sm:px-8">
          {/* Soft ambient glow behind the card */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/3 -z-0 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-[#0693e3]/10 blur-3xl opacity-70"
          />

          <div className="auth-slide-up relative z-10 w-full max-w-md">
            {/* Mobile-only brand */}
            <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
              <Logo variant="light" size={40} />
              <span className="text-base font-semibold tracking-tight">AHL Messaging</span>
            </div>

            <div className="rounded-2xl border bg-card/90 p-7 shadow-[0_30px_60px_-30px_rgba(46,109,226,0.18)] backdrop-blur-sm sm:p-9">
              {isPending ? (
                <div className="mb-6 overflow-hidden rounded-xl border-2 border-amber-300 bg-amber-50/60 shadow-sm">
                  <div className="flex items-start gap-3 p-4">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 ring-2 ring-amber-200">
                      <Clock3 className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#0693e3]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[rgb(46,109,226)] ring-1 ring-[#0693e3]/30">
                          <Check className="h-2.5 w-2.5" />
                          Verified
                        </span>
                        <span className="text-sm font-semibold text-amber-900">
                          Awaiting owner approval
                        </span>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-amber-900/90">
                        Your Google sign-in worked — we&apos;ve verified your account.
                        An owner now needs to approve your access before you can
                        enter the inbox.
                      </p>
                      <p className="mt-2 text-[12px] text-amber-800/85">
                        You&apos;ll be able to sign in normally once approved.
                        Reach out to your workspace owner to nudge them, or
                        check back in a few minutes.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="mb-7 space-y-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#0693e3]/30 bg-[#0693e3]/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[rgb(46,109,226)]">
                  <Sparkles className="h-3 w-3" />
                  Welcome back
                </span>
                <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                  Sign in to your inbox
                </h1>
                <p className="text-sm text-muted-foreground">
                  Continue where you left off — your conversations are waiting.
                </p>
              </div>

              <LoginForm next={nextPath} initialError={initialError} />

              <p
                className="auth-fade-in mt-7 text-center text-sm text-muted-foreground"
                style={{ animationDelay: "0.4s" }}
              >
                New here?{" "}
                <Link
                  href="/signup"
                  className="font-semibold text-primary underline-offset-4 hover:underline"
                >
                  Create an account
                </Link>
              </p>
            </div>

            <p
              className="auth-fade-in mt-6 text-center text-[11px] tracking-wide text-muted-foreground"
              style={{ animationDelay: "0.5s" }}
            >
              Compassion · Consistency · Innovation · Excellence
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function Pillar({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm ring-1 ring-white/10">
      <div className="flex items-center gap-2 text-white">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="text-[13px] font-semibold leading-tight">{title}</span>
      </div>
      <div className="mt-1 text-[11px] leading-snug text-white/70">{subtitle}</div>
    </div>
  );
}

function ChatShowcase() {
  return (
    <div className="relative w-full max-w-sm">
      {/* Subtle glow behind the stack */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 rounded-[32px] bg-gradient-to-br from-white/15 to-transparent blur-2xl"
      />

      <div className="relative space-y-3 text-white">
        {/* Inbound — first message in the conversation */}
        <ChatBubble
          side="in"
          name="Aman AI"
          time="10:42"
          text="Hi! Is the consultation free? And how long does it take?"
          delay="0.10s"
        />

        {/* Outbound reply */}
        <ChatBubble
          side="out"
          time="10:43"
          text="Yes, the first consultation is complimentary — usually 30–45 minutes. Want me to book one?"
          delay="0.30s"
          status="read"
        />

        {/* Inbound — second patient (no float; the entry slide alone
            reads as a fresh arrival without the bubble jiggling forever) */}
        <ChatBubble
          side="in"
          name="Rahul"
          time="10:44"
          text="Please reschedule my appointment to Saturday 4pm."
          delay="0.50s"
        />

        {/* Outbound confirmation */}
        <ChatBubble
          side="out"
          time="10:44"
          text="Done ✓ — Saturday, 4:00 PM is confirmed. See you then!"
          delay="0.70s"
          status="delivered"
        />

        {/* Typing indicator — slides up last and keeps looping its dot bounce */}
        <div
          className="auth-slide-up flex items-center gap-2"
          style={{ animationDelay: "0.95s" }}
        >
          <div className="rounded-2xl rounded-bl-sm bg-white/95 px-4 py-2.5 shadow-lg">
            <div className="auth-typing flex items-center gap-1">
              <span className="block h-1.5 w-1.5 rounded-full bg-[#0693e3]" />
              <span className="block h-1.5 w-1.5 rounded-full bg-[#0693e3]" />
              <span className="block h-1.5 w-1.5 rounded-full bg-[#0693e3]" />
            </div>
          </div>
          <span className="text-[11px] text-white/70">Vinitt is typing....</span>
        </div>
      </div>

      {/* Floating "live" badge — slides in from the right, then drifts
          gently in place. The drift kicks in only after the slide is
          done so the entry animation reads cleanly. */}
      <div
        className="auth-slide-in-right auth-drift absolute -right-3 -top-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[rgb(46,109,226)] shadow-xl"
        style={{ animationDelay: "0.7s" }}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#0693e3] opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[rgb(46,109,226)]" />
        </span>
        Live inbox
      </div>
    </div>
  );
}

function ChatBubble({
  side,
  name,
  time,
  text,
  delay,
  status,
}: {
  side: "in" | "out";
  name?: string;
  time: string;
  text: string;
  delay: string;
  status?: "delivered" | "read";
}) {
  const isOut = side === "out";
  return (
    <div
      className={`auth-slide-up-floating flex ${isOut ? "justify-end" : "justify-start"}`}
      // CSS var feeds the slide-up's animation-delay (the float keeps its
      // own 1.6s delay defined in the class — see globals.css).
      style={{ "--entry-delay": delay } as React.CSSProperties}
    >
      <div
        className={[
          "max-w-[82%] rounded-2xl px-3.5 py-2 text-[13px] leading-snug shadow-lg",
          isOut
            ? "rounded-br-sm bg-[rgb(46,109,226)] text-white"
            : "rounded-bl-sm bg-white text-gray-900",
        ].join(" ")}
      >
        {!isOut && name ? (
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(46,109,226)]">
            {name}
          </div>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{text}</p>
        <div
          className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${
            isOut ? "text-white/80" : "text-gray-400"
          }`}
        >
          <span>{time}</span>
          {isOut ? (
            <span className="inline-flex">
              <Check className="-mr-1.5 h-3 w-3" />
              <Check className={`h-3 w-3 ${status === "read" ? "text-sky-200" : ""}`} />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
