import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { canViewPanel } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { CampaignsView } from "@/components/CampaignsView";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    // Admin floor (sending bulk costs money + reputation) PLUS the
    // per-member allowed_panels override the owner set in Permissions.
    if (!isAtLeast(member.role, "admin")) redirect("/dashboard");
    if (!(await canViewPanel("campaigns"))) redirect("/dashboard");
  }
  return <CampaignsView />;
}
