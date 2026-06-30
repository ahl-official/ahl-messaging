import { ShoppingCart } from "lucide-react";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export default function CommercePage() {
  return (
    <ComingSoonPage
      icon={ShoppingCart}
      title="Commerce"
      description="Sell directly inside WhatsApp — share product cards from your Meta catalog, accept payments via in-chat checkout, and track orders alongside the conversation."
      status="planned"
      features={[
        "Sync products from Meta Commerce catalog",
        "Send single product or multi-product messages",
        "In-chat payment buttons (UPI / Razorpay)",
        "Order timeline pinned to the contact",
        "Inventory + price updates without leaving the inbox",
      ]}
    />
  );
}
