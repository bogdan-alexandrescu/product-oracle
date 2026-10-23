"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, SegmentedControl } from "@/components/ds";
import { INPUT } from "@/components/ui";

import { day, doneText, horizonLabel, HORIZONS, openReasons, resolutionText, show, waivable, type Item, type Mode, type Review } from "./_items-lib";
import { FixButton, RowForm, type Form, type Ops } from "./_items-review";

const OUTCOME_MAX = 500;

/**
 * D1: one roadmap item in the review's inspector: a dark head, the Item tab (its reasons as
 * cards with their fixes, Horizon, Outcome, Milestone, Depends on, rank, From the PRD) and
 * the History tab (this attempt's changes and answers, who staged or suggested what).
 */
export function ItemsInspector({
  item,
  items,
  count,
  review,
  mode,
  ops,
  form,
  setForm,
  prd,
  meId,
}: {
  item: Item;
  items: Item[];
  count: number;
  review: Review;
  mode: Mode;
  ops: Ops;
  form: Form;
  setForm: (f: Form) => void;
  prd: { slug: string; version: number } | null;
  meId: string | null;
}) {
  const [tab, setTab] = useState<"item" | "history">("item");
  const [editing, setEditing] = useState<string | null>(null);
  const titleOf = (key: string) => items.find((x) => x.key === key)?.title ?? key;
  const open = openReasons(item);
  const edit = mode !== "viewer" && item.position != null;
  const staged = (field: string) => item.actions.find((a) => a.kind === "edit" && a.field === field && (a.state === "staged" || a.created_by?.id === meId));
  const horizon = (staged("horizon")?.value as string | undefined) ?? item.horizon ?? "now";
  const outcome = (staged("outcome")?.value as string | undefined) ?? item.outcome ?? "";
  const removedDeps = ((staged("depends_on")?.value as { remove?: string[] } | undefined)?.remove ?? []) as string[];
  const dateGone = !!item.actions.find((a) => a.kind === "edit" && a.field === "milestone_date" && a.value == null);
  const act = ops.act;
  return (
    <aside className="overflow-hidden rounded-panel border border-line bg-surface" aria-label={`Item ${item.title ?? item.key}`} data-testid="item-inspector">
      <header className="bg-[#1f2430] px-4 py-3 text-white">
        <p className="text-[13px] text-white/80">
          Item {item.position ?? "—"} of {count} · selected
        </p>
        <h2 className="text-lg font-semibold break-words">{item.title ?? item.key}</h2>
        <p className="mt-1 flex flex-wrap gap-1.5">
          {item.horizon && <Chip hero>{horizonLabel(item.horizon)}</Chip>}
          {item.milestone?.name && <Chip hero>{item.milestone.name}</Chip>}
          {item.rank != null && <Chip hero>rank {item.rank}</Chip>}
        </p>
      </header>
      <div className="border-b border-line px-4 py-2">
        <SegmentedControl<"item" | "history">
          label="Inspector tab"
          size="sm"
          value={tab}
          onChange={setTab}
          items={[
            { value: "item", label: "Item" },
            { value: "history", label: "History" },
          ]}
        />
      </div>
      {tab === "item" ? (
        <div className="flex flex-col gap-4 px-4 py-3">
          {item.reasons.length > 0 && (
            <section aria-label="Needs you because">
              <h3 className="mb-1.5 text-sm font-semibold">Needs you because</h3>
              <ul className="flex flex-col gap-2">
                {item.reasons.map((r) => {
                  const isOpen = open.includes(r);
                  const by = item.actions.find((a) => a.state === "staged" && a.kind !== "question" && (a.kind === "waive" || !a.answers.length || a.answers.includes(r.code)));
                  return (
                    <li key={r.code} className="rounded-button border border-line p-2.5" data-testid="reason-card">
                      <Chip kind={!isOpen ? "na" : r.severity === "blocking" ? "crit" : "warn"} wrap>
                        {r.severity === "blocking" ? "Blocking" : "To confirm"} · {r.label}
                      </Chip>
                      <p className="mt-1.5 text-sm break-words">{r.text}</p>
                      {!isOpen && by ? (
                        <p className="mt-1.5 flex items-center gap-2 text-sm font-medium text-pass">
                          ✓ {doneText(by, titleOf)}
                          {(mode === "approver" || by.created_by?.id === meId) && (
                            <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => void ops.remove(by.id)}>
                              Undo
                            </Button>
                          )}
                        </p>
                      ) : (
                        mode !== "viewer" && (
                          <p className="mt-1.5 flex flex-wrap gap-1.5">
                            {r.fixes
                              .filter((f) => f.action.kind !== "waive")
                              .map((f, i) => (
                                <FixButton key={f.label} fix={f} reason={r} mode={mode} ops={ops} primary={i === 0} />
                              ))}
                            {mode === "approver" && waivable(r) && (
                              <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "waive", code: r.code, where: "inspector" })}>
                                Waive…
                              </Button>
                            )}
                          </p>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {form && <RowForm it={item} form={form} mode={mode} ops={ops} onDone={() => setForm(null)} />}
          <section aria-label="Horizon">
            <h3 className="mb-1.5 text-sm font-semibold">Horizon</h3>
            {edit ? (
              <SegmentedControl<string>
                label="Horizon"
                size="sm"
                value={horizon}
                onChange={(h) => void act({ item_key: item.key, kind: "edit", field: "horizon", value: h, answers: [] })}
                items={HORIZONS.map((h) => ({ value: h, label: horizonLabel(h) }))}
              />
            ) : (
              <p className="text-sm">{horizonLabel(item.horizon)}</p>
            )}
          </section>
          <section aria-label="Outcome">
            <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
              Outcome
              {edit && editing !== "outcome" && (
                <Button variant="ghost" className="h-7 px-2 text-sm" aria-label="Edit outcome" onClick={() => setEditing("outcome")}>
                  Edit
                </Button>
              )}
            </h3>
            {editing === "outcome" ? (
              <OutcomeEdit
                value={outcome}
                onCancel={() => setEditing(null)}
                onSave={async (v) => {
                  await act({ item_key: item.key, kind: "edit", field: "outcome", value: v, answers: [] });
                  setEditing(null);
                }}
              />
            ) : (
              <p className="text-sm break-words">{outcome || "—"}</p>
            )}
          </section>
          <section aria-label="Milestone">
            <h3 className="mb-1.5 text-sm font-semibold">Milestone</h3>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              {item.milestone?.name ?? "None"}
              {item.milestone?.date && (dateGone ? <s>{day(item.milestone.date)}</s> : <span>{day(item.milestone.date)}</span>)}
              {edit && item.milestone?.date && !dateGone && (
                <Button className="h-8 px-2.5 text-sm" onClick={() => void act({ item_key: item.key, kind: "edit", field: "milestone_date", value: null, answers: [] })}>
                  Remove date
                </Button>
              )}
            </p>
          </section>
          <section aria-label="Depends on">
            <h3 className="mb-1.5 text-sm font-semibold">Depends on</h3>
            {item.depends_on.length === 0 ? (
              <p className="text-sm text-text2">Nothing</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {item.depends_on.map((d) => {
                  const gone = removedDeps.includes(d);
                  const dep = items.find((x) => x.key === d);
                  return (
                    <li key={d} className="flex items-center gap-2 text-sm">
                      <span className={gone ? "line-through text-text2" : ""}>{titleOf(d)}</span>
                      {dep?.horizon && <Chip kind="line">{horizonLabel(dep.horizon)}</Chip>}
                      {edit && !gone && (
                        <Button
                          variant="ghost"
                          className="h-7 w-7 justify-center px-0"
                          aria-label={`Remove dependency ${titleOf(d)}`}
                          onClick={() => void act({ item_key: item.key, kind: "edit", field: "depends_on", value: { add: [], remove: [...removedDeps, d] }, answers: [] })}
                        >
                          ×
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {item.rank != null && (
            <section aria-label={`Why rank ${item.rank}`}>
              <h3 className="mb-1.5 text-sm font-semibold">Why rank {item.rank}</h3>
              <p className="text-sm text-text2">Ranked {item.rank} in the priority order this run read.</p>
            </section>
          )}
          {item.prd_section && (
            <section aria-label="From the PRD">
              <h3 className="mb-1.5 text-sm font-semibold">From the PRD</h3>
              {prd ? (
                <Link href={`/documents/${prd.slug}/v/${prd.version}#${item.prd_section}`} className="text-sm text-accent-ink hover:underline">
                  {item.prd_section}
                </Link>
              ) : (
                <p className="text-sm">{item.prd_section}</p>
              )}
            </section>
          )}
          {edit && (
            <footer className="flex flex-wrap gap-2 border-t border-line pt-3">
              <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "ask", where: "inspector" })}>
                Ask a teammate…
              </Button>
              <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "split", where: "inspector" })}>
                Split…
              </Button>
              <Button className="h-8 px-2.5 text-sm" onClick={() => void act({ item_key: item.key, kind: "drop", answers: open.map((r) => r.code) })}>
                Drop
              </Button>
            </footer>
          )}
        </div>
      ) : (
        <History item={item} review={review} titleOf={titleOf} />
      )}
    </aside>
  );
}

function OutcomeEdit({ value, onSave, onCancel }: { value: string; onSave: (v: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(value);
  return (
    <div className="flex flex-col gap-2">
      <textarea aria-label="Outcome" value={text} maxLength={OUTCOME_MAX} rows={3} onChange={(e) => setText(e.target.value)} className={INPUT} />
      <span className="flex gap-2">
        <Button variant="solid" disabled={!text.trim() || text === value} onClick={() => void onSave(text.trim())}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

/** This attempt's changes to the item and its answer to the review (D6), and the draft's actions on it (D8). */
function History({ item, review, titleOf }: { item: Item; review: Review; titleOf: (k: string) => string }) {
  const empty = !item.diff.length && !item.resolution && !item.actions.length;
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm" data-testid="item-history">
      {empty && <p className="text-text2">Nothing changed on this item in attempt {review.attempt ?? 1}.</p>}
      {item.resolution && (
        <p>
          The agents&apos; answer to the review: <Chip kind={item.resolution.outcome === "done" ? "pass" : "warn"} wrap>{resolutionText(item.resolution)}</Chip>
        </p>
      )}
      {item.diff.length > 0 && (
        <ul className="flex flex-col gap-1">
          {item.diff.map((d) => (
            <li key={d.field} className="break-words">
              {d.field}: <s>{show(d.from)}</s> → {show(d.to)}
            </li>
          ))}
        </ul>
      )}
      {item.actions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {item.actions.map((a) => (
            <li key={a.id}>
              {a.created_by?.name ?? "Someone"} {a.state === "staged" ? "staged" : "suggested"}: {a.kind === "question" ? `asked ${a.question?.asked_to?.name ?? "a teammate"}` : doneText(a, titleOf)}
              {a.question?.answer?.body && <span className="block text-text2">Answer: {a.question.answer.body}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
