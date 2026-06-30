import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/team";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { PortfoliosView } from "@/components/PortfoliosView";

export const dynamic = "force-dynamic";

export default async function PortfoliosPage() {
  if (!DEMO_MODE) {
    const member = await getCurrentMember();
    if (!member) redirect("/login");
    if (member.role !== "owner") redirect("/dashboard");
    if (!(await canViewSettingsTab("portfolios"))) redirect("/settings");
  }
  return <PortfoliosView />;
}
