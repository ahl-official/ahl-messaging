// POST /api/settings/payment-accounts
//   body { provider: 'razorpay'|'payu', label, credentials, set_active? }
//
// Owner only — adds a new account.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import {
  createPaymentAccount,
  type Clinic,
  type PaymentCredentials,
} from "@/lib/payment-accounts";
import type { ProviderId } from "@/lib/payment-providers/types";

export const runtime = "nodejs";

interface Body {
  provider?: string;
  clinic?: string;
  label?: string;
  credentials?: PaymentCredentials;
  set_active?: boolean;
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body.provider !== "razorpay" && body.provider !== "payu") {
    return NextResponse.json(
      { error: "provider must be 'razorpay' or 'payu'" },
      { status: 400 },
    );
  }
  const clinic: Clinic = body.clinic === "alchemane" ? "alchemane" : "americanhairline";
  const label = body.label?.trim();
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (!body.credentials || typeof body.credentials !== "object") {
    return NextResponse.json({ error: "credentials required" }, { status: 400 });
  }
  // Minimal shape check per provider — keeps obviously broken accounts
  // from landing in the DB. Full validation happens at first use.
  if (body.provider === "razorpay") {
    if (!body.credentials.key_id || !body.credentials.key_secret) {
      return NextResponse.json(
        { error: "Razorpay needs key_id + key_secret" },
        { status: 400 },
      );
    }
  } else {
    if (!body.credentials.merchant_key || !body.credentials.merchant_salt) {
      return NextResponse.json(
        { error: "PayU needs merchant_key + merchant_salt" },
        { status: 400 },
      );
    }
  }
  const account = await createPaymentAccount({
    clinic,
    provider: body.provider as ProviderId,
    label,
    credentials: body.credentials,
    created_by: me.email ?? null,
    set_active: !!body.set_active,
  });
  return NextResponse.json({
    ok: true,
    account: {
      id: account.id,
      clinic: account.clinic,
      provider: account.provider,
      label: account.label,
      is_active: account.is_active,
    },
  });
}
