// GET /api/team/permissions
// Returns role_permissions, all team_member_permissions overrides, and
// the caller's effective permissions. Any signed-in active member can
// read this — UI uses it to know what to show / hide.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import {
  getAllRolePermissions,
  getAllMemberOverrides,
  getAllNumberAccessModes,
  getAllTeamPermissions,
  getEffectivePermissionsFor,
} from "@/lib/permissions";
import { listPortfolios } from "@/lib/portfolios";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [roles, overrides, modes, teamPerms, myPerms, numbersResp] = await Promise.all([
    getAllRolePermissions(),
    getAllMemberOverrides(),
    getAllNumberAccessModes(),
    getAllTeamPermissions(),
    getEffectivePermissionsFor(me),
    createServiceRoleClient()
      .from("business_numbers")
      .select(
        // Migration 0013 (portfolio_id column) is not deployed on every
        // tenant. Selecting it errors the whole row out and the
        // Customize Access modal shows "no numbers connected". Group
        // by provider / nickname in the UI instead — accurate enough
        // without the portfolios linkage.
        "phone_number_id, display_phone_number, verified_name, nickname, provider",
      ),
  ]);

  // Tag each number with the portfolio it actually belongs to (env
  // PHONE_IDS mapping) so the Customize-Access grid groups by tenant, not
  // by the number's WhatsApp display name — which mis-buckets e.g. a
  // Sahil-portfolio number verified as "Junaid Aalam".
  const portfolioByPhoneId = new Map<string, string>();
  for (const p of listPortfolios()) {
    const label = p.display_name?.trim() || p.name?.trim() || p.key;
    for (const id of p.phone_number_ids) portfolioByPhoneId.set(id, label);
  }
  const numbers = (numbersResp.data ?? []).map((n) => ({
    ...n,
    portfolio: portfolioByPhoneId.get(n.phone_number_id) ?? null,
  }));

  return NextResponse.json({
    me: { id: me.id, role: me.role },
    role_permissions: roles,
    member_overrides: overrides,
    number_access_modes: modes,
    team_permissions: teamPerms,
    my_permissions: myPerms,
    numbers,
  });
}
