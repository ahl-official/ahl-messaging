"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  BookOpenText,
  Building2,
  ChevronLeft,
  ChevronRight,
  Eraser,
  IndianRupee,
  KeyRound,
  Megaphone,
  Radio,
  Phone,
  PhoneCall,
  Sparkles,
  SlidersHorizontal,
  Tag,
  Target,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { isAtLeast, type Role } from "@/lib/team-types";
import type { SettingsTabKey } from "@/lib/permission-types";
import { cn } from "@/lib/utils";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Permission key — must be in `allowed_settings_tabs` (or that list NULL = all). */
  key: SettingsTabKey;
  /** Min role required to see this tab. */
  minRole?: Role;
}

const TABS: Tab[] = [
  // Single combined "Team" tab. The page renders BOTH the individual
  // members list and the team-groups list as sub-tabs, so the settings
  // bar stays uncluttered. /settings/teams still works as a deep link
  // (the page checks ?view=groups), just not surfaced in the nav.
  { href: "/settings/team",         key: "team",         label: "Team",         icon: Users },
  { href: "/settings/labels",       key: "labels",       label: "Labels",       icon: Tag,       minRole: "admin" },
  { href: "/settings/permissions",  key: "permissions",  label: "Permissions",  icon: KeyRound, minRole: "superadmin" },
  { href: "/settings/numbers",      key: "numbers",      label: "Numbers",      icon: Phone },
  { href: "/settings/capabilities", key: "capabilities", label: "Capabilities", icon: SlidersHorizontal, minRole: "admin" },
  { href: "/settings/targets",      key: "targets",      label: "Targets",      icon: Target,            minRole: "owner" },
  { href: "/settings/notice",       key: "notice",       label: "Notice",       icon: Megaphone },
  { href: "/settings/portfolios",   key: "portfolios",   label: "Portfolios",   icon: Building2, minRole: "owner" },
  { href: "/settings/api",          key: "api",          label: "API",          icon: BookOpenText, minRole: "admin" },
  { href: "/settings/data",         key: "data",         label: "Data",         icon: Eraser,    minRole: "owner" },
  { href: "/settings/ai",           key: "ai",           label: "AI",           icon: Sparkles,  minRole: "owner" },
  { href: "/settings/embed",        key: "embed",        label: "Embed",        icon: AppWindow, minRole: "owner" },
  { href: "/settings/payments",     key: "payments",     label: "Payments",     icon: IndianRupee, minRole: "owner" },
  { href: "/settings/calling",      key: "calling",      label: "Calling",      icon: PhoneCall, minRole: "superadmin" },
  { href: "/settings/interakt",     key: "interakt",     label: "Interakt",     icon: Webhook,   minRole: "owner" },
  { href: "/settings/ads",          key: "ads",          label: "Ads / Marketing", icon: Radio, minRole: "owner" },
];

// Rendered inside the dark emerald hero — active tab is a frosted white
// pill, inactive tabs are translucent. The strip horizontally scrolls on
// small viewports.
export function SettingsTabs({
  role,
  allowedSettingsTabs,
}: {
  role: Role | null;
  allowedSettingsTabs?: SettingsTabKey[] | null;
}) {
  const pathname = usePathname();
  const allowedSet =
    allowedSettingsTabs === null || allowedSettingsTabs === undefined
      ? null
      : new Set(allowedSettingsTabs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateArrows, { passive: true });
    window.addEventListener("resize", updateArrows);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      window.removeEventListener("resize", updateArrows);
    };
  }, [updateArrows]);

  // Re-evaluate when the visible tab set changes (role/permission gating).
  useEffect(updateArrows, [updateArrows, role, allowedSettingsTabs, pathname]);

  function scrollBy(dir: -1 | 1) {
    scrollRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });
  }

  return (
    <div className="relative -mx-6 mb-4 px-6">
      {/* Left arrow + fade — only while there's content scrolled off-left.
          White pill on the dark hero, matching the inbox stage strip. The
          fade blends the off-edge tabs into the hero's emerald gradient. */}
      {canLeft ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-6 z-[5] w-12 bg-gradient-to-r from-[#1a4ab8] to-transparent" />
          <button
            type="button"
            aria-label="Scroll tabs left"
            onClick={() => scrollBy(-1)}
            className="absolute left-6 top-1/2 z-10 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition hover:scale-110 hover:bg-primary/10 hover:text-primary"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </>
      ) : null}
      {canRight ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-6 z-[5] w-12 bg-gradient-to-l from-teal-900 to-transparent" />
          <button
            type="button"
            aria-label="Scroll tabs right"
            onClick={() => scrollBy(1)}
            className="absolute right-6 top-1/2 z-10 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition hover:scale-110 hover:bg-primary/10 hover:text-primary"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      ) : null}

      <nav
        ref={scrollRef}
        className="no-scrollbar flex items-center gap-2 overflow-x-auto scroll-smooth"
      >
        {TABS.map((t) => {
          if (t.minRole && !isAtLeast(role, t.minRole)) return null;
          if (allowedSet && !allowedSet.has(t.key)) return null;
          const active = pathname === t.href || pathname.startsWith(t.href + "/");
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "group inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition",
                active
                  ? "bg-white text-primary shadow-lg shadow-primary/25 ring-1 ring-white/50"
                  : "bg-white/10 text-white/90 ring-1 ring-white/20 hover:bg-white/20 hover:text-white hover:ring-white/30",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition",
                  active ? "text-primary" : "text-white/80 group-hover:text-white",
                )}
              />
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
