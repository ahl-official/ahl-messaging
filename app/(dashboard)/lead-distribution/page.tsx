import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { canViewPanel } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { LeadDistributionView } from "@/components/LeadDistributionView";

export const dynamic = "force-dynamic";

export default async function LeadDistributionPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (!(await canViewPanel("lead_distribution"))) redirect("/dashboard");
  }
  return <LeadDistributionView />;
}
