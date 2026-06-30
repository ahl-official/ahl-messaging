import { LayoutGrid } from "lucide-react";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export default function WidgetPage() {
  return (
    <ComingSoonPage
      icon={LayoutGrid}
      title="Website widget"
      description="A floating WhatsApp button + chat preview you can drop on uroots.in or any QHT site. Visitors tap it and land in your inbox as a tagged contact."
      status="planned"
      features={[
        "One-line embed snippet — copy-paste into your site",
        "Customise colour, position, greeting message",
        "Auto-tag inbound chats with the page they came from",
        "Pre-fill name + email from your form before chat starts",
      ]}
    />
  );
}
