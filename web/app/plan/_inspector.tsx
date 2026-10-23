"use client";

import { useState } from "react";

import { Button, Chip, GoalTag, Inspector, InspectorSection, LinkButton, Notice, ToGo } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { assess, type GoalView, type Point } from "../home/_goals";
import { HORIZON_LABEL, roadmapHref, stateChip, whoLabel, type PlanItem } from "./_lib";

function History({ item }: { item: PlanItem }) {
  const q = useQuery(`plan|history|${item.roadmap.slug}|${item.key}`, () =>
    unwrap(api.GET("/v1/plan/items/history", { params: { query: { roadmap: item.roadmap.slug, item: item.key } } })),
  );
  if (q.error) return <span className="text-text2">{q.error}</span>;
  if (!q.data) return <span className="text-text2">…</span>;
  if (q.data.versions.length === 0) return <span className="text-text2">—</span>;
  return (
    <ol className="flex flex-col gap-1 text-[15px]">
      {q.data.versions.map((v) => (
        <li key={v.version} className="tnum">
          PRD v{v.prd_version ?? "?"} {HORIZON_LABEL[v.horizon]}
          {v.approved_at ? ` · approved ${formatDay(v.approved_at)}` : ""}
        </li>
      ))}
    </ol>
  );
}

const RECORD_STATE: Record<PlanItem["engineering"]["records"][number]["state"], string> = {
  todo: "Open",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** F7 What the actions need: set only for approvers, owners and engineering leads. */
export type PlanLinks = { onLink: (item: PlanItem) => void; onChanged: () => Promise<void> | void };

/** The item's tracker issues, one per line; Link issue and Unlink for those who may (F7). */
function Engineering({ item, links }: { item: PlanItem; links?: PlanLinks }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const records = item.engineering.records;
  async function unlink(id: string) {
    setBusy(id);
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/tracker/links/{record_id}", { params: { path: { record_id: id } } }));
      await links?.onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {records.length === 0 && <span className="text-[15px] text-text2">No tracker issue</span>}
      {records.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {records.map((r) => (
            <li key={`${r.tracker}|${r.external_ref}`} data-testid="plan-record" className="flex min-w-0 items-center gap-2 text-[15px]">
              <span className="tnum min-w-0 flex-1 truncate">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline-offset-2 hover:underline">
                    {r.external_ref}
                  </a>
                ) : (
                  <b className="font-semibold">{r.external_ref}</b>
                )}
                <span className="text-text2">
                  {` · ${RECORD_STATE[r.state]} · ${r.target_date ? formatDay(`${r.target_date}T12:00:00Z`) : "no date"}`}
                </span>
              </span>
              {links && r.tracker === "github" && r.id && (
                <Button className="flex-none" disabled={busy === r.id} onClick={() => unlink(r.id!)}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {links && item.prd && (
        <Button variant="ghost" className="self-start" onClick={() => links.onLink(item)}>
          + Link issue
        </Button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** The selected item (F1 §8): why it needs someone, its history, its goals, and where to open it. */
export function PlanInspector({
  item,
  goals,
  history,
  me,
  links,
}: {
  item: PlanItem;
  goals: Map<string, GoalView>;
  history: Map<string, Point[]>;
  me: string | null | undefined;
  links?: PlanLinks;
}) {
  const state = stateChip(item);
  const served = item.goal_ids.map((id) => goals.get(id)).filter((g): g is GoalView => !!g);
  const record = item.engineering.records[0];
  const who = whoLabel(item.next.who, me);
  const version = item.prd?.version;
  return (
    <Inspector
      eyebrow="Item · selected"
      title={item.title}
      label={`Item ${item.title}`}
      testId="plan-inspector"
      chips={
        <>
          <Chip hero kind={item.horizon === "now" ? "now" : "na"}>
            {HORIZON_LABEL[item.horizon]}
          </Chip>
          <Chip hero>{state.label}</Chip>
          {version != null && <Chip hero>{item.prd?.approved ? `PRD v${version}` : `Draft ${version}`}</Chip>}
        </>
      }
    >
      <InspectorSection label="Why it needs you" testId="plan-why">
        <div className="flex flex-col gap-2">
          {item.reasons.map((r, n) => (
            <div key={n} className="rounded-lg border border-line bg-surface2 px-3 py-2 text-[15px]">
              {r.detail}
            </div>
          ))}
          {item.next.action ? (
            <p className="text-[15px]">
              <b className="font-semibold">{item.next.label}</b>
              {who && <span className="text-text2"> · {who}</span>}
            </p>
          ) : (
            item.reasons.length === 0 && <p className="text-[15px] text-text2">Nothing to decide</p>
          )}
        </div>
      </InspectorSection>
      <InspectorSection label="Engineering" testId="plan-item-engineering">
        <Engineering item={item} links={links} />
      </InspectorSection>
      <InspectorSection label="History" testId="plan-history">
        <History key={`${item.roadmap.slug}|${item.key}`} item={item} />
      </InspectorSection>
      <InspectorSection label="Goal" testId="plan-item-goal">
        {served.length === 0 ? (
          <span className="font-semibold text-warn">No goal</span>
        ) : (
          <ul className="flex flex-col gap-2">
            {served.map((g) => {
              const p = assess(g, history.get(g.id));
              return (
                <li key={g.id} className="flex min-w-0 items-center gap-2 text-[15px]">
                  <GoalTag id={g.tag} proposed={g.proposed} />
                  <span className="min-w-0 flex-1 truncate">{g.title}</span>
                  <span className="flex-none text-text2">{p.state === "togo" ? <ToGo amount={p.amount!} unit={p.unit} /> : p.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection>
        <div className="flex flex-wrap gap-2">
          {item.prd?.link && <LinkButton href={item.prd.link}>Open in PRD</LinkButton>}
          <LinkButton href={roadmapHref(item)}>Open in roadmap</LinkButton>
          {record?.url && (
            <a
              href={record.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center rounded-button border border-line-strong px-3.5 text-[15px] font-semibold hover:bg-surface2"
            >
              Tracker ↗
            </a>
          )}
        </div>
      </InspectorSection>
    </Inspector>
  );
}
