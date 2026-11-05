"use client";

/**
 * build-feature-panel: the one feature panel on every Simple page besides Roadmap (which
 * opens it from its own views). A click on any element marked `data-feature` (the item's id,
 * else its key, its code (F-06) or its title) opens the panel for that feature, read from the roadmap as the caller
 * reads it; changes made in it go through the change engine, as on Roadmap. After a change or
 * its Undo every query on the page reads again (sendCardChanged, build-feature-panel review 7).
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { toast } from "@/components/ds/Toast";
import { FloatingCard, proposalWords, type Act } from "@/app/simple/roadmap/_card";
import { ChangeFailed, changedWords, decide, deciderWords, propose, undo, type Change, type Item } from "@/app/simple/roadmap/_lib";
import { usePhone } from "@/components/simple/FlowViews";
import { api, unwrap } from "@/lib/api/client";
import { sendCardChanged } from "@/lib/api/simple-chat";
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
  // The name that opened the panel: Esc (or ×) gives the focus back to it.
  const opener = useRef<HTMLElement | null>(null);
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
      opener.current = el;
      setOpen(el.dataset.feature ?? null);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [roadmap]);
  // Opened from code on every page, Roadmap too (a goal panel's look-alike, build-feature-panel review 6).
  useEffect(() => {
    const onOpen = (e: Event) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen((e as CustomEvent<string>).detail || null);
    };
    document.addEventListener(OPEN_EVENT, onOpen);
    return () => document.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }));
  }, []);
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
  // review 7: the proposals waiting on it, listed in the panel (Accept and Decline for its decider).
  const waiting = useQuery("simple-proposals:feature-panel", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const items = useMemo(() => new Map((data?.items ?? []).map((i: Item) => [i.id, i])), [data]);
  const item = items.get(feature) ?? [...items.values()].find((i) => i.title === feature || i.key === feature || (!!i.code && i.code === feature));
  // Every query on the page reads again (this one too): the page behind and its counts show the change.
  const changed = useCallback(async () => {
    await Promise.all([reload(), waiting.reload()]);
    sendCardChanged();
  }, [reload, waiting]);
  const act: Act = useCallback(
    async (what, body, opts) => {
      const of = items.get(String(body.target?.item_id ?? ""));
      try {
        const r = await propose(body);
        if (r.change.status === "applied")
          // build-feature-panel review 3: the panel's own words once applied, with Undo, as the frames show.
          toast({ message: opts?.words ? await opts.words(r) : typeof what === "string" ? what : what.applied, action: r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(changed, (e) => toast({ message: String(e.message) })) } : undefined });
        // review 7: a proposal says what it asks and who decides it.
        else toast({ message: `Proposed: ${proposalWords(body.op, of?.title ?? "it")} · waiting for ${deciderWords(of?.deciders)}` });
      } catch (e) {
        if (e instanceof ChangeFailed && e.status === 409) {
          const what = changedWords(e.changed);
          toast({ message: `${e.message}${what.length ? ` (its ${what.join(" and ")})` : ""}. Reload to see the latest, then try again.` });
        } else toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
      } finally {
        await changed();
      }
    },
    [items, changed],
  );
  const onDecide = useCallback(
    async (c: Change, how: "accept" | "decline") => {
      try {
        await decide(c.id, how);
        toast({ message: how === "accept" ? "Accepted: it is in your working draft" : "Declined" });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not decide it" });
      }
      await changed();
    },
    [changed],
  );
  // No roadmap item matches (once loaded): say so in a toast and close, rather than doing nothing.
  useEffect(() => {
    if (loading || item) return;
    toast({ message: "This feature is not on a roadmap yet, so it has no panel." });
    onClose();
  }, [loading, item, onClose]);
  if (!item) return null;
  const proposals = (waiting.data ?? []).filter((c) => c.target.item_id === item.id);
  return <FloatingCard item={item} items={items} proposals={proposals} phone={phone} style={{}} act={act} canChange={canChange} onDecide={(c, how) => void onDecide(c, how)} onClose={onClose} />;
}
