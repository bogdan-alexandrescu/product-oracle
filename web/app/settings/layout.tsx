import { Suspense, type ReactNode } from "react";

import { Page, PageTabsProvider } from "@/components/ds";

import { SettingsGate } from "./_gate";
import { SettingsNav } from "./_nav";

/*
 * qa-settings-11: the Settings tabs sit at one height on every tab. Above a phone, the
 * header's title row is the title's 40 px whatever it holds (an action button is 40 px at
 * most), and a page's back link (a template's "← Templates") sits on that row, not one above.
 */
const ONE_TITLE_ROW =
  "min-[601px]:[&_[data-page-header]>[data-page-back]]:flex-none min-[601px]:[&_[data-page-header]>[data-page-back]]:basis-auto min-[601px]:[&_[data-page-header]>h1]:leading-10";

/** Every settings page: the page (title, Settings tabs under it, table, inspector). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <Page className={ONE_TITLE_ROW}>
      {/* qa4-shell-13: the section's name above every Settings page's own title (a phone's page picker says it there). */}
      <p data-testid="settings-eyebrow" className="-mb-2 pt-3 text-[13px] leading-4 font-semibold text-text2 max-[600px]:hidden">
        Settings
      </p>
      <PageTabsProvider
        tabs={
          <Suspense fallback={<div className="h-12" />}>
            <SettingsNav />
          </Suspense>
        }
      >
        <Suspense fallback={<div className="h-12" />}>
          <SettingsGate>{children}</SettingsGate>
        </Suspense>
      </PageTabsProvider>
    </Page>
  );
}
