import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { canViewPanel } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { getCurrentMember } from "@/lib/team";
import { TasksView } from "@/components/TasksView";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    if (!(await canViewPanel("tasks"))) redirect("/dashboard");
  }

  const member = await getCurrentMember();
  return (
    <TasksView
      currentMemberId={member?.id ?? ""}
      currentRole={member?.role ?? "teammate"}
    />
  );
}
