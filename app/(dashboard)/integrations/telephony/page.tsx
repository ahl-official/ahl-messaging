import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { panelAllowed } from "@/lib/permission-types";
import { DEMO_MODE } from "@/lib/demo";
import { TelephonyView } from "@/components/TelephonyView";

export const dynamic = "force-dynamic";

export default async function IntegrationsTelephonyPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    // Owner gets in unconditionally; everyone else needs the panel grant.
    if (member.role !== "owner") {
      const perms = await getEffectivePermissionsFor(member);
      if (!panelAllowed(perms, "telephony")) redirect("/dashboard");
    }
  }
  // Connector key authenticates the operator's inbound hooks. Kept in env —
  // never hardcoded. Shown in the generated hook URLs so the operator can
  // configure them; falls back to a visible placeholder when unset.
  const connectorKey = process.env.TELEPHONY_CONNECTOR_KEY || "";
  return <TelephonyView connectorKey={connectorKey} />;
}
