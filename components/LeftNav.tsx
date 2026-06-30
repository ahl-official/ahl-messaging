"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Cable,
  CheckCircle2,
  ChevronLeft,
  Database,
  Grid3x3,
  Home,
  Inbox,
  Megaphone,
  MessageSquareText,
  Users,
  LayoutTemplate,
  PhoneCall,
  Zap,
  Settings,
  Target,
  Split,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { isAtLeast, type Role } from "@/lib/team-types";
import type { PanelKey } from "@/lib/permission-types";
import { useMyOpenTasks } from "@/lib/use-my-tasks";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  matchPrefix?: string;
  /** If set, the item is hidden unless the current user has at least this role. */
  minRole?: Role;
  /** Panel key — if the user's allowed_panels list excludes this, hide it. */
  panel: PanelKey;
  /** Only shown to Team Leads (regardless of panels/role). Used for the
   *  team report + team-KRA shortcuts a TL gets without broader access. */
  leadOnly?: boolean;
}

const items: NavItem[] = [
  { href: "/home",            label: "Home",         icon: Home,           enabled: true, panel: "home" },
  { href: "/dashboard",       label: "Inbox",        icon: Inbox,          enabled: true, panel: "inbox" },
  { href: "/bird-eye",        label: "Bird's Eye",   icon: Grid3x3,        enabled: true, panel: "inbox" },
  { href: "/contacts",        label: "Contacts",     icon: Users,          enabled: true, panel: "contacts" },
  { href: "/calls",           label: "Call history", icon: PhoneCall,      enabled: true, panel: "calls" },
  { href: "/templates",       label: "Templates",    icon: LayoutTemplate, enabled: true, panel: "templates" },
  { href: "/quick-replies",   label: "Quick Replies", icon: MessageSquareText, enabled: true, matchPrefix: "/quick-replies", panel: "quick_replies" },
  { href: "/campaigns",       label: "Campaigns",    icon: Megaphone,      enabled: true, panel: "campaigns" },
  { href: "/automation",      label: "Automation",   icon: Zap,            enabled: true, panel: "automation" },
  { href: "/lead-distribution", label: "Lead Distribution", icon: Split,    enabled: true, panel: "lead_distribution" },
  { href: "/integrations/lsq",label: "LeadSquared",  icon: Database,       enabled: true, matchPrefix: "/integrations/lsq", panel: "lsq" },
  { href: "/integrations/telephony", label: "Telephony", icon: Cable,     enabled: true, matchPrefix: "/integrations/telephony", panel: "telephony" },
  { href: "/tasks",           label: "Tasks",        icon: CheckCircle2,   enabled: true, panel: "tasks" },
  { href: "/reports",         label: "Reports",      icon: BarChart3,      enabled: true, panel: "reports" },
  { href: "/settings/targets",label: "Team KRA",     icon: Target,         enabled: true, matchPrefix: "/settings/targets", panel: "reports", leadOnly: true },
];

const footerItems: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings, enabled: true, minRole: "admin", matchPrefix: "/settings", panel: "settings" },
];

function NavButton({
  item,
  active,
  expanded,
  badgeCount,
  badgeTone,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  /** Optional notification badge (e.g. open Tasks count). Renders a
   *  pulsing dot on the icon + a small numeric pill when expanded. */
  badgeCount?: number;
  badgeTone?: "rose" | "emerald";
}) {
  const Icon = item.icon;
  const showBadge = !!badgeCount && badgeCount > 0;
  const tone = badgeTone ?? "rose";
  // Active row gets the emerald gradient + drop shadow; idle rows pick up
  // a subtle hover (faint emerald wash) so the bar feels responsive even
  // before the user clicks anything.
  const inner = (
    <span
      className={cn(
        "group relative flex items-center transition-all duration-150",
        expanded
          ? "h-11 w-full gap-3 rounded-xl px-3"
          : "h-11 w-11 justify-center rounded-xl",
        item.enabled
          ? active
            ? "bg-gradient-to-br from-emerald-600 to-emerald-700 text-white shadow-md shadow-emerald-700/30 ring-1 ring-inset ring-emerald-500/40"
            : "text-foreground/70 hover:bg-emerald-50 hover:text-emerald-900"
          : "text-muted-foreground/40 cursor-not-allowed",
      )}
    >
      {/* Active accent rail on the left — only visible when expanded so
          the collapsed icon-only rail stays clean. */}
      {expanded && active && item.enabled ? (
        <span
          aria-hidden
          className="absolute -left-2 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.6)]"
        />
      ) : null}
      <span className="relative inline-flex">
        <Icon
          className={cn(
            "shrink-0 transition",
            expanded ? "h-[18px] w-[18px]" : "h-[20px] w-[20px]",
            active && item.enabled
              ? "text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]"
              : "text-foreground/60 group-hover:text-emerald-700",
            !item.enabled && "text-muted-foreground/40",
          )}
        />
        {showBadge ? (
          <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
            <span
              className={cn(
                "absolute inset-0 inline-flex h-full w-full animate-ping rounded-full opacity-80",
                tone === "rose" ? "bg-rose-500" : "bg-emerald-500",
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full ring-2",
                tone === "rose" ? "bg-rose-600" : "bg-emerald-500",
                active ? "ring-emerald-700" : "ring-card",
              )}
            />
          </span>
        ) : null}
      </span>
      {expanded ? (
        <span className="truncate text-[13px] font-semibold tracking-tight">
          {item.label}
          {!item.enabled ? (
            <span className="ml-1 text-[10px] font-medium opacity-70">· soon</span>
          ) : null}
          {showBadge ? (
            <span
              className={cn(
                "ml-1.5 inline-flex items-center rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                tone === "rose"
                  ? "bg-rose-600 text-white"
                  : "bg-emerald-600 text-white",
              )}
            >
              {badgeCount}
            </span>
          ) : null}
        </span>
      ) : null}
      {/* No collapsed-state tooltip — hovering the rail expands it and shows
          the label inline, so a separate tooltip just flashed mid-transition. */}
    </span>
  );

  if (!item.enabled) return inner;
  return (
    <Link href={item.href} aria-label={item.label} className={expanded ? "block w-full" : ""}>
      {inner}
    </Link>
  );
}

export function LeftNav({
  role,
  allowedPanels,
  isTeamLead,
}: {
  role?: Role | null;
  /** null = unrestricted (show all), else only show items whose panel is in this list. */
  allowedPanels?: PanelKey[] | null;
  /** Team Leads get the Reports + Team-KRA shortcuts even when their panel
   *  set / role wouldn't otherwise show them. */
  isTeamLead?: boolean;
}) {
  const pathname = usePathname();

  // Open task count drives the red pulsing dot on the Tasks nav item.
  // Same shared poller as TopBar's TasksChip — only one fetch cadence
  // even when both are mounted.
  const { open: myTasksOpen, overdue: myTasksOverdue } = useMyOpenTasks();

  // Desktop: the rail stays collapsed and expands only while the mouse is
  // over it (as an overlay, so the content underneath never reflows).
  const [hovered, setHovered] = useState(false);
  // Mobile drawer — TopBar's hamburger dispatches a window event.
  // The drawer always renders in expanded form (labels visible).
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const open = () => setMobileOpen(true);
    const close = () => setMobileOpen(false);
    window.addEventListener("qht-open-mobile-nav", open);
    window.addEventListener("qht-close-mobile-nav", close);
    return () => {
      window.removeEventListener("qht-open-mobile-nav", open);
      window.removeEventListener("qht-close-mobile-nav", close);
    };
  }, []);
  // Auto-close drawer on route change so the user lands on the new
  // page without the menu still covering it.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function isActive(item: NavItem) {
    if (!item.enabled) return false;
    const prefix = item.matchPrefix ?? item.href;
    const matches =
      pathname === item.href ||
      pathname === prefix ||
      pathname.startsWith(prefix + "/");
    if (!matches) return false;
    // A more specific nav item wins. e.g. /integrations/lsq matches both
    // the LSQ item (prefix "/integrations/lsq") and the parent Integrations
    // item (prefix "/integrations") — only the LSQ item should highlight.
    const moreSpecific = items.some((other) => {
      if (other === item || !other.enabled) return false;
      const otherPrefix = other.matchPrefix ?? other.href;
      if (otherPrefix.length <= prefix.length) return false;
      return (
        pathname === other.href ||
        pathname === otherPrefix ||
        pathname.startsWith(otherPrefix + "/")
      );
    });
    return !moreSpecific;
  }

  function visible(item: NavItem) {
    // Team-Lead-only shortcuts (team report + team KRA) show ONLY for leads.
    if (item.leadOnly) return isTeamLead === true;
    if (item.minRole && !isAtLeast(role, item.minRole)) return false;
    if (allowedPanels && !allowedPanels.includes(item.panel)) {
      // A Team Lead always gets Reports even if their panel set excludes it
      // (the report itself is scoped to their team server-side).
      if (isTeamLead && item.panel === "reports") return true;
      return false;
    }
    return true;
  }

  // On the mobile drawer we always render in expanded form so labels
  // are readable; on desktop the rail expands only while hovered.
  const showExpanded = mobileOpen || hovered;
  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      ) : null}
    {/* Desktop: a fixed-width rail holds the layout space; the <nav> inside is
        absolutely positioned so expanding on hover overlays the content
        instead of pushing it. Mobile: this wrapper is inert (the nav is a
        fixed slide-in drawer). */}
    <div className="md:relative md:h-full md:w-[68px] md:shrink-0">
    <nav
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Hard, fully-opaque background via inline style so the hover overlay is
      // never see-through (the old translucent gradient bled the content
      // through once the rail became an overlay).
      style={{ backgroundColor: "hsl(var(--card))" }}
      className={cn(
        "flex h-full flex-col justify-between border-r bg-card py-4 transition-[width,transform] duration-200",
        // Mobile: fixed overlay drawer that slides in from the left.
        // Hidden off-screen by default; the TopBar hamburger toggles it.
        // pointer-events-none when closed so the off-screen panel can't
        // intercept touches on the inbox underneath.
        "fixed inset-y-0 left-0 z-50 w-64 px-3",
        mobileOpen
          ? "translate-x-0 pointer-events-auto"
          : "-translate-x-full pointer-events-none",
        // Desktop: absolute overlay rail — collapsed by default, widens over
        // the content on hover (with a shadow) without reflowing it.
        "md:absolute md:left-0 md:top-0 md:translate-x-0 md:pointer-events-auto",
        showExpanded
          ? "md:z-50 md:w-60 md:px-3 md:shadow-xl"
          : "md:z-30 md:w-[68px] md:items-center md:px-2",
      )}
    >
      {/* Top */}
      <div className={cn("flex flex-col gap-4", showExpanded ? "items-stretch" : "items-center")}>
        {/* Brand. Expanded uses a flat, confident monogram tile + workmark
            (no nested duplicate-logo pill); collapsed reuses the same tile. */}
        <div
          className={cn(
            "flex items-center",
            showExpanded ? "justify-between" : "justify-center",
          )}
        >
          <Link
            href="/dashboard"
            aria-label="AHL Messaging home"
            className={cn(
              "group inline-flex items-center transition",
              showExpanded ? "gap-2.5" : "",
            )}
          >
            <span
              className={cn(
                "inline-flex items-center justify-center rounded-xl bg-white shadow-md shadow-emerald-700/15 ring-1 ring-emerald-100 transition group-hover:shadow-lg group-hover:shadow-emerald-700/25 group-hover:ring-emerald-200",
                showExpanded ? "h-9 w-9" : "h-10 w-10",
              )}
            >
              <Logo variant="bare" size={showExpanded ? 22 : 26} />
            </span>
            {showExpanded ? (
              <span className="flex flex-col leading-none">
                <span className="text-[14px] font-bold tracking-tight text-foreground">
                  AHL Inbox
                </span>
                <span className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-700">
                  Workspace
                </span>
              </span>
            ) : null}
          </Link>
          {mobileOpen ? (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-emerald-50 hover:text-emerald-700"
              aria-label="Close menu"
              title="Close menu"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* Section label */}
        {showExpanded ? (
          <div className="mt-1 px-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">
            Navigation
          </div>
        ) : null}

        {/* Items */}
        <div className={cn("flex flex-col gap-1", showExpanded ? "" : "items-center gap-1.5")}>
          {items.filter(visible).map((item) => (
            <NavButton
              key={item.href}
              item={item}
              active={isActive(item)}
              expanded={showExpanded}
              badgeCount={item.panel === "tasks" ? myTasksOpen : undefined}
              badgeTone={item.panel === "tasks" ? (myTasksOverdue > 0 ? "rose" : "emerald") : undefined}
            />
          ))}
        </div>
      </div>

      {/* Footer — settings + collapse-toggle (when collapsed) */}
      <div
        className={cn(
          "flex flex-col gap-1.5 pt-3",
          showExpanded ? "border-t border-border/60" : "items-center border-t border-border/60",
        )}
      >
        {footerItems.filter(visible).map((item) => (
          <NavButton
            key={item.href}
            item={item}
            active={isActive(item)}
            expanded={showExpanded}
          />
        ))}
      </div>
    </nav>
    </div>
    </>
  );
}
