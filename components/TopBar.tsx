"use client";

// TopBar carries the workspace wordmark on the left + notice + right
// cluster. The bell now lives inside the UserMenu dropdown, so the
// right cluster is just the score badge + avatar menu.
import { Menu } from "lucide-react";
import { NoticeBanner } from "@/components/NoticeBanner";
import { UserMenu } from "@/components/UserMenu";
import { ScoreBadge } from "@/components/ScoreBadge";
import { TasksChip } from "@/components/TasksChip";
import type { Role } from "@/lib/team-types";

interface Props {
  email: string;
  fullName: string | null;
  role: Role | null;
  isDemo: boolean;
}

export function TopBar({ email, fullName, role, isDemo }: Props) {
  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b bg-card px-3 shrink-0 sm:gap-4 sm:px-4">
      {/* Left — hamburger (mobile) + workspace wordmark + region tag */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => window.dispatchEvent(new CustomEvent("qht-open-mobile-nav"))}
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-semibold tracking-tight">
          AHL Messaging
        </span>
        {/* Region tag — names the CRM region this inbox is wired to. */}
        <span className="hidden md:inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary ring-1 ring-inset ring-primary/20">
          Mumbai, Khar West
        </span>
      </div>

      {/* Centre — workspace notice banner (admin-set, hidden when empty).
          Hidden on phone so the top bar doesn't overflow. flex+justify-center
          so the banner pill sits in the middle of the available column
          instead of hugging the left edge next to the wordmark. */}
      <div className="hidden min-w-0 flex-1 items-center justify-center md:flex">
        <NoticeBanner />
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-2 shrink-0">
        {!isDemo ? <TasksChip /> : null}
        {!isDemo ? <ScoreBadge /> : null}
        <UserMenu email={email} fullName={fullName} role={role} isDemo={isDemo} />
      </div>
    </header>
  );
}
