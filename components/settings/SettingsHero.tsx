"use client";

// Client wrapper around PremiumHeader for the Settings layout.
//
// The settings layout.tsx is a SERVER component, and PremiumHeader is a
// CLIENT component that takes `icon: LucideIcon` — a function reference,
// which is NOT serializable across the server/client boundary. So the
// server layout can't render <PremiumHeader icon={Shield} /> directly.
//
// This wrapper lives on the client side, imports the Shield icon itself,
// and only accepts serializable props (role, allowedSettingsTabs) from
// the server layout.

import { Shield } from "lucide-react";
import { PremiumHeader } from "@/components/PremiumHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import type { Role } from "@/lib/team-types";
import type { SettingsTabKey } from "@/lib/permission-types";

export function SettingsHero({
  role,
  allowedSettingsTabs,
}: {
  role: Role | null;
  allowedSettingsTabs: SettingsTabKey[] | null;
}) {
  return (
    <PremiumHeader
      icon={Shield}
      title="Workspace settings"
      subtitle="Team, roles, numbers, automations, integrations & data — all in one place."
      badges={
        role ? (
          <span className="inline-flex items-center rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ring-1 ring-inset ring-white/25 backdrop-blur">
            {role}
          </span>
        ) : null
      }
      below={
        <SettingsTabs role={role} allowedSettingsTabs={allowedSettingsTabs} />
      }
    />
  );
}
