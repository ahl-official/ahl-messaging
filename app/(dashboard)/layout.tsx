import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { LeftNav } from "@/components/LeftNav";
import { TopBar } from "@/components/TopBar";
import { UnassignedNumbersBanner } from "@/components/UnassignedNumbersBanner";
import { CallOverlay } from "@/components/CallOverlay";
import { TelephonyCallWidget } from "@/components/TelephonyCallWidget";
import { PermissionsProvider } from "@/components/PermissionsContext";
import { MembersProvider } from "@/components/MembersContext";
import { HeartbeatTracker } from "@/components/HeartbeatTracker";
import { AuthStateWatcher } from "@/components/AuthStateWatcher";
import { GlobalInboundWatcher } from "@/components/GlobalInboundWatcher";
import { NotificationToasts } from "@/components/NotificationToasts";
import { NotificationsDropdown } from "@/components/NotificationsDropdown";
import { CallNotificationWatcher } from "@/components/CallNotificationWatcher";
import { HomeAssistant } from "@/components/HomeAssistant";
import { NewChatFab } from "@/components/NewChatFab";
import { RecentActivityFab } from "@/components/RecentActivityFab";
import { BulkStatusProgressBar } from "@/components/BulkStatusProgressBar";
import {
  FloatingDockProvider,
  FloatingDockToggle,
} from "@/components/FloatingDockToggle";
import { DEMO_MODE, DEMO_USER_EMAIL } from "@/lib/demo";
import { getCurrentMember, type Role } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { ownerPermissions, type EffectivePermissions } from "@/lib/permission-types";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let userEmail: string | null = null;
  let fullName: string | null = null;
  let role: Role | null = null;
  let isTeamLead = false;
  let perms: EffectivePermissions = ownerPermissions();

  if (DEMO_MODE) {
    userEmail = DEMO_USER_EMAIL;
    role = "owner";
    perms = ownerPermissions();
  } else {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    // Pull the team_members row — owns role + active flag. If the user signed
    // in but isn't a member yet (rare race with the DB trigger), redirect them
    // back to /login with a friendly error rather than rendering a half-broken
    // dashboard.
    const member = await getCurrentMember();
    if (!member) {
      // getCurrentMember returns null for any non-active row. We need to
      // distinguish pending_approval (banner shows "awaiting approval")
      // from deactivated (banner shows "deactivated"). Read the raw row
      // and pick the right error code, then SIGN OUT — without the
      // signOut, middleware sees a live session, bounces /login back to
      // /dashboard, and the user gets stuck in a redirect loop landing
      // on /dashboard?error=… with a blank screen.
      const { data: raw } = await supabase
        .from("team_members")
        .select("pending_approval")
        .eq("user_id", user.id)
        .maybeSingle();
      const errorCode = raw?.pending_approval === true ? "pending_approval" : "deactivated";
      await supabase.auth.signOut();
      redirect(`/login?error=${errorCode}`);
    }

    userEmail = member.email;
    fullName = member.full_name ?? (user.user_metadata?.full_name as string | undefined) ?? null;
    role = member.role;
    isTeamLead = member.is_team_lead === true;
    perms = await getEffectivePermissionsFor(member);
  }

  return (
    <PermissionsProvider value={perms}>
    <MembersProvider>
    <FloatingDockProvider>
    <div className="flex h-[100dvh] bg-secondary">
      {/* Vertical icon nav */}
      <LeftNav role={role} allowedPanels={perms.allowed_panels} isTeamLead={isTeamLead} />

      {/* Main column */}
      <div className="flex flex-1 min-w-0 flex-col">
        {DEMO_MODE ? (
          <div className="bg-amber-100 text-amber-900 text-center text-xs py-1.5 border-b border-amber-200 shrink-0">
            🎭 Demo mode — data is in-memory only. Sent messages get a simulated reply ~2s later.
          </div>
        ) : null}
        <TopBar
          email={userEmail ?? ""}
          fullName={fullName}
          role={role}
          isDemo={DEMO_MODE}
        />

        <UnassignedNumbersBanner role={role} />

        <div className="flex-1 min-h-0">{children}</div>
      </div>

      {/* Global incoming-call overlay — listens for ringing rows in
          whatsapp_calls and runs the WebRTC handshake on Accept. */}
      <CallOverlay />
      {/* Telephony connector (PSTN) call widget — shows a live call card when
          an agent fires a click-to-call from the chat. */}
      <TelephonyCallWidget />
      {/* Activity heartbeat — pings every 30s while a tab is visible
          to keep user_activity_days fresh. No DOM. */}
      {!DEMO_MODE ? <HeartbeatTracker /> : null}
      {/* Auth watcher — force-navigates to /login when the Supabase
          session signs out (this tab, another tab, or admin revoke).
          Catches the case where the logout server action's redirect
          gets swallowed and the UI sits on a stale page. */}
      {!DEMO_MODE ? <AuthStateWatcher /> : null}
      {/* Inbound message watcher + toast stack — mounted globally
          (not just on inbox) so notifications fire on every page and
          desktop pings keep working when the tab is in the background. */}
      {!DEMO_MODE ? (
        <>
          <GlobalInboundWatcher />
          <CallNotificationWatcher />
          <NotificationToasts />
          {/* Persistent notification center (bottom-right) — keeps a
              record of every inbound ping until the operator acts on
              it. Complements the auto-dismiss toast stack above. */}
          <NotificationsDropdown />
          {/* Floating AI assistant — glowing FAB above the bell. Tool-
              calling agent for chats/messages/reports/actions. */}
          <HomeAssistant />
          {/* Start-new-chat launcher — sits above the AI assistant.
              Pops a dialog for phone + business number + first message;
              routes Meta through Magic Message, Evolution direct. */}
          <NewChatFab />
          {/* Recent automation activity — was a right rail on the
              Automation page; pulled into a FAB so the grid gets the
              full width back and the feed is reachable from any page. */}
          <RecentActivityFab />
          {/* Bulk status background progress — only renders while a
              task is in flight or just finished. */}
          <BulkStatusProgressBar />
          {/* Small arrow tab on the right edge — toggles the dock of
              floating widgets above. Preference persists per-tab. */}
          <FloatingDockToggle />
        </>
      ) : null}
    </div>
    </FloatingDockProvider>
    </MembersProvider>
    </PermissionsProvider>
  );
}
