import { createServerClient } from "@/lib/supabase/server";
import { DashboardView } from "@/components/DashboardView";
import type { BusinessNumber, Contact } from "@/lib/types";
import { DEMO_MODE, demoSeedContactsForServer } from "@/lib/demo";
import { getCurrentEffectivePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (DEMO_MODE) {
    return (
      <DashboardView
        initialContacts={demoSeedContactsForServer()}
        businessNumbers={[]}
        currentUserId={null}
        currentUserEmail={null}
      />
    );
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const permsBundle = await getCurrentEffectivePermissions();
  const allowedNumbers = permsBundle?.perms.allowed_number_ids ?? null;

  let contactsQuery = supabase
    .from("contacts")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (allowedNumbers !== null) {
    contactsQuery =
      allowedNumbers.length === 0
        ? contactsQuery.in("business_phone_number_id", ["__none__"])
        : contactsQuery.in("business_phone_number_id", allowedNumbers);
  }

  const [contactsRes, businessRes] = await Promise.all([
    contactsQuery,
    // NEVER select("*") here — these rows are passed as props into the
    // DashboardView client component, so every selected column is serialized
    // into the page HTML sent to the browser. select("*") leaked the secret
    // columns (evolution_api_key, interakt_api_key, interakt_webhook_secret).
    // Select only the non-secret fields the UI needs (same set the
    // /api/business-numbers endpoint returns).
    supabase
      .from("business_numbers")
      .select(
        "phone_number_id, display_phone_number, verified_name, nickname, memo, is_active, created_at, meta_status, meta_checked_at, waba_id, provider, evolution_instance_name, evolution_jid, evolution_connection_state, evolution_group_id, profile_pic_url",
      ),
  ]);

  const { data, error } = contactsRes;
  let businessNumbers = (businessRes.data ?? []) as BusinessNumber[];
  if (allowedNumbers !== null) {
    businessNumbers = businessNumbers.filter((n) =>
      allowedNumbers.includes(n.phone_number_id),
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-secondary px-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load contacts: {error.message}
        </div>
      </div>
    );
  }

  return (
    <DashboardView
      initialContacts={(data ?? []) as Contact[]}
      businessNumbers={businessNumbers}
      currentUserId={user?.id ?? null}
      currentUserEmail={user?.email ?? null}
    />
  );
}
