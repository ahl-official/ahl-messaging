import { redirect } from "next/navigation";
import { canViewSettingsTab } from "@/lib/permissions";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { DEMO_MODE } from "@/lib/demo";
import { LabelsView } from "@/components/settings/LabelsView";

export const dynamic = "force-dynamic";

export default async function LabelsSettingsPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!isAtLeast(member.role, "admin")) redirect("/dashboard");
    if (!(await canViewSettingsTab("labels"))) redirect("/settings");
  }
  return <LabelsView />;
}
