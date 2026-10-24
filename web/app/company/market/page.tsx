"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Button, PageHeader, SegmentedControl, ViewOnly } from "@/components/ds";
import { Loading } from "@/components/ui";
import { useMe } from "@/lib/me";

import { Alternatives } from "./_components/Alternatives";
import { ChangeDiff } from "./_components/ChangeDiff";
import { ChangeLog, type ChangeView } from "./_components/ChangeLog";
import { Positioning } from "./_components/Positioning";
import { Pricing } from "./_components/Pricing";
import { WinLoss } from "./_components/WinLoss";

type Tab = "alternatives" | "changes" | "positioning" | "pricing" | "win-loss";
const TABS: { value: Tab; label: string; testId: string }[] = [
  { value: "alternatives", label: "Alternatives", testId: "market-tab-alternatives" },
  { value: "changes", label: "Change log", testId: "market-tab-changes" },
  { value: "positioning", label: "Positioning", testId: "market-tab-positioning" },
  { value: "pricing", label: "Pricing", testId: "market-tab-pricing" },
  { value: "win-loss", label: "Win and loss", testId: "market-tab-win-loss" },
];

export default function MarketPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Market />
    </Suspense>
  );
}

/**
 * Company › Market (owner 2026-10-23, "New pages"). H7: the alternatives Oracle watches, the
 * dated change log with what the monthly web search found, and the company's positioning
 * inputs; everyone reads them, approvers and owners add, watch, promote and accept, and others
 * see "View only" with none of those controls (#370). H9: Pricing (the pricing memos) and Win
 * and loss (the deals' results) after them, drawn only for a role that may list them; an
 * address it may not open shows the first sub-tab it may (Win and loss falls back to Pricing).
 * The sub-tab, the picked alternative, an open change and the From the web view live in the
 * URL, so the digest's and the memos' links open them.
 */
function Market() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, capsReady, capsError } = useMe();
  const [adding, setAdding] = useState(false);
  if (!capsReady && !capsError) return <Loading />;
  const pricing = can("list_pricing_memos");
  const winLoss = pricing && can("list_deal_outcomes");
  const allowed = TABS.filter((t) => (t.value === "pricing" ? pricing : t.value === "win-loss" ? winLoss : true));
  const asked = params.get("tab");
  const tab: Tab = allowed.some((t) => t.value === asked)
    ? (asked as Tab)
    : asked === "win-loss" && pricing
      ? "pricing"
      : "alternatives";
  const view: ChangeView = params.get("view") === "web" ? "web" : "changes";
  const alternative = params.get("alternative");
  const change = params.get("change");
  const mayWrite = can("create_competitor");

  /** Rewrites the URL's state (null removes a key); the page follows the URL. */
  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }

  return (
    <>
      <PageHeader
        title="Company"
        status={capsReady && !mayWrite ? <ViewOnly /> : undefined}
        action={
          mayWrite &&
          tab === "alternatives" && (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              Add alternative
            </Button>
          )
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl<Tab>
          label="Market"
          items={allowed}
          value={tab}
          onChange={(v) => setParams({ tab: v === "alternatives" ? null : v, view: null, alternative: null })}
        />
      </div>
      {tab === "alternatives" && (
        <Alternatives
          picked={alternative}
          onPick={(id) => setParams({ alternative: id })}
          onOpenChange={(id) => setParams({ change: id })}
          adding={adding && mayWrite}
          onAdding={setAdding}
        />
      )}
      {tab === "changes" && (
        <ChangeLog
          view={view}
          onView={(v) => setParams({ view: v === "web" ? "web" : null })}
          alternative={alternative}
          onAlternative={(id) => setParams({ alternative: id })}
          onOpenChange={(id) => setParams({ change: id })}
        />
      )}
      {tab === "positioning" && <Positioning />}
      {tab === "pricing" && <Pricing />}
      {tab === "win-loss" && <WinLoss />}
      {change && <ChangeDiff key={change} id={change} onClose={() => setParams({ change: null })} />}
    </>
  );
}
