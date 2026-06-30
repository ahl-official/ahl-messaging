"use client";

// Settings → Data → LeadSquared.
//
//   1. Webhook  — generate the static URL to paste into LSQ.
//   2. Backfill — one-time bulk sync of every contact's stage.

import { LsqWebhookGenerator } from "@/components/settings/LsqWebhookGenerator";
import { LsqBackfillPanel } from "@/components/settings/LsqBackfillPanel";

export function LsqWebhookCard() {
  return (
    <div className="space-y-5">
      <LsqWebhookGenerator />
      <LsqBackfillPanel />
    </div>
  );
}
