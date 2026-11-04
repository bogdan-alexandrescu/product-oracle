"use client";

/**
 * build-feature-panel: the one feature panel on every Simple page besides Roadmap (which
 * opens it from its own views). A click on any element marked `data-feature` (the item's id,
 * else its title) opens the panel for that feature, read from the roadmap as the caller
 * reads it; changes made in it go through the change engine, as on Roadmap.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { toast } from "@/components/ds/Toast";
import { FloatingCard, type Act } from "@/app/simple/roadmap/_card";
import { ChangeFailed, propose, type Item } from "@/app/simple/roadmap/_lib";
import { usePhone } from "@/components/simple/FlowViews";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

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
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      {children}
      {open && <Opened feature={open} phone={phone} canChange={can("create_simple_change")} onClose={close} />}
    </>
  );
}

/** The opened feature, read (and read again after each change) only while the panel is open. */
function Opened({ feature, phone, canChange, onClose }: { feature: string; phone: boolean; canChange: boolean; onClose: () => void }) {
  const { data, loading, reload } = useQuery("simple-roadmap:feature-panel", () => unwrap(api.GET("/v1/simple/roadmap", {})));
  const items = useMemo(() => new Map((data?.items ?? []).map((i: Item) => [i.id, i])), [data]);
  const item = items.get(feature) ?? [...items.values()].find((i) => i.title === feature || i.key === feature);
  const act: Act = useCallback(
    async (_what, body) => {
      try {
        await propose(body);
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
