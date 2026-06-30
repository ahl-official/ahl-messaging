// POST /api/payments/webhook/payu[?account=<uuid>]
//
// PayU S2S notification endpoint. Configure per-account by appending
// ?account=<uuid> so multi-account installs route to the right salt.

import type { NextRequest } from "next/server";
import { handleProviderWebhook } from "@/app/api/payments/webhook/handler";

export const runtime = "nodejs";
export const maxDuration = 25;

export async function POST(request: NextRequest) {
  return handleProviderWebhook(request, "payu");
}
