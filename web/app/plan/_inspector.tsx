"use client";

import { useEffect, useState } from "react";

import { DateBasisDialog, shortDay, useDateRights } from "@/components/DateBasisDialog";
import { Button, Chip, GoalTag, Inspector, InspectorSection, LinkButton, Notice, ToGo } from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { api, unwrap } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { assess, type GoalView, type Point } from "../home/_goals";
import { dateBasis, HORIZON_LABEL, roadmapHref, stateChip, whoLabel, type PlanItem } from "./_lib";

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

/**
 * F3: the item's date and what it rests on: "Nov 30 ✓ ENG-412, verified by <name>", "Nov 30 ·
 * unverified" with Verify date, or the struck date, "date withdrawn" and the reason with Re-verify date.
 */
function DateLine({ item, onChanged }: { item: PlanItem; onChanged?: () => void }) {
  const { date, date_status } = item.engineering;
  const prd = item.prd?.id;
  const bases = useQuery(`schedule-bases|prd|${prd}`, () => unwrap(api.GET("/v1/schedule-bases", { params: { query: { prd } } })));
  const rights = useDateRights();
  const basis = dateBasis(item, bases.data ?? []);
  const by = basis && (date_status === "withdrawn" ? basis.withdrawn_by : basis.verified_by);
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!by) return;
    peopleByIds([by])
      .then((people) => setName(people.get(by)?.name ?? null))
      .catch(() => setName(null));
  }, [by]);
  if (!date) return null;
  const day = shortDay(date);
  const may = !!rights.data?.rights && !!prd;
  const action = date_status === "unverified" ? "Verify date" : date_status === "withdrawn" ? "Re-verify date" : null;
  return (
    <InspectorSection label="Date" testId="plan-date">
      <div className="flex flex-col gap-2 text-[15px]">
        {date_status === "withdrawn" ? (
          <p>
            <s className="tnum">{day}</s> <span className="font-semibold text-warn">date withdrawn</span>
            {basis?.withdrawn_reason && (
              <span className="block text-text2">
                {basis.reference}: {basis.withdrawn_reason}
              </span>
            )}
          </p>
        ) : date_status === "verified" ? (
          <p className="tnum">
            {day} ✓{basis && ` ${basis.reference}, verified by ${name ?? "a member"}`}
          </p>
        ) : (
          <p className="tnum">
            {day} · {date_status ?? "no basis"}
          </p>
        )}
        {action && may && (
          <div>
            <Button onClick={() => setOpen(true)}>{action}</Button>
          </div>
        )}
      </div>
      {open && rights.data && (
        <DateBasisDialog
          prefill={{ prd, supports_date: date, item_key: item.key }}
          rights={rights.data}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await bases.reload();
            onChanged?.();
          }}
        />
      )}
    </InspectorSection>
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
  onChanged,
  links,
}: {
  item: PlanItem;
  goals: Map<string, GoalView>;
  history: Map<string, Point[]>;
  me: string | null | undefined;
  /** A date basis was recorded from the inspector: the plan reloads. */
  onChanged?: () => void;
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
      <DateLine item={item} onChanged={onChanged} />
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
