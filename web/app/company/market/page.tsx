"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState, type KeyboardEvent } from "react";

import { Button, ScrollStrip, ViewOnly } from "@/components/ds";
import { Loading } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useSetParams } from "@/lib/use-set-params";

import { CompanyHeader } from "../_nav";
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
  const params = useSearchParams();
  // Rewrites the URL's state (null removes a key) from the latest URL; the page follows the URL.
  const setParams = useSetParams();
  const { can, capsReady, capsError } = useMe();
  const [adding, setAdding] = useState(false);
  // qa-company-20: an empty list shows its own Add button, so the header drops its one.
  const [noAlternatives, setNoAlternatives] = useState(false);
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

  return (
    <>
      <CompanyHeader
        status={capsReady && !mayWrite ? <ViewOnly /> : undefined}
        action={
          mayWrite &&
          tab === "alternatives" &&
          !noAlternatives && (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              Add alternative
            </Button>
          )
        }
      />
      <MarketTabs tabs={allowed} value={tab} onChange={(v) => setParams({ tab: v === "alternatives" ? null : v, view: null, alternative: null })} />
      {tab === "alternatives" && (
        <Alternatives
          picked={alternative}
          onPick={(id) => setParams({ alternative: id })}
          onOpenChange={(id) => setParams({ change: id })}
          adding={adding && mayWrite}
          onAdding={setAdding}
          onEmpty={setNoAlternatives}
        />
      )}
      {tab === "changes" && (
        <ChangeLog
          view={view}
          onView={(v) => setParams({ view: v === "web" ? "web" : null })}
          alternative={alternative}
          onAlternative={(id) => setParams({ alternative: id })}
          onOpenChange={(id) => setParams({ change: id })}
          onAddAlternative={
            mayWrite
              ? () => {
                  setParams({ tab: null, view: null, alternative: null });
                  setAdding(true);
                }
              : undefined
          }
        />
      )}
      {tab === "positioning" && <Positioning />}
      {tab === "pricing" && <Pricing />}
      {tab === "win-loss" && <WinLoss />}
      {change && <ChangeDiff key={change} id={change} onClose={() => setParams({ change: null })} />}
    </>
  );
}

/**
 * Market's own sub-tabs, a second level under the Company tabs: underlined, not the Company
 * pills (qa-company-38), their labels lined up with the cards' content (16 px in, 12 px on a
 * phone). On a phone they scroll sideways in a ScrollStrip, with no native scrollbar and no
 * label cut (qa-shell-34).
 */
function MarketTabs({ tabs, value, onChange }: { tabs: { value: Tab; label: string; testId: string }[]; value: Tab; onChange: (v: Tab) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    els[(at + (e.key === "ArrowRight" ? 1 : -1) + els.length) % els.length]?.focus();
  };
  return (
    <div data-testid="market-tabs" className="mb-3 border-b border-line">
      <ScrollStrip ref={ref} role="tablist" aria-label="Market" onKeyDown={onKey} stripClassName="gap-1 px-1 max-[600px]:px-0">
        {tabs.map((t) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              data-testid={t.testId}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.value)}
              className={`flex h-10 flex-none items-center border-b-2 px-3 text-[15px] whitespace-nowrap max-[639px]:h-11 ${
                on ? "border-accent font-semibold text-text" : "border-transparent font-medium text-text2 hover:text-text"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </ScrollStrip>
    </div>
  );
}
