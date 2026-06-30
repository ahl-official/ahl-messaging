import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { panelAllowed } from "@/lib/permission-types";
import { DEMO_MODE } from "@/lib/demo";
import { LsqView } from "@/components/LsqView";

export const dynamic = "force-dynamic";

export default async function IntegrationsLsqPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    // Owner gets in unconditionally. For everyone else respect the
    // panel-level access grant the owner set in Settings → Permissions /
    // Customize access — same gate the sidebar uses.
    if (member.role !== "owner") {
      const perms = await getEffectivePermissionsFor(member);
      if (!panelAllowed(perms, "lsq")) redirect("/dashboard");
    }
  }
  return <LsqView />;
}
