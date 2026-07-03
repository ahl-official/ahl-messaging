// Public client-facing booking page (no login). Opened from a link the agent
// shares on WhatsApp. The interactive picker lives in the client component.

import { BookingClient } from "@/components/BookingClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Book your date — American Hairline",
  robots: { index: false, follow: false },
};

export default function BookingPage({ params }: { params: { token: string } }) {
  return <BookingClient token={params.token} />;
}
