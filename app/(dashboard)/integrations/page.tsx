import { Puzzle } from "lucide-react";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export default function IntegrationsPage() {
  return (
    <ComingSoonPage
      icon={Puzzle}
      title="Integrations"
      description="Connect QHT Messaging to the tools your team already uses — Google Calendar for appointments, n8n for workflows, Zapier for everything else."
      status="planned"
      features={[
        "Google Calendar — push appointments + reminders",
        "n8n — outgoing webhooks on events",
        "Zapier — trigger Zaps on inbound messages",
        "Sheets / CRM sync for contact records",
        "API tokens for in-house tools",
      ]}
    />
  );
}
