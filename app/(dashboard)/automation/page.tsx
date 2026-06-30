import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { canViewPanel } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { AutomationView } from "@/components/AutomationView";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    if (!(await canViewPanel("automation"))) redirect("/dashboard");
  }

  return <AutomationView />;
}
