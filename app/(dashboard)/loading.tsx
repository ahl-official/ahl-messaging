// Next.js automatically shows this component while a sibling page is
// streaming in (Suspense boundary). Replaces the default "blank screen
// for a few hundred ms" with the branded blur loader.

import { PageLoader } from "@/components/PageLoader";

export default function DashboardLoading() {
  return <PageLoader />;
}
