import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { NotificationsSettings } from "./NotificationsSettings";

export default function NotificationsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NotificationsSettings />
    </Suspense>
  );
}
