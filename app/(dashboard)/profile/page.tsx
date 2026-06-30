import { redirect } from "next/navigation";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { DEMO_MODE } from "@/lib/demo";
import { ProfileForm } from "@/components/ProfileForm";
import { SessionsCard } from "@/components/SessionsCard";
import type { TeamMember } from "@/lib/team-types";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  if (DEMO_MODE) {
    redirect("/dashboard");
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("team_members")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const member = (data ?? null) as TeamMember | null;
  if (!member) redirect("/login?error=deactivated");

  return (
    <div className="space-y-6">
      <ProfileForm initial={member} />
      <SessionsCard scope="self" />
    </div>
  );
}
