"use client";

// Provides the current user's effective permissions to every client
// component. Mounted once at the dashboard layout root (server-rendered
// initial value, then never refetched — refresh on edits is handled by
// router.refresh() from the settings UI).

import { createContext, useContext, type ReactNode } from "react";
import {
  ownerPermissions,
  numberAllowed,
  panelAllowed,
  type EffectivePermissions,
  type PanelKey,
} from "@/lib/permission-types";
import { maskEmail, maskNameOrPhone, maskPhone } from "@/lib/mask";

const Ctx = createContext<EffectivePermissions>(ownerPermissions());

export function PermissionsProvider({
  value,
  children,
}: {
  value: EffectivePermissions;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePermissions(): EffectivePermissions {
  return useContext(Ctx);
}

export function useCanAccessPanel(panel: PanelKey): boolean {
  const perms = useContext(Ctx);
  return panelAllowed(perms, panel);
}

export function useCanAccessNumber(numberId: string | null | undefined): boolean {
  const perms = useContext(Ctx);
  if (!numberId) return true;
  return numberAllowed(perms, numberId);
}

/** Convenience masker hooks — return original value when masking is off. */
export function usePhoneMasker(): (v: string | null | undefined) => string {
  const perms = useContext(Ctx);
  return (v) => (perms.mask_phone_numbers ? maskPhone(v) : v ?? "");
}

/** Masks a "name OR phone" label — real names pass through, bare numbers
 *  get masked. Use for contact display-name fields that fall back to wa_id. */
export function useNameOrPhoneMasker(): (v: string | null | undefined) => string {
  const perms = useContext(Ctx);
  return (v) => maskNameOrPhone(v, perms.mask_phone_numbers);
}

export function useEmailMasker(): (v: string | null | undefined) => string {
  const perms = useContext(Ctx);
  return (v) => (perms.mask_emails ? maskEmail(v) : v ?? "");
}
