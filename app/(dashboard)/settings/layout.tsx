import { redirect } from "next/navigation";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { DEMO_MODE } from "@/lib/demo";
import { SettingsHero } from "@/components/settings/SettingsHero";
import type { Role } from "@/lib/team-types";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import type { SettingsTabKey } from "@/lib/permission-types";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  let role: Role | null = null;
  let allowedSettingsTabs: SettingsTabKey[] | null = null;
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    const isAdmin = isAtLeast(member.role, "admin");
    const isLead = member.is_team_lead === true;
    if (!isAdmin && !isLead) redirect("/dashboard");
    role = member.role;
    if (isAdmin) {
      const perms = await getEffectivePermissionsFor(member);
      allowedSettingsTabs = perms.allowed_settings_tabs;
    } else {
      // A Team Lead only gets the Targets tab here (to set their team's KRA);
      // every other settings sub-page still guards itself to admin/owner.
      allowedSettingsTabs = ["targets"];
    }
  } else {
    role = "owner";
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsHero role={role} allowedSettingsTabs={allowedSettingsTabs} />
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
