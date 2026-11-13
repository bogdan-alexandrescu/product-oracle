"use client";

/**
 * The item panel Simple already has (the roadmap's FloatingCard), opened on the Goal map for
 * a feature: its details, dependencies both ways, dates, goal and how it is measured, each
 * editable there through the change engine, as on Simple Roadmap.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FloatingCard, type Act } from "../roadmap/_card";
import { usePanelItem } from "../roadmap/_panel";
import { ChangeFailed, changedWords, decide, propose, resultWords, undo, type Change } from "../roadmap/_lib";

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

/** Where the ladder places a feature: the goal and the milestone its card sits under. */
export interface Placement {
  goal: { id: string; title: string; metric: string | null; target: string | null; position: number };
  milestone: string;
  /** Every milestone of the goal it serves, each with its expected lift there ("" for none). */
  served?: { milestone: string; expected: string }[];
}

export function FeaturePanel({ id, code, name, placed, onClose }: { id: string; code?: string; name: string; placed?: Placement | null; onClose: () => void }) {
  const { can } = useMe();
  const phone = usePhone();
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const reload = useCallback(async () => {
    await Promise.all([roadmap.reload(), proposals.reload()]);
  }, [roadmap, proposals]);
  const byId = useMemo(() => new Map((roadmap.data?.items ?? []).map((i) => [i.id, i])), [roadmap.data]);
  // one-feature-panel: a dependency (or a feature that needs this one) opens in its place.
  const [opened, setOpened] = useState<string | null>(null);
  // one-feature-panel: the card's own item (its name checked; else its code, then its name).
  const found = usePanelItem(roadmap.data?.items ?? [], { id, code: code ?? "", name }, opened);
  // goal-ladder L-2: a feature the ladder places under a goal's milestone reads that goal here,
  // so the panel and its card agree (the item's own goal, when it has one, stays).
  const own = !!found && found.id === id && !!placed;
  const item = useMemo(() => (found && own && !found.goal ? { ...found, goal: { ...placed!.goal, key: placed!.goal.id, due: null } } : found), [found, own, placed]);
  const act: Act = useCallback(
    async (what, body, note) => {
      try {
        const r = await propose(body);
        toast({
          message: resultWords(r, what, item?.deciders, note),
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
    [reload, item],
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
          onOpen={setOpened}
          milestones={roadmap.data.goal_milestones}
          planned={roadmap.data.milestones}
          // GM2: the milestone the map shows the chip under, and its Serves line inside the card's scroll.
          served={own ? placed!.milestone : null}
          after={own && (
          <p data-testid="gm-panel-milestone" className="simple-small mt-3 w-fit rounded-xl border border-line bg-surface px-3 py-1">
            Serves{" "}
            {(placed!.served ?? [{ milestone: placed!.milestone, expected: "" }]).map((x, i) => (
              <span key={x.milestone}>
                {i > 0 && " · "}
                {x.milestone}
                {x.expected && (
                  <>
                    {" "}(<span data-user-content>{x.expected}</span>)
                  </>
                )}
              </span>
            ))}
          </p>
          )}
        />
      </div>
    </div>
  );
}
