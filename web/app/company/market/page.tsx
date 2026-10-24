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

type Tab = "alternatives" | "changes" | "positioning";
const TABS: { value: Tab; label: string }[] = [
  { value: "alternatives", label: "Alternatives" },
  { value: "changes", label: "Change log" },
  { value: "positioning", label: "Positioning" },
];

export default function MarketPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Market />
    </Suspense>
  );
}

/**
 * Company › Market (H7; owner 2026-10-23, "New pages"): the alternatives Oracle watches, the
 * dated change log with what the monthly web search found, and the company's positioning
 * inputs. Everyone reads it; approvers and owners add, watch, promote and accept, and others
 * see "View only" with none of those controls (#370). The sub-tab, the picked alternative, an
 * open change and the From the web view live in the URL, so the digest's links open them.
 */
function Market() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, capsReady } = useMe();
  const tab = (TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "alternatives") as Tab;
  const view: ChangeView = params.get("view") === "web" ? "web" : "changes";
  const alternative = params.get("alternative");
  const change = params.get("change");
  const [adding, setAdding] = useState(false);
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
          items={TABS}
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
      {change && <ChangeDiff key={change} id={change} onClose={() => setParams({ change: null })} />}
    </>
  );
}
