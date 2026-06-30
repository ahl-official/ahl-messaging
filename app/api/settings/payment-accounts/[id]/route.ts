// PATCH  /api/settings/payment-accounts/[id]
//   body { label?, credentials? }   → edit
// DELETE /api/settings/payment-accounts/[id]
// POST   /api/settings/payment-accounts/[id]/activate  → flip active

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import {
  deletePaymentAccount,
  updatePaymentAccount,
  type PaymentCredentials,
} from "@/lib/payment-accounts";

export const runtime = "nodejs";

interface PatchBody {
  label?: string;
  credentials?: PaymentCredentials;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const { id } = await params;
  if (id.startsWith("env:")) {
    return NextResponse.json(
      { error: ".env.local accounts are read-only. Add a new account to override." },
      { status: 400 },
    );
  }
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  await updatePaymentAccount(id, {
    label: body.label?.trim(),
    credentials: body.credentials,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const { id } = await params;
  if (id.startsWith("env:")) {
    return NextResponse.json(
      { error: ".env.local accounts cannot be deleted from the UI." },
      { status: 400 },
    );
  }
  await deletePaymentAccount(id);
  return NextResponse.json({ ok: true });
}
