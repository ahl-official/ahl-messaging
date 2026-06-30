import { redirect } from "next/navigation";
import { Megaphone } from "lucide-react";
import { canViewSettingsTab } from "@/lib/permissions";
import { DEMO_MODE } from "@/lib/demo";
import { NoticeBannerEditor } from "@/components/settings/NoticeBannerEditor";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

export const dynamic = "force-dynamic";

export default async function NoticeSettingsPage() {
  if (!DEMO_MODE && !(await canViewSettingsTab("notice"))) redirect("/settings");
  return (
    <div className="flex h-full flex-col">
      <SettingsPageHeader
        icon={Megaphone}
        tone="amber"
        title="Notice banner"
        subtitle="Shown across the top of every dashboard page. Broadcast maintenance windows, audits, or anything the team needs to see at a glance."
      />
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <NoticeBannerEditor />
      </div>
    </div>
  );
}
