"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Empty, PageHeader, Panel, SegmentedControl } from "@/components/ds";
import { Loading } from "@/components/ui";
import { useMe } from "@/lib/me";

import { Pricing } from "./_components/Pricing";
import { WinLoss } from "./_components/WinLoss";

type Tab = "pricing" | "win-loss";

/**
 * Company › Market (H9 Pricing input; placement per Q2 "New pages"): Pricing, the pricing
 * memos, and Win and loss, the deals' results. Owners and approvers only, as H8's updates:
 * commenters and viewers have no tab, and this page answers them with "Not found".
 */
export default function MarketPage() {
  const { can, capsReady, capsError } = useMe();
  if (!capsReady && !capsError) return <Loading />;
  // #370: the Market tab's own read (company/_tabs.ts).
  if (!can("list_pricing_memos", true)) {
    return (
      <>
        <PageHeader title="Company" />
        <Panel>
          <Empty testId="market-not-found">Not found</Empty>
        </Panel>
      </>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <Market />
    </Suspense>
  );
}

function Market() {
  const params = useSearchParams();
  const pathname = usePathname();
  const tab: Tab = params.get("tab") === "win-loss" ? "win-loss" : "pricing";
  return (
    <>
      <PageHeader title="Company" />
      <div className="mb-3">
        <SegmentedControl<Tab>
          label="Market"
          value={tab}
          items={[
            { value: "pricing", label: "Pricing", href: `${pathname}?tab=pricing`, testId: "market-tab-pricing" },
            { value: "win-loss", label: "Win and loss", href: `${pathname}?tab=win-loss`, testId: "market-tab-win-loss" },
          ]}
        />
      </div>
      {tab === "pricing" ? <Pricing /> : <WinLoss />}
    </>
  );
}
