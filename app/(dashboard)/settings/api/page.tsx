import { redirect } from "next/navigation";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { ApiDocsView } from "@/components/settings/ApiDocsView";

export const dynamic = "force-dynamic";

export default async function SettingsApiPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!isAtLeast(member.role, "admin")) redirect("/dashboard");
    if (!(await canViewSettingsTab("api"))) redirect("/settings");
  }
  return <ApiDocsView />;
}
