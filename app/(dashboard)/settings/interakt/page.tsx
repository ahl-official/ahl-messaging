import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { InteraktSettingsView } from "@/components/settings/InteraktSettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsInteraktPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");
  // Owner-only — connecting a parallel BSP routing is a workspace-level
  // integration with credentials.
  if (member.role !== "owner") redirect("/settings/team");
  return <InteraktSettingsView />;
}
