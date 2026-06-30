import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { PermissionsView } from "@/components/PermissionsView";

export const dynamic = "force-dynamic";

export default async function SettingsPermissionsPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!isAtLeast(member.role, "superadmin")) redirect("/settings/team");
    if (!(await canViewSettingsTab("permissions"))) redirect("/settings");
  }
  return <PermissionsView />;
}
