import { NextRequest, NextResponse } from "next/server";
import { wahaSetWebhook } from "@/lib/waha";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const member = await getCurrentMember();
  if (!member || !["owner", "superadmin"].includes(member.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { session } = await req.json();
  if (!session) {
    return NextResponse.json({ error: "session required" }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  const webhookUrl = `${appUrl}/api/waha/webhook/${session}`;

  const ok = await wahaSetWebhook(session, webhookUrl);

  return NextResponse.json({ ok, webhookUrl });
}
