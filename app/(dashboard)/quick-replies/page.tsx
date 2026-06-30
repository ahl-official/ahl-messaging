import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { QuickRepliesView } from "@/components/QuickRepliesView";
import { DEMO_MODE } from "@/lib/demo";
import { canViewPanel } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function QuickRepliesPage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    if (!(await canViewPanel("quick_replies"))) redirect("/dashboard");
  }

  return <QuickRepliesView />;
}
