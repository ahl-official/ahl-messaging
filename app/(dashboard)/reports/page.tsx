import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { canViewPanel } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { ReportsTabs } from "@/components/ReportsTabs";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  // A Team Lead (non-admin) only gets the team-scoped Agent-productivity tab —
  // the workspace-wide Analytics tab stays admin-only.
  let teamLeadOnly = false;
  // Owner + Team Leads can set KRA targets straight from the report table.
  let canSetKra = false;
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    // Reports surface per-agent productivity numbers — admin floor so
    // teammates can't inspect colleagues' send counts unless explicitly
    // granted via allowed_panels. Team Leads are let in too, but the API
    // scopes them to their own team's members only.
    const isAdmin = isAtLeast(member.role, "admin");
    const isLead = member.is_team_lead === true;
    if (!isAdmin && !isLead) redirect("/dashboard");
    if (isAdmin && !(await canViewPanel("reports"))) redirect("/dashboard");
    teamLeadOnly = !isAdmin && isLead;
    canSetKra = member.role === "owner" || isLead;
  }
  return <ReportsTabs teamLeadOnly={teamLeadOnly} canSetKra={canSetKra} />;
}
