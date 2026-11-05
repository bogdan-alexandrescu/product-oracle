"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Icon } from "@/components/ds/Icon";
import { Sheet } from "@/components/ds/Sheet";
import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

type Row = Schemas["SimpleDecisionRow"];
type Question = Schemas["SimpleQuestion"];
type Person = { id: string; name: string };

/** What the sheet shows: an open decision, a PRD's question, or a new one of either. */
export type SheetTarget =
  | { kind: "decision"; row: Row }
  | { kind: "question"; q: Question }
  | { kind: "new-decision" }
  | { kind: "new-question"; prds: { id: string; title: string }[] };

/** A decision or question withdrawn here this visit: struck through in its list, with Undo. */
type Withdrawn = { changeId: string; undoing?: boolean };

type SheetApi = {
  open: (t: SheetTarget) => void;
  withdrawn: Record<string, Withdrawn>;
  undoWithdraw: (id: string) => void;
};

const SheetContext = createContext<SheetApi | null>(null);

/** The sheet's opener on this page (null where no sheet is mounted: the row keeps its plain title). */
export function useDecisionSheet(): SheetApi | null {
  return useContext(SheetContext);
}

/** At most this many options or other answers (decision_sheet.MAX_OPTIONS). */
const MAX_OPTIONS = 6;
const FIELD =
  "w-full rounded-md border border-line-strong bg-surface px-3 text-[15px] text-text";
const REASSIGNED = "Reassigned in Simple";

/** "Dec 7, 2026". */
export const reviewDay = (day: string) =>
  calendarDay(day, { month: "short", day: "numeric", year: "numeric" });

/** "edited by you just now", "edited by Avery Stone Nov 3" (the row's last sheet edit). */
export function editedWords(
  at: string | null | undefined,
  by: Person | null | undefined,
  me: string | undefined,
): string | null {
  if (!at) return null;
  const who = by ? (by.id === me ? " by you" : ` by ${by.name}`) : "";
  const fresh = Date.now() - Date.parse(at) < 10 * 60_000;
  return `edited${who} ${fresh ? "just now" : calendarDay(at.slice(0, 10))}`;
}

/**
 * edit-decisions (the owner's picks, BGD Nov 5): ec1 b "Decision sheet" and eq2 b "Question
 * sheet". An open decision's or a PRD question's title opens this one side sheet (a bottom
 * sheet on a phone, as the feature panel): every field, who decides (Reassign for owners),
 * Edit (or Suggest a change, sent to who decides), Withdraw (the "not now", with Undo) and
 * Delete (to Settings › Trash, with Undo) at its foot, as the item's own `can` says. + New
 * decision and + Ask a question open it empty. `onChanged` reloads the page under it.
 */
export function DecisionSheetHost({
  onChanged,
  children,
}: {
  onChanged: () => unknown;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const [withdrawn, setWithdrawn] = useState<Record<string, Withdrawn>>({});
  const done = useCallback(() => {
    invalidateWaiting();
    void onChanged();
    waitingChanged();
  }, [onChanged]);
  const undoWithdraw = useCallback(
    (id: string) => {
      const w = withdrawn[id];
      if (!w) return;
      setWithdrawn((x) => ({ ...x, [id]: { ...w, undoing: true } }));
      void unwrap(
        api.POST("/v1/simple/changes/{change_id}/undo", {
          params: { path: { change_id: w.changeId } },
        }),
      )
        .then(() => {
          setWithdrawn(({ [id]: _, ...rest }) => rest);
          toast({ message: "Undone" });
        })
        .catch((e) => {
          setWithdrawn((x) => ({ ...x, [id]: w }));
          toast({ message: errorMessage(e) });
        })
        .finally(done);
    },
    [withdrawn, done],
  );
  const value = useMemo<SheetApi>(
    () => ({ open: setTarget, withdrawn, undoWithdraw }),
    [withdrawn, undoWithdraw],
  );
  const close = () => setTarget(null);
  const title =
    target?.kind === "decision"
      ? `${target.row.code ?? `D-${target.row.number}`} ${target.row.title}`
      : target?.kind === "question"
        ? `${target.q.code} ${target.q.title}`
        : target?.kind === "new-decision"
          ? "New decision"
          : "New question";
  return (
    <SheetContext.Provider value={value}>
      {children}
      <Sheet
        open={!!target}
        side
        title={title}
        onClose={close}
        testId="decision-sheet"
      >
        {target && (
          <SheetBody
            key={
              target.kind === "decision"
                ? target.row.id
                : target.kind === "question"
                  ? target.q.id
                  : target.kind
            }
            target={target}
            onClose={close}
            done={done}
            onWithdrawn={(id, changeId) =>
              setWithdrawn((x) => ({ ...x, [id]: { changeId } }))
            }
          />
        )}
      </Sheet>
    </SheetContext.Provider>
  );
}

type BodyProps = {
  target: SheetTarget;
  onClose: () => void;
  done: () => void;
  onWithdrawn: (id: string, changeId: string) => void;
};

/** The fields as the sheet edits them. */
type Draft = {
  title: string;
  question: string;
  context: string;
  options: string[];
  review_at: string;
  recommendation: string;
  decider: Person | null;
  prd: string;
};

function draftOf(t: SheetTarget): Draft {
  const blank: Draft = {
    title: "",
    question: "",
    context: "",
    options: ["", ""],
    review_at: "",
    recommendation: "",
    decider: null,
    prd: "",
  };
  if (t.kind === "decision") {
    const r = t.row;
    return {
      ...blank,
      title: r.title,
      question: r.question ?? "",
      context: r.context ?? "",
      options: r.options.map((o) => o.label),
      review_at: r.review_at ?? "",
      decider: r.approver ?? null,
    };
  }
  if (t.kind === "question")
    return {
      ...blank,
      title: t.q.title,
      recommendation: t.q.recommendation ?? "",
      options: t.q.alternatives.map((o) => o.label),
      decider: t.q.decider ?? null,
    };
  if (t.kind === "new-question")
    return { ...blank, options: [""], prd: t.prds[0]?.id ?? "" };
  return blank;
}

function SheetBody({ target, onClose, done, onWithdrawn }: BodyProps) {
  const isNew =
    target.kind === "new-decision" || target.kind === "new-question";
  const question = target.kind === "question" || target.kind === "new-question";
  const can =
    target.kind === "decision"
      ? target.row.can
      : target.kind === "question"
        ? target.q.can
        : null;
  const writes = !!can && (can.edit || can.propose);
  const [editing, setEditing] = useState(isNew);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(target));
  const [decider, setDecider] = useState<Person | null>(
    draftOf(target).decider,
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const id =
    target.kind === "decision"
      ? target.row.id
      : target.kind === "question"
        ? target.q.id
        : null;
  const name =
    target.kind === "decision"
      ? `${target.row.code ?? `D-${target.row.number}`}`
      : target.kind === "question"
        ? target.q.code
        : "";
  const decidesName = decider?.name ?? null;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const change = (body: Schemas["SimpleChangeIn"]) =>
    unwrap(api.POST("/v1/simple/changes", { body }));

  const save = () =>
    act(async () => {
      const options = draft.options.map((o) => o.trim()).filter(Boolean);
      if (!draft.title.trim())
        throw new Error(question ? "Write the question" : "Write a title");
      if (target.kind === "new-decision") {
        if (!decider) throw new Error("Pick who decides");
        await unwrap(
          api.POST("/v1/decisions", {
            body: {
              title: draft.title.trim(),
              question: draft.question.trim() || null,
              context: draft.context.trim() || null,
              options: options.map((label, i) => ({ key: `o${i + 1}`, label, pros: [], cons: [], evidence_ids: [], recommended: false })),
              approver_id: decider.id,
              review_at: draft.review_at || null,
            },
          }),
        );
        toast({ message: `Added ${draft.title.trim()}` });
      } else if (target.kind === "new-question") {
        const r = await change({
          op: "add_question",
          target: { document_id: draft.prd },
          before: {},
          after: {
            title: draft.title,
            recommendation: draft.recommendation.trim() || null,
            alternatives: options,
          },
        });
        const prd =
          target.prds.find((p) => p.id === draft.prd)?.title ?? "the PRD";
        toast({
          message:
            r.change.status === "proposed"
              ? "Sent to who decides on the PRD"
              : `Added to ${prd}`,
        });
      } else if (target.kind === "decision") {
        const r = target.row;
        const now = {
          title: r.title,
          question: r.question ?? null,
          context: r.context ?? null,
          options: r.options.map((o) => o.label),
          review_at: r.review_at ?? null,
        };
        const next = {
          title: draft.title.trim(),
          question: draft.question.trim() || null,
          context: draft.context.trim() || null,
          options,
          review_at: draft.review_at || null,
        };
        const after = Object.fromEntries(
          Object.entries(next).filter(
            ([k, v]) =>
              JSON.stringify(v) !== JSON.stringify(now[k as keyof typeof now]),
          ),
        );
        if (!Object.keys(after).length) return setEditing(false);
        const c = (
          await change({
            op: "edit_decision",
            target: { decision_id: r.id },
            before: Object.fromEntries(
              Object.keys(after).map((k) => [k, now[k as keyof typeof now]]),
            ),
            after,
          })
        ).change;
        toast(
          c.status === "proposed"
            ? { message: `Sent to ${decidesName ?? "the owners"} to decide` }
            : undoable(`Saved ${name}`, c.id, done),
        );
      } else if (target.kind === "question") {
        const q = target.q;
        const now = {
          title: q.title,
          recommendation: q.recommendation ?? null,
          alternatives: q.alternatives.map((o) => o.label),
        };
        const next = {
          title: draft.title.trim(),
          recommendation: draft.recommendation.trim() || null,
          alternatives: options,
        };
        const after = Object.fromEntries(
          Object.entries(next).filter(
            ([k, v]) =>
              JSON.stringify(v) !== JSON.stringify(now[k as keyof typeof now]),
          ),
        );
        if (!Object.keys(after).length) return setEditing(false);
        const c = (
          await change({
            op: "edit_question",
            target: { decision_id: q.id },
            before: Object.fromEntries(
              Object.keys(after).map((k) => [k, now[k as keyof typeof now]]),
            ),
            after,
          })
        ).change;
        toast(
          c.status === "proposed"
            ? { message: `Sent to ${decidesName ?? "the owners"} to decide` }
            : undoable(`Saved ${name}`, c.id, done),
        );
      }
      done();
      onClose();
    });

  const withdraw = () =>
    act(async () => {
      if (!id) return;
      const c = (
        await change({
          op: "withdraw_decision",
          target: { decision_id: id },
          before: { status: "proposed" },
          after: { status: "withdrawn" },
        })
      ).change;
      onWithdrawn(id, c.id);
      done();
      onClose();
    });

  const remove = () =>
    act(async () => {
      if (!id) return;
      await unwrap(
        api.DELETE("/v1/simple/decisions/{decision_id}", {
          params: { path: { decision_id: id } },
        }),
      );
      toast({
        message: `${name} is in Settings › Trash`,
        action: {
          label: "Undo",
          onClick: () =>
            void unwrap(
              api.POST("/v1/simple/decisions/{decision_id}/restore", {
                params: { path: { decision_id: id } },
              }),
            )
              .then(() => toast({ message: `${name} is back` }))
              .catch((e) => toast({ message: errorMessage(e) }))
              .finally(done),
        },
      });
      done();
      onClose();
    });

  const reassign = (p: Person) =>
    act(async () => {
      if (target.kind === "new-decision") {
        setDecider(p);
        setPicking(false);
        return;
      }
      if (!id) return;
      await unwrap(
        api.POST("/v1/decisions/{decision}/reassign", {
          params: { path: { decision: id } },
          body: { approver_id: p.id, reason: REASSIGNED },
        }),
      );
      setDecider(p);
      setPicking(false);
      toast({ message: `${p.name} decides ${name}` });
      done();
    });

  const decidesRow = !question && (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3"
      data-testid="decision-sheet-decider"
    >
      <span className="simple-meta font-[650]">Decides</span>
      <span className="min-w-0 flex-1">{decidesName ?? "No one yet"}</span>
      {(target.kind === "new-decision" || (target.kind === "decision" && target.row.can?.reassign)) && !picking && (
        <button
          type="button"
          className="simple-button"
          onClick={() => setPicking(true)}
        >
          {target.kind === "new-decision" ? "Pick" : "Reassign"}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="decision-sheet-body">
      {editing ? (
        <EditFields
          draft={draft}
          set={set}
          question={question}
          target={target}
        />
      ) : target.kind === "decision" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 [overflow-wrap:anywhere]">
          {target.row.question && (
            <Field label="Question">{target.row.question}</Field>
          )}
          {target.row.context && (
            <Field label="Context">
              <span className="whitespace-pre-line">{target.row.context}</span>
            </Field>
          )}
          <Field label="Options">
            {target.row.options.length ? (
              <ol className="list-decimal pl-5">
                {target.row.options.map((o) => (
                  <li key={o.key}>{o.label}</li>
                ))}
              </ol>
            ) : (
              "None yet"
            )}
          </Field>
          {target.row.review_at && (
            <Field label="Review on">{reviewDay(target.row.review_at)}</Field>
          )}
        </dl>
      ) : target.kind === "question" ? (
        <div className="flex flex-col gap-2 [overflow-wrap:anywhere]">
          <h3 className="simple-meta font-[650]">
            Recommended in {target.q.prd.title}
          </h3>
          <p>{target.q.recommendation ?? "No recommendation yet"}</p>
          <h3 className="simple-meta font-[650]">Other answers</h3>
          {target.q.alternatives.length ? (
            <ul className="list-disc pl-5">
              {target.q.alternatives.map((o) => (
                <li key={o.key}>{o.label}</li>
              ))}
            </ul>
          ) : (
            <p>None yet</p>
          )}
          <h3 className="simple-meta font-[650]">Decides</h3>
          <p>{decidesName ?? "No decider yet"}</p>
        </div>
      ) : null}
      {decidesRow}
      {picking && (
        <People
          current={decider?.id ?? null}
          busy={busy}
          onPick={reassign}
          onClose={() => setPicking(false)}
        />
      )}
      {error && (
        <p className="simple-meta text-crit" role="alert">
          {error}
        </p>
      )}
      {/* A viewer reads only: no foot at all. */}
      {(editing || writes) && (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-line pt-3"
          data-testid="decision-sheet-foot"
        >
          {editing ? (
            <>
              <button
                type="button"
                className="simple-button simple-button-primary"
                disabled={busy}
                onClick={() => void save()}
              >
                {target.kind === "new-decision"
                  ? "Add decision"
                  : target.kind === "new-question"
                    ? "Add question"
                    : can?.edit
                      ? "Save"
                      : "Send"}
              </button>
              <button
                type="button"
                className="simple-button"
                onClick={() =>
                  isNew
                    ? onClose()
                    : (setEditing(false), setDraft(draftOf(target)))
                }
              >
                Cancel
              </button>
              {!isNew && !can?.edit && decidesName && (
                <span className="simple-meta">{decidesName} decides</span>
              )}
            </>
          ) : (
            writes && (
              <>
                <button
                  type="button"
                  className="simple-button simple-button-primary"
                  onClick={() => setEditing(true)}
                >
                  {can?.edit ? "Edit" : "Suggest a change"}
                </button>
                <span className="flex-1" />
                {can?.withdraw && (
                  <button
                    type="button"
                    className="simple-button"
                    disabled={busy}
                    onClick={() => void withdraw()}
                  >
                    Withdraw
                  </button>
                )}
                {can?.delete && (
                  <button
                    type="button"
                    className="simple-button text-crit"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Delete
                  </button>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** A toast with Undo for a change applied from the sheet. */
function undoable(message: string, changeId: string, done: () => void) {
  return {
    message,
    action: {
      label: "Undo",
      onClick: () =>
        void unwrap(
          api.POST("/v1/simple/changes/{change_id}/undo", {
            params: { path: { change_id: changeId } },
          }),
        )
          .then(() => toast({ message: "Undone" }))
          .catch((e) => toast({ message: errorMessage(e) }))
          .finally(done),
    },
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="simple-meta pt-px font-[650]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Edit: every field the sheet changes (a decision's; a question's text, recommendation and other answers). */
function EditFields({
  draft,
  set,
  question,
  target,
}: {
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  question: boolean;
  target: SheetTarget;
}) {
  const listName = question ? "Other answers" : "Options";
  const one = question ? "answer" : "option";
  const rows = draft.options;
  return (
    <div className="flex flex-col gap-3">
      {target.kind === "new-question" && (
        <label className="flex flex-col gap-1">
          <span className="simple-meta font-[650]">PRD</span>
          <select
            className={`${FIELD} h-10`}
            value={draft.prd}
            onChange={(e) => set({ prd: e.target.value })}
          >
            {target.prds.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="simple-meta font-[650]">
          {question ? "Question" : "Title"}
        </span>
        <input
          data-autofocus
          className={`${FIELD} h-10`}
          value={draft.title}
          maxLength={200}
          onChange={(e) => set({ title: e.target.value })}
        />
      </label>
      {question ? (
        <label className="flex flex-col gap-1">
          <span className="simple-meta font-[650]">Recommendation</span>
          <input
            className={`${FIELD} h-10`}
            value={draft.recommendation}
            maxLength={500}
            onChange={(e) => set({ recommendation: e.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="simple-meta font-[650]">Question</span>
            <textarea
              className={`${FIELD} py-2`}
              rows={2}
              value={draft.question}
              maxLength={1000}
              onChange={(e) => set({ question: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="simple-meta font-[650]">Context</span>
            <textarea
              className={`${FIELD} py-2`}
              rows={4}
              value={draft.context}
              maxLength={4000}
              onChange={(e) => set({ context: e.target.value })}
            />
          </label>
        </>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="simple-meta mb-1 font-[650]">{listName}</legend>
        {rows.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              aria-label={`${question ? "Answer" : "Option"} ${i + 1}`}
              className={`${FIELD} h-10 min-w-0 flex-1`}
              value={o}
              maxLength={200}
              onChange={(e) =>
                set({
                  options: rows.map((x, j) => (j === i ? e.target.value : x)),
                })
              }
            />
            <button
              type="button"
              aria-label={`Remove ${question ? "answer" : "option"} ${i + 1}`}
              className="grid size-10 place-items-center rounded-button text-accent-ink hover:bg-surface2"
              onClick={() => set({ options: rows.filter((_, j) => j !== i) })}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
        ))}
        {rows.length < MAX_OPTIONS && (
          <button
            type="button"
            className="self-start text-[15px] font-[650] text-accent-ink hover:underline"
            onClick={() => set({ options: [...rows, ""] })}
          >
            + Add an {one}
          </button>
        )}
      </fieldset>
      {!question && (
        <label className="flex flex-col gap-1">
          <span className="simple-meta font-[650]">Review on</span>
          <input
            type="date"
            className={`${FIELD} h-10 w-[220px] max-w-full`}
            value={draft.review_at}
            onChange={(e) => set({ review_at: e.target.value })}
          />
        </label>
      )}
    </div>
  );
}

/** GET /v1/people's page size for the person list. */
const PEOPLE_PAGE = 200;

/** Who decides: the people who may decide, a box to find one, the one who decides now marked. */
function People({
  current,
  busy,
  onPick,
  onClose,
}: {
  current: string | null;
  busy: boolean;
  onPick: (p: Person) => void;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const people = useQuery("simple-question-deciders", async () => {
    const out: Person[] = [];
    for (;;) {
      const rows = await unwrap(
        api.GET("/v1/people", {
          params: {
            query: { decides: true, limit: PEOPLE_PAGE, offset: out.length },
          },
        }),
      );
      out.push(...rows.map((p) => ({ id: p.user_id, name: p.name })));
      if (rows.length < PEOPLE_PAGE) return out;
    }
  });
  const shown = (people.data ?? []).filter((p) =>
    p.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  return (
    <div
      role="group"
      aria-label="Who decides"
      data-own-escape
      className="flex flex-col gap-1 rounded-lg border border-line p-3"
      data-testid="decision-sheet-people"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <input
        autoFocus
        aria-label="Find a person"
        placeholder="Find a person"
        className={`${FIELD} mb-1 h-10`}
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />
      {people.error && (
        <span className="simple-meta text-crit">{people.error}</span>
      )}
      {!people.data && !people.error && (
        <span className="simple-meta">Loading people…</span>
      )}
      <ul className="flex max-h-[280px] flex-col overflow-y-auto">
        {shown.map((p) => (
          <li key={p.id}>
            {p.id === current ? (
              <span
                className="block rounded-md bg-surface2 px-3 py-2 font-[650] text-accent-ink"
                aria-current="true"
              >
                {p.name} · decides now
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                className="block w-full rounded-md px-3 py-2 text-left hover:bg-surface2"
                onClick={() => onPick(p)}
              >
                {p.name}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="simple-button self-start"
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
  );
}
