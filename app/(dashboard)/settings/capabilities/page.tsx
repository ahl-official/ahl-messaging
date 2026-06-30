import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { CapabilitiesView } from "@/components/CapabilitiesView";

export const dynamic = "force-dynamic";

export default async function SettingsCapabilitiesPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!isAtLeast(member.role, "admin")) redirect("/settings/team");
    if (!(await canViewSettingsTab("capabilities"))) redirect("/settings");
  }
  return <CapabilitiesView />;
}
