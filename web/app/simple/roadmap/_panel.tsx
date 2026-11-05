"use client";
// The Simple item panel outside the roadmap: a page that lists a feature (Priorities' goal
// buckets) opens the same panel the Timeline does, with the same card, so the feature can be
// read and changed where it is listed.

import { useCallback, useEffect } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { CARD_CHANGED_EVENT } from "@/lib/api/simple-chat";
import { useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { FloatingCard, type Act } from "./_card";
import { ChangeFailed, changedWords, decide, nearWords, propose, resultWords, setRoadmapToday, suggestion, undo, type Change, type Item } from "./_lib";

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

/** The feature's item panel (a side panel; a phone's bottom sheet), as the roadmap opens it. */
export function FeaturePanel({
  feature,
  phone,
  canChange,
  onClose,
}: {
  feature: { code: string; name: string; prd?: { id: string; slug: string } | null };
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
  // home-waiting-one-list: an action here may change what waits on me: the rail reads again.
  const reload = useCallback(async () => {
    invalidateWaiting();
    const done = Promise.all([roadmap.reload(), proposals.reload()]);
    waitingChanged();
    await done;
  }, [roadmap, proposals]);
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener(CARD_CHANGED_EVENT, on);
    return () => window.removeEventListener(CARD_CHANGED_EVENT, on);
  }, [reload]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = roadmap.data;
  const items = data?.items ?? [];
  const item = itemFor(items, feature);
  const act: Act = useCallback(
    async (what, body) => {
      try {
        const r = await propose(body);
        toast({
          message: resultWords(r, what, item?.deciders),
          action: r.change.status === "applied" && r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reload, (e) => toast({ message: String(e.message) })) } : undefined,
        });
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
  const onSuggestion = async (how: "accept" | "edit" | "dismiss", dates?: { start_date: string; end_date: string }) => {
    if (!item?.suggestion) return;
    try {
      await suggestion(item.suggestion.id, how, dates);
      toast({ message: how === "dismiss" ? "Dismissed Oracle's dates" : item.suggestion.can_decide ? "Dates accepted in your working draft" : "Dates proposed: they wait in Needs a decision" });
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not do that" });
    }
    await reload();
  };
  const onDecide = async (c: Change, how: "accept" | "decline") => {
    try {
      await decide(c.id, how);
      toast({ message: how === "accept" ? "Accepted: it is in your working draft" : "Declined" });
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
      onSuggestion={(how, dates) => void onSuggestion(how, dates)}
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
