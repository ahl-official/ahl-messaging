import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { TemplatesView } from "@/components/TemplatesView";
import { DEMO_MODE } from "@/lib/demo";
import { getCredential } from "@/lib/credentials";
import { canViewPanel } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    if (!(await canViewPanel("templates"))) redirect("/dashboard");
  }

  const wabaId = (await getCredential("whatsapp_business_account_id")) ?? null;
  return <TemplatesView wabaId={wabaId} />;
}
