import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { PaymentsSettingsView } from "@/components/PaymentsSettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsPaymentsPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");
  if (member.role !== "owner" && member.role !== "superadmin") {
    redirect("/settings/team");
  }
  return <PaymentsSettingsView />;
}
