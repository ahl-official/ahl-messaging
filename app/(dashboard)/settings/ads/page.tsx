import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { AdsMarketingView } from "@/components/AdsMarketingView";

export const dynamic = "force-dynamic";

export default async function AdsPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (member.role !== "owner") redirect("/dashboard");
    if (!(await canViewSettingsTab("ads"))) redirect("/settings");
  }
  return <AdsMarketingView />;
}
