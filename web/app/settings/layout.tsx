import { Suspense, type ReactNode } from "react";

import { Page } from "@/components/ds";

import { SettingsNav } from "./_nav";

/** Every settings page: the Settings strip, then the page (title, table, inspector). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <Page>
      <div className="pt-4">
        <Suspense fallback={<div className="mb-4 h-12" />}>
          <SettingsNav />
        </Suspense>
      </div>
      {children}
    </Page>
  );
}
