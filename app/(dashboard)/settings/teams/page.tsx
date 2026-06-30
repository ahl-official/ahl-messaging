import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /settings/teams was its own top-level tab; we collapsed it into
// /settings/team with a "Groups" sub-tab. Old bookmarks and sidebar
// shortcuts land here — bounce them onto the merged view with the
// Groups sub-tab pre-selected.
export default async function TeamsSettingsPage() {
  redirect("/settings/team?view=groups");
}
