"use client";

/**
 * build-feature-panel: the one feature panel on every Simple page besides Roadmap (which
 * opens it from its own views). A click on any element marked `data-feature` (the item's id,
 * else its key, its code (F-06) or its title) opens the panel for that feature, read from the roadmap as the caller
 * reads it; changes made in it go through the change engine, as on Roadmap.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { toast } from "@/components/ds/Toast";
import { FloatingCard, type Act } from "@/app/simple/roadmap/_card";
import { ChangeFailed, propose, undo, type Item } from "@/app/simple/roadmap/_lib";
import { usePhone } from "@/components/simple/FlowViews";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const OPEN_EVENT = "simple:open-feature";

/** Opens the one feature panel from code, for a control that must not open it on every click
 * (a Value / effort mark, which opens it only when it was not dragged). */
export function openFeaturePanel(feature: string) {
  document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: feature }));
}

export function FeaturePanelHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const phone = usePhone();
  const { can } = useMe();
  // Roadmap opens the panel from its own views (its card); every other page through here.
  const roadmap = usePathname()?.startsWith("/simple/roadmap") ?? false;
  useEffect(() => {
    if (roadmap) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-feature]");
      if (!el || el.closest('[role="dialog"]')) return;
      e.preventDefault();
      setOpen(el.dataset.feature ?? null);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [roadmap]);
  // Opened from code on every page, Roadmap too (a goal panel's look-alike, build-feature-panel review 6).
  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<string>).detail || null);
    document.addEventListener(OPEN_EVENT, onOpen);
    return () => document.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      {children}
      {open && <Opened feature={open} phone={phone} canChange={can("create_simple_change")} onClose={close} />}
    </>
  );
}

/** A one-pager's bet ("prd:<PRD slug>:<the bet's words>"): the PRD's item its words name, by its
 * code (F-06) or its title. */
function ofBet(items: Map<string, Item>, feature: string): Item | undefined {
  const m = /^prd:([^:]+):([\s\S]*)$/.exec(feature);
  if (!m) return undefined;
  const words = m[2].toLowerCase();
  const mine = [...items.values()].filter((i) => i.prd?.slug === m[1]);
  return mine.find((i) => !!i.code && new RegExp(`\\b${i.code}\\b`, "i").test(m[2])) ?? mine.sort((a, b) => b.title.length - a.title.length).find((i) => words.includes(i.title.toLowerCase()));
}

/** The opened feature, read (and read again after each change) only while the panel is open. */
function Opened({ feature, phone, canChange, onClose }: { feature: string; phone: boolean; canChange: boolean; onClose: () => void }) {
  const { data, loading, reload } = useQuery("simple-roadmap:feature-panel", () => unwrap(api.GET("/v1/simple/roadmap", {})));
  const items = useMemo(() => new Map((data?.items ?? []).map((i: Item) => [i.id, i])), [data]);
  const item = items.get(feature) ?? [...items.values()].find((i) => i.title === feature || i.key === feature || (!!i.code && i.code === feature)) ?? ofBet(items, feature);
  const act: Act = useCallback(
    async (_what, body, opts) => {
      try {
        const r = await propose(body);
        // build-feature-panel review 3: the panel's own words once applied, with Undo, as the frames show.
        if (r.change.status === "applied" && opts?.words)
          toast({ message: await opts.words(r), action: r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reload, (e) => toast({ message: String(e.message) })) } : undefined });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
      } finally {
        await reload();
      }
    },
    [reload],
  );
  // No roadmap item matches (once loaded): say so in a toast and close, rather than doing nothing.
  useEffect(() => {
    if (loading || item) return;
    toast({ message: "This feature is not on a roadmap yet, so it has no panel." });
    onClose();
  }, [loading, item, onClose]);
  if (!item) return null;
  return <FloatingCard item={item} items={items} proposals={[]} phone={phone} style={{}} act={act} canChange={canChange} onDecide={() => undefined} onClose={onClose} />;
}
