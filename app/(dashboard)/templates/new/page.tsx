import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { TemplateCreate } from "@/components/TemplateCreate";
import { DEMO_MODE } from "@/lib/demo";

export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
  }

  return <TemplateCreate businessName={process.env.WHATSAPP_DISPLAY_NAME ?? "URoots by QHT"} />;
}
