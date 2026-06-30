// Edit-page loading fallback. Next.js routes any async work in
// page.tsx through this until the data resolves, so the operator sees
// an immediate spinner instead of a hung tab while we fetch the
// template detail from Meta.

import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="grid h-full place-items-center bg-secondary/30 px-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading template…
      </div>
    </div>
  );
}
