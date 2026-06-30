import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast, type Role } from "@/lib/team-types";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { settingsTabAllowed, type SettingsTabKey } from "@/lib/permission-types";
import { DEMO_MODE } from "@/lib/demo";

export const dynamic = "force-dynamic";

// Settings landing — `/settings` itself has no UI. It forwards to the
// FIRST tab the member is actually allowed to see. Previously the nav
// hard-linked to `/settings/team`, so a member granted (say) only the
// "Numbers" tab got bounced straight back out — they could never reach
// Settings without also being given the Team tab. This index removes
// that coupling: each tab stands on its own.
const TAB_ORDER: { key: SettingsTabKey; href: string; minRole?: Role }[] = [
  { key: "team", href: "/settings/team" },
  { key: "labels", href: "/settings/labels", minRole: "admin" },
  { key: "permissions", href: "/settings/permissions", minRole: "superadmin" },
  { key: "numbers", href: "/settings/numbers" },
  { key: "capabilities", href: "/settings/capabilities", minRole: "admin" },
  { key: "targets", href: "/settings/targets", minRole: "owner" },
  { key: "notice", href: "/settings/notice" },
  { key: "portfolios", href: "/settings/portfolios", minRole: "owner" },
  { key: "api", href: "/settings/api", minRole: "admin" },
  { key: "data", href: "/settings/data", minRole: "owner" },
  { key: "ai", href: "/settings/ai", minRole: "owner" },
];

export default async function SettingsIndexPage() {
  if (DEMO_MODE) redirect("/settings/team");

  const member = await getCurrentMember();
  if (!member) redirect("/login");
  if (!isAtLeast(member.role, "admin")) redirect("/dashboard");

  const perms = await getEffectivePermissionsFor(member);
  for (const t of TAB_ORDER) {
    if (t.minRole && !isAtLeast(member.role, t.minRole)) continue;
    if (!settingsTabAllowed(perms, t.key)) continue;
    redirect(t.href);
  }
  // Member is an admin but has every settings tab switched off.
  redirect("/dashboard");
}
