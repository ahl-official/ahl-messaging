import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { CallingSettingsView } from "@/components/settings/CallingSettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsCallingPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");
  if (member.role !== "owner" && member.role !== "superadmin") {
    redirect("/settings/team");
  }
  return <CallingSettingsView />;
}
