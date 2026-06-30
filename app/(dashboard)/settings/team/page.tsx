import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { TeamSettingsTabs } from "@/components/settings/TeamSettingsTabs";

export const dynamic = "force-dynamic";

export default async function SettingsTeamPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!(await canViewSettingsTab("team"))) redirect("/settings");
  }
  // Wraps both Members + Groups views behind sub-tabs so we don't
  // duplicate the top settings tab.
  return <TeamSettingsTabs />;
}
