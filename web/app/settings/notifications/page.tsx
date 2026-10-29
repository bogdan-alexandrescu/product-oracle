import { Suspense } from "react";


import { NotificationsSettings } from "./NotificationsSettings";
import { PageSkeleton } from "@/components/ds";

export default function NotificationsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <NotificationsSettings />
    </Suspense>
  );
}
