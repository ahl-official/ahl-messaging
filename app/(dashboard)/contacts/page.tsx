import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { ContactsView } from "@/components/ContactsView";
import type { Contact } from "@/lib/types";
import { DEMO_MODE, demoSeedContactsForServer } from "@/lib/demo";
import { getCurrentEffectivePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface Props {
  searchParams: Promise<{ page?: string; q?: string }>;
}

export default async function ContactsPage({ searchParams }: Props) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const q = (params.q ?? "").trim();

  if (DEMO_MODE) {
    const all = demoSeedContactsForServer();
    const filtered = q
      ? all.filter(
          (c) =>
            (c.name ?? "").toLowerCase().includes(q.toLowerCase()) ||
            c.wa_id.includes(q),
        )
      : all;
    const start = (page - 1) * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);
    return (
      <ContactsView
        contacts={slice}
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        query={q}
      />
    );
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const permsBundle = await getCurrentEffectivePermissions();
  const allowedNumbers = permsBundle?.perms.allowed_number_ids ?? null;

  // After migration 0016, the same patient can have one contact row per
  // business number they've messaged — so a search for "9045454045"
  // returns N rows (one per bpid). That's correct in the DB but very
  // confusing in the Contact Hub: the operator sees 13 identical-looking
  // rows for one person. We dedupe by wa_id here, keep the newest row
  // (sorted DESC), and stamp a `linked_numbers_count` so the table can
  // show "× N numbers" on the row. To keep this O(1) RPC instead of
  // window-functions, we over-fetch a window (PAGE_SIZE * OVERFETCH),
  // dedupe in JS, and slice the requested page out of the result.
  const OVERFETCH = 6; // 6× page = plenty even when every patient has many bpid duplicates
  const fetchLimit = PAGE_SIZE * OVERFETCH;
  const fetchFrom = (page - 1) * PAGE_SIZE * OVERFETCH;
  const fetchTo = fetchFrom + fetchLimit - 1;

  let builder = supabase
    .from("contacts")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(fetchFrom, fetchTo);

  if (allowedNumbers !== null) {
    builder =
      allowedNumbers.length === 0
        ? builder.in("business_phone_number_id", ["__none__"])
        : builder.in("business_phone_number_id", allowedNumbers);
  }

  if (q) {
    builder = builder.or(`name.ilike.%${q}%,profile_name.ilike.%${q}%,wa_id.ilike.%${q}%`);
  }

  const { data, count, error } = await builder;

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-secondary px-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load contacts: {error.message}
        </div>
      </div>
    );
  }

  // Dedupe by wa_id, keep the newest (already DESC-sorted), and annotate
  // with how many other contact rows share this wa_id so the table can
  // show "× N numbers" without a second query per row.
  const seen = new Map<string, Contact>();
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Contact[]) {
    const key = row.wa_id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!seen.has(key)) seen.set(key, row);
  }
  const deduped: Contact[] = Array.from(seen.values()).map((c) => ({
    ...c,
    linked_numbers_count: counts.get(c.wa_id) ?? 1,
  })) as Contact[];

  // Slice the operator's requested page out of the deduped result.
  const slice = deduped.slice(0, PAGE_SIZE);

  return (
    <ContactsView
      contacts={slice}
      total={count ?? deduped.length}
      page={page}
      pageSize={PAGE_SIZE}
      query={q}
    />
  );
}
