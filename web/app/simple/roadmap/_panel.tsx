"use client";
// The Simple item panel outside the roadmap: a page that lists a feature (Priorities' goal
// buckets) opens the same panel the Timeline does, with the same card, so the feature can be
// read and changed where it is listed.

import { useCallback, useEffect, useState } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { GOAL_OPS, sendCardChanged, sendGoalChanged } from "@/lib/api/simple-chat";
import { useQuery } from "@/lib/use-query";

import { FloatingCard, type Act } from "./_card";
import { ChangeFailed, changedWords, decide, nearWords, propose, resultWords, setRoadmapToday, undo, type Change, type Item } from "./_lib";

const toast = (ask: ToastAsk) => dsToast({ place: "corner", ...ask });

/** Which roadmap item is the feature: its code in the plan's PRD, else its code, else its name. */
export function itemFor(items: Item[], f: { code: string; name: string; prd?: { id: string; slug: string } | null }): Item | undefined {
  const same = (i: Item) => !!i.code && i.code.toLowerCase() === f.code.toLowerCase();
  return (
    items.find((i) => same(i) && !!f.prd && (i.prd?.id === f.prd.id || i.prd?.slug === f.prd.slug)) ??
    items.find(same) ??
    items.find((i) => i.title === f.name)
  );
}

/** What opens the panel: a roadmap item's id when the page has it, else its code, PRD and name. */
export type PanelFeature = { id?: string | null; code: string; name: string; prd?: { id: string; slug: string } | null };

/**
 * The item a panel shows: the one it moved to (a dependency), else the one it showed first (kept
 * after a rename), else the item of the feature's id when its name is the card's, else the item
 * with its code, then its name. Never another feature's item under a wrong id.
 */
export function usePanelItem(items: Item[], feature: PanelFeature, opened: string | null): Item | undefined {
  const [pinned, setPinned] = useState<string | null>(null);
  const byId = (id?: string | null) => (id ? items.find((i) => i.id === id) : undefined);
  const own = byId(feature.id);
  const found = byId(opened) ?? byId(pinned) ?? (own && own.title === feature.name ? own : undefined) ?? itemFor(items, feature);
  if (found && !opened && !pinned) setPinned(found.id);
  return found;
}

/** The feature's item panel (a side panel; a phone's bottom sheet), as the roadmap opens it. */
export function FeaturePanel({
  feature,
  phone,
  canChange,
  onClose,
}: {
  feature: PanelFeature;
  phone: boolean;
  canChange: boolean;
  onClose: () => void;
}) {
  const roadmap = useQuery("simple-roadmap:{}", () =>
    unwrap(api.GET("/v1/simple/roadmap", {})).then((d) => {
      setRoadmapToday(d.today);
      return d;
    }),
  );
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  // build-feature-panel (AN PR 1204 review 7): a change made here is said to the whole page
  // (every query reads again, this panel's among them), so the page behind shows it at once.
  const reload = useCallback(async () => sendCardChanged(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = roadmap.data;
  const items = data?.items ?? [];
  // one-feature-panel: a dependency (or a feature that needs this one) opens in its place.
  const [opened, setOpened] = useState<string | null>(null);
  const item = usePanelItem(items, feature, opened);
  const act: Act = useCallback(
    async (what, body) => {
      try {
        const r = await propose(body);
        toast({
          message: resultWords(r, what, item?.deciders),
          action:
            r.change.status === "applied" && r.change.can_undo
              ? {
                  label: "Undo",
                  onClick: () =>
                    void undo(r.change.id).then(
                      () => {
                        if (GOAL_OPS.includes(body.op)) sendGoalChanged();
                        return reload();
                      },
                      (e) => toast({ message: String(e.message) }),
                    ),
                }
              : undefined,
        });
        if (r.change.status === "applied" && GOAL_OPS.includes(body.op)) sendGoalChanged();
      } catch (e) {
        if (e instanceof ChangeFailed && e.status === 409) {
          const changed = changedWords(e.changed);
          toast({ message: `${e.message}${changed.length ? ` (its ${changed.join(" and ")})` : ""}. Reload to see the latest, then try again.` });
        } else toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
      } finally {
        await reload();
      }
    },
    [item, reload],
  );
  const onDecide = async (c: Change, how: "accept" | "decline") => {
    try {
      await decide(c.id, how);
      toast({ message: how === "accept" ? "Accepted: it is in your working draft" : "Declined" });
      if (how === "accept" && GOAL_OPS.includes(c.op)) sendGoalChanged();
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not decide it" });
    }
    await reload();
  };

  const body = !data ? (
    <p className="p-4 text-[15px] text-text2">{roadmap.error ?? "Loading…"}</p>
  ) : !item ? (
    <div className="p-4">
      <h2 className="text-[18px] font-[650]">{feature.name}</h2>
      <p className="mt-1 text-[15px] text-text2">This feature is not on a roadmap you can see yet.</p>
      <button type="button" className="mt-3 text-[15px] font-[650] text-accent-ink underline" onClick={onClose}>
        Close
      </button>
    </div>
  ) : (
    <FloatingCard
      key={item.id}
      item={item}
      items={new Map(items.map((i) => [i.id, i]))}
      proposals={(proposals.data ?? []).filter((c) => c.target.item_id === item.id)}
      phone={phone}
      style={phone ? { height: "52dvh" } : { position: "relative", left: 0, top: 0, width: "100%", border: 0, boxShadow: "none" }}
      act={act}
      canChange={canChange}
      onDecide={(c, how) => void onDecide(c, how)}
      onClose={onClose}
      near={nearWords(item, data.key_dates ?? [])}
      onOpen={setOpened}
    />
  );
  if (phone && item) return <div data-testid="item-panel" aria-label={item.title} className="contents">{body}</div>;
  return (
    <aside
      data-testid="item-panel"
      aria-label={item?.title ?? feature.name}
      className={
        phone
          ? "fixed inset-x-0 bottom-0 z-40 rounded-t-xl border border-line bg-surface shadow-tip"
          : "fixed right-3 top-3 z-40 max-h-[calc(100dvh-24px)] w-[400px] overflow-y-auto rounded-xl border border-line bg-surface shadow-tip"
      }
    >
      {body}
    </aside>
  );
}
