// POST /api/payments/webhook/razorpay[?account=<uuid>]
//
// Configure in Razorpay dashboard. Multi-account installs append
// ?account=<uuid> so the handler picks the right secret to verify
// against; one-account installs can omit it (handler falls back to
// the active Razorpay account).

import type { NextRequest } from "next/server";
import { handleProviderWebhook } from "@/app/api/payments/webhook/handler";

export const runtime = "nodejs";
export const maxDuration = 25;

export async function POST(request: NextRequest) {
  return handleProviderWebhook(request, "razorpay");
}
