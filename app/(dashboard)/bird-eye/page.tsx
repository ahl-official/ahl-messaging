import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { BirdEyeView } from "@/components/BirdEyeView";
import { DEMO_MODE } from "@/lib/demo";
import { canViewPanel } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function BirdEyePage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    if (!(await canViewPanel("inbox"))) redirect("/dashboard");
  }

  return <BirdEyeView />;
}
