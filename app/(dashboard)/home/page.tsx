import { redirect } from "next/navigation";
import { HomeView } from "@/components/HomeView";
import { DEMO_MODE } from "@/lib/demo";
import { getCurrentMember } from "@/lib/team";
import { canViewPanel, getEffectivePermissionsFor } from "@/lib/permissions";
import { getHomeStats, type HomeStats } from "@/lib/home-stats";

export const dynamic = "force-dynamic";

const DEMO_STATS: HomeStats = {
  openCount: 4,
  closedCount: 1,
  totalConversations: 5,
  unreadConversations: 3,
  unreadMessages: 4,
  windowsExpiringSoon: 1,
  windowsClosed: 0,
  unassignedOpen: 2,
  perNumber: [
    {
      business_phone_number_id: "demo-1",
      verified_name: "URoots by QHT",
      display_phone_number: "+91 90847 23091",
      totalCount: 5,
      openCount: 4,
      unreadConversations: 3,
      unreadMessages: 4,
    },
  ],
  topTags: [
    { tag: "hair-loss", totalCount: 8, unreadCount: 3 },
    { tag: "consultation", totalCount: 5, unreadCount: 1 },
    { tag: "follow-up", totalCount: 4, unreadCount: 0 },
  ],
  recentActivity: [
    {
      contact_id: "c1",
      wa_id: "919876543210",
      display_name: "Aarav Sharma",
      preview: "Thank you, see you tomorrow at 4pm!",
      timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      business_phone_number_id: "demo-1",
    },
    {
      contact_id: "c3",
      wa_id: "919123456789",
      display_name: "Rohan Mehta",
      preview: "📷 Photo",
      timestamp: new Date(Date.now() - 90 * 60_000).toISOString(),
      business_phone_number_id: "demo-1",
    },
  ],
};

export default async function HomePage() {
  if (DEMO_MODE) {
    return (
      <HomeView
        stats={DEMO_STATS}
        memberName="Demo User"
        memberFirstName="Demo"
        role="owner"
      />
    );
  }

  const member = await getCurrentMember();
  if (!member) redirect("/login");
  if (!(await canViewPanel("home"))) redirect("/dashboard");

  // Scope every counter to the numbers this user is actually allowed
  // to see. Owners + members with allowed_number_ids === null still
  // see workspace-wide stats; everyone else gets a member-specific
  // slice (open / unread / per-number / recent activity all match
  // what they'd see in the inbox).
  const perms = await getEffectivePermissionsFor(member);
  const stats = await getHomeStats(perms.allowed_number_ids);

  const fullName = member.full_name?.trim() || member.email;
  const firstName =
    member.full_name?.trim().split(/\s+/)[0] || member.email.split("@")[0];

  return (
    <HomeView
      stats={stats}
      memberName={fullName}
      memberFirstName={firstName}
      role={member.role}
    />
  );
}
