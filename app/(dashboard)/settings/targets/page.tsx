import { redirect } from "next/navigation";
import { canViewSettingsTab } from "@/lib/permissions";
import { getCurrentMember } from "@/lib/team";
import { DEMO_MODE } from "@/lib/demo";
import { TargetsView } from "@/components/settings/TargetsView";

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  let isOwner = true;
  let leadTeamId: string | null = null;
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    // Owner edits everyone's KRA; a Team Lead edits only their own team's
    // members (enforced by the API + scoped in the view).
    isOwner = member.role === "owner";
    const isLead = member.is_team_lead === true;
    if (!isOwner && !isLead) redirect("/dashboard");
    if (isOwner && !(await canViewSettingsTab("targets"))) redirect("/settings");
    leadTeamId = isOwner ? null : member.team_id ?? null;
  }
  return <TargetsView isOwner={isOwner} leadTeamId={leadTeamId} />;
}
