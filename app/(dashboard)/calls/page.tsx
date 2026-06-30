import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { panelAllowed } from "@/lib/permission-types";
import { DEMO_MODE } from "@/lib/demo";
import { CallsView } from "@/components/CallsView";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (member.role !== "owner") {
      const ctx = await getCurrentEffectivePermissions();
      if (!ctx) redirect("/login");
      if (!panelAllowed(ctx.perms, "calls")) redirect("/dashboard");
      if (!ctx.perms.can_view_call_history) redirect("/dashboard");
    }
  }
  return <CallsView />;
}
