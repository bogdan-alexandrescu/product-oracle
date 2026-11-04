"use client";

/**
 * The item panel Simple already has (the roadmap's FloatingCard), opened on the Goal map for
 * a feature: its details, dependencies both ways, dates, goal and how it is measured, each
 * editable there through the change engine, as on Simple Roadmap.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FloatingCard, type Act } from "../roadmap/_card";
import { ChangeFailed, decide, propose, resultWords, type Change } from "../roadmap/_lib";

const toast = (ask: ToastAsk) => dsToast({ place: "corner", ...ask });

const PHONE = "(max-width: 600px)";
function usePhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

export function FeaturePanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { can } = useMe();
  const phone = usePhone();
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const reload = useCallback(async () => {
    await Promise.all([roadmap.reload(), proposals.reload()]);
  }, [roadmap, proposals]);
  const byId = useMemo(() => new Map((roadmap.data?.items ?? []).map((i) => [i.id, i])), [roadmap.data]);
  const item = byId.get(id);
  const act: Act = useCallback(
    async (what, body) => {
      try {
        const r = await propose(body);
        toast({ message: resultWords(r, what, item?.deciders) });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
      } finally {
        await reload();
      }
    },
    [reload, item?.deciders],
  );
  const onDecide = useCallback(
    async (c: Change, how: "accept" | "decline") => {
      try {
        await decide(c.id, how);
        toast({ message: how === "accept" ? "Accepted: it is in your working draft" : "Declined" });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not decide it" });
      }
      await reload();
    },
    [reload],
  );
  if (!roadmap.data) return null;
  if (!item)
    return (
      <div role="dialog" aria-label={name} data-testid="gm-feature-panel-missing" className="simple-card fixed right-6 bottom-6 z-40 w-[390px] max-w-[calc(100vw-24px)]">
        <span className="font-semibold">{name}</span>
        <span className="simple-small">This feature is not on a roadmap you can see yet.</span>
        <button type="button" className="simple-button self-end" onClick={onClose}>
          Close
        </button>
      </div>
    );
  return (
    <div className="fixed inset-0 z-40" data-testid="gm-feature-panel">
      <button type="button" aria-label="Close the feature" className="absolute inset-0 cursor-default bg-black/10" onClick={onClose} />
      <div className="absolute top-6 right-6 max-[600px]:inset-x-0 max-[600px]:top-auto max-[600px]:bottom-0">
        <FloatingCard
          key={item.id}
          item={item}
          items={byId}
          proposals={(proposals.data ?? []).filter((c) => c.target.item_id === item.id)}
          phone={phone}
          style={phone ? {} : { position: "relative", left: 0, top: 0 }}
          act={act}
          canChange={can("create_simple_change")}
          onDecide={(c, how) => void onDecide(c, how)}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
