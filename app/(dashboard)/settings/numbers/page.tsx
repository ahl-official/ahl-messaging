import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { NumbersView } from "@/components/NumbersView";

export const dynamic = "force-dynamic";

export default async function SettingsNumbersPage() {
  let canEdit = true;
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!(await canViewSettingsTab("numbers"))) redirect("/settings");
    canEdit = member.role === "owner" || member.role === "superadmin";
  }
  return <NumbersView canEdit={canEdit} />;
}
