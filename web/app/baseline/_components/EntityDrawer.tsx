"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";
import { peopleByIds } from "@/components/PersonPicker";
import { inTextField, useSplitPanel } from "@/components/ds/panel-close";
import { Button, Chip, CodeChip, InfoTip, Inspector, InspectorSection, Notice } from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, unwrap, type EdgeOut, type EntityDetail, type EntityOut, type GraphOut, type Schemas } from "@/lib/api/client";
import { formatDate, formatDateRange, formatDateTime } from "@/lib/format";
import { named } from "@/lib/codes";
import { useMe } from "@/lib/me";
import { hasPlaceholder, shownBody, shownTitle, withoutPlaceholders } from "@/lib/placeholders";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { EvidenceChip } from "./EvidenceChip";
import { GoalDiscuss, type Stepper } from "./GoalInterview";
import {
  AddDependencyForm,
  CiteSourceForm,
  ConfirmRemove,
  ContributionSelect,
  endName,
  LinkToGoalForm,
  type NewLink,
} from "./LinkTools";
import { GoalFields, goalDraft, goalPatch, gapLabel, Measurements, missingTip, problemsOf, type GoalDraft, type GoalProblem, type PlanningHorizons } from "./goal-fields";
import { LIMIT_LABEL, PromoteForm, suggestedBlocker } from "./PromoteBlocker";
import { SubgoalActions } from "./subgoal-actions";
import {
  ConfidenceRing,
  contributionOf,
  ContributionPips,
  DEFAULT_LOW,
  DeliveryChip,
  valueWords,
  goalCodes,
  LockBadge,
  NodeStatusBadge,
  sortedGoals,
  titleOf,
} from "./common";

const TYPE_LABEL: Record<EntityOut["type"], string> = {
  goal: "Goal",
  product: "Product",
  feature: "Feature",
  requirement: "Requirement",
  constraint: "Constraint",
  decision: "Decision",
  person: "Person",
  outcome: "Outcome",
  acceptance_criterion: "Acceptance criterion",
  assumption: "Assumption",
  risk: "Risk",
  strategy_choice: "Strategy choice",
};

/** Attribute fields offered in the edit form, per entity type. */
const EDIT_ATTRS: Partial<Record<EntityOut["type"], { key: string; label: string; numeric?: boolean }[]>> = {
  feature: [
    { key: "status", label: "Delivery status" },
    { key: "effort", label: "Effort" },
  ],
};

/** A goal's typed fields (B5): the goal form edits them; current and its day follow the measurements. */
const GOAL_TYPED = new Set(["metric", "unit", "comparison", "target", "start", "current", "current_as_of", "horizon", "due", "owner", "weight", "position"]);

/** #396 (#505): attribute keys a person reads in words; the rest read as they are, underscores as spaces. */
const ATTR_LABEL: Record<string, string> = {
  owner_text: "Owner (as written)",
  target_text: "Target (as written)",
  horizon_text: "Horizon (as written)",
  start_text: "Start (as written)",
  current_text: "Current (as written)",
  owner_confidence: "Owner confidence",
  parent: "Parent goal",
  parent_goal: "Parent goal",
  parent_key: "Parent goal",
  parent_ref: "Parent goal",
};

/** gt-goal-rename: attributes an import names a parent goal in, by key or id: read by the goal's name. */
const PARENT_ATTRS = new Set(["parent", "parent_goal", "parent_key", "parent_ref"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/;
/** A span of days as an import writes it: "2027-03-01..2027-03-31", "2027-03-01/2027-03-31", "2027-03-01 to 2027-03-31". */
const SPAN = /^(\d{4}-\d{2}-\d{2})(?:\s*(?:\.\.\.?|\/|–|—)\s*|\s+(?:to|-)\s+)(\d{4}-\d{2}-\d{2})$/;

/** An attribute's key in words, capitalized: "status" -> "Status", "priority_note" -> "Priority note". */
function attrLabel(key: string): string {
  if (Object.prototype.hasOwnProperty.call(ATTR_LABEL, key)) return ATTR_LABEL[key];
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The goal a parent attribute names, by id or key ("g-a2-scaling" and "g.a2-scaling" alike), by its name; nothing while
 * the graph loads, "Not in the Ground Truth" only when it is loaded and has no such goal.
 */
function parentName(graph: GraphOut | undefined, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  if (!graph) return "";
  const plain = (k: string) => k.trim().toLowerCase().replace(/[._\s]/g, "-");
  const found = graph?.entities.find((e) => e.type === "goal" && (e.id === value.trim() || plain(e.key) === plain(value)));
  return found ? shownTitle(found) : "Not in the Ground Truth";
}

/** A day, a moment or a span of days month first: "Mar 31, 2027", "Mar 1 – Mar 31, 2027"; null when it is none. */
function dateWords(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (DAY.test(text)) return formatDate(text);
    if (MOMENT.test(text)) return formatDateTime(text);
    const span = SPAN.exec(text);
    if (span) return formatDateRange(span[1], span[2]);
    return null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const [from, to] = [v.start ?? v.from, v.end ?? v.to];
    if (typeof from === "string" && typeof to === "string" && DAY.test(from) && DAY.test(to)) return formatDateRange(from, to);
  }
  return null;
}

/**
 * gt-goal-attr-shapes: a list's entries, or an object's fields in words ("Email threads: 60"), one per line, each read
 * as attrValue reads a value; null for any other value (a span of days included).
 */
function attrLines(value: unknown, graph?: GraphOut): string[] | null {
  if (Array.isArray(value)) return value.map((v) => attrValue("", v, graph));
  if (value && typeof value === "object" && dateWords(value) == null)
    return Object.entries(value).map(([k, v]) => `${attrLabel(k)}: ${attrValue(k, v, graph)}`);
  return null;
}

/**
 * An attribute's value as a person reads it: a 0-1 confidence as a percentage, dates month first, a parent goal by
 * its name, a value holding an unfilled placeholder ("[n] live helpers") as missing, and a list or an object in words.
 */
function attrValue(key: string, value: unknown, graph?: GraphOut): string {
  if (hasPlaceholder(value)) return "Missing";
  if (PARENT_ATTRS.has(key)) return parentName(graph, value);
  const lines = attrLines(value, graph);
  if (lines) return lines.join(", ") || "—";
  if (key.endsWith("_confidence") && typeof value === "number" && value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return dateWords(value) ?? valueWords(key, value, graph);
}

/** Attributes the edit form offers to add when the entry lacks them, per entity type. */
const KNOWN_ATTRS: Partial<Record<EntityOut["type"], string[]>> = {
  feature: ["milestone", "size", "evidence_gap", "confidence", "priority_note"],
};

type Props = {
  entity: EntityOut;
  graph: GraphOut | undefined;
  low?: number;
  canWrite: boolean;
  /** Commenters and up may add (and refresh) evidence from public links. */
  canComment?: boolean;
  meId?: string | null;
  /** Goal id -> "G1", as in the ledger. */
  tags: Map<string, string>;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Called after a write, so the lists behind the drawer refresh. */
  onChanged: () => void;
  /** Open on the Promote to blocker form (a suggested blocker's Promote, B4). */
  promote?: boolean;
  /** gt-goal-rename: opens on the Edit form, again each time it grows (a goal row's Rename). */
  edit?: number;
  /** For a blocker: opens its blocker inspector (#340). */
  onOpenBlocker?: () => void;
  /** B6: the goals interview shown in the Discuss view, and the stepper over the vague goals. */
  discussionId?: string | null;
  stepper?: Stepper | null;
  /** B6: Make measurable on a goal that is not (commenters and up). */
  onMakeMeasurable?: () => void;
  /** H11: Shape goals is at Observe: this sentence stands where Make measurable would. */
  goalsNote?: string | null;
  /** B6: back from the Discuss view to the goal's details. */
  onCloseDiscuss?: () => void;
  /** B2: the "Why it needs you" card of a row from a run's review, shown first. */
  why?: ReactNode;
};

/**
 * The inspector for one baseline item (B1's dark-headed panel, right of the tables, below
 * them on a phone): its links, evidence and (for approvers) edit and unlock.
 */
export function EntityDrawer({
  entity,
  graph,
  low = DEFAULT_LOW,
  canWrite,
  canComment = canWrite,
  meId,
  tags,
  onClose,
  onOpen,
  onChanged,
  promote = false,
  edit = 0,
  onOpenBlocker,
  discussionId,
  stepper,
  onMakeMeasurable,
  goalsNote,
  onCloseDiscuss,
  why,
}: Props) {
  const q = useQuery(`baseline-entity:${entity.id}`, () =>
    unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: entity.id } } })),
  );
  const lockedBy = q.data ? q.data.locked_by : entity.locked_by;
  const locker = useQuery(`entity-locker:${lockedBy ?? ""}`, () => peopleByIds([lockedBy]));
  // The one name rule (display_name, GET /v1/people); "a person" when it cannot be read.
  const lockerName = lockedBy ? (locker.data?.get(lockedBy)?.name ?? (locker.loading ? "…" : "a person")) : undefined;
  const onAuth = useAuthRedirect();
  const [editing, setEditing] = useState(edit > 0 && canWrite);
  const [promoting, setPromoting] = useState(promote && canWrite);
  // Reject (a proposed item) or Archive (a confirmed one) asks for the reason first.
  const [asking, setAsking] = useState<"reject" | "archive" | null>(null);
  // Link to goal, Add dependency or Cite a source item, open below its section.
  const [adding, setAdding] = useState<"goal" | "dependency" | "cite" | null>(null);
  const [removingEvidence, setRemovingEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The goal fields the API refused on the last Save, shown under their fields (B5).
  const [problems, setProblems] = useState<GoalProblem[] | null>(null);
  // A goal row's Rename on the goal already open: back to the Edit form (set while rendering, as React advises).
  const [editAsked, setEditAsked] = useState(edit);
  if (edit !== editAsked) {
    setEditAsked(edit);
    if (edit > 0 && canWrite) {
      setNotice(null);
      setPromoting(false);
      setEditing(true);
    }
  }
  const d = q.data;
  const title = shownTitle(d ?? entity);
  // A subgoal's code is its place in the goal tree (#345), as its chip shows: G-B.1, or none.
  const treeCode = d?.parent_id ? goalCodes(graph).get(entity.id) : undefined;
  const code = treeCode !== undefined ? treeCode : named(title, d?.key ?? entity.key).code;
  const root = useRef<HTMLDivElement>(null);
  const split = useSplitPanel();

  // Below the tables (narrow screens), bring the inspector into view when it opens.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1100px)").matches) root.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || inTextField(e.target)) return;
      if (split) split.closeWith(onClose);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, split]);

  async function write(run: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      await q.reload();
      onChanged();
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const refreshLink = (evidenceId: string, label: string) =>
    write(async () => {
      await unwrap(
        api.POST("/v1/baseline/evidence/{evidence_id}/refresh", { params: { path: { evidence_id: evidenceId } } }),
      );
      return `Fetched “${label}” again and rescored it.`;
    });

  const unlock = () =>
    write(async () => {
      await unwrap(api.POST("/v1/baseline/entities/{entity_id}/unlock", { params: { path: { entity_id: entity.id } } }));
      return "Unlocked: agents can change this item again.";
    });

  const save = (patch: { title: string; body: string | null; attrs: Record<string, unknown> }) =>
    write(async () => {
      const res = await api.PATCH("/v1/baseline/entities/{entity_id}", {
        params: { path: { entity_id: entity.id } },
        body: { ...patch, origin: "user" },
      });
      const refused = res.response.status === 422 ? problemsOf(res.error) : null;
      if (refused) {
        // Nothing was written: the form stays open with each problem under its field.
        setProblems(refused);
        return null;
      }
      setProblems(null);
      if (res.response.status === 202) {
        setEditing(false);
        return "The item is locked, so your change was saved as a proposal for an approver.";
      }
      await unwrap(Promise.resolve(res));
      setEditing(false);
      return "Saved. The item is now locked against agent changes.";
    });

  // #345: move a subgoal under another goal, or promote it (null).
  const moveGoal = (parentId: string | null) =>
    write(async () => {
      const res = await api.PATCH("/v1/baseline/entities/{entity_id}", {
        params: { path: { entity_id: entity.id } },
        body: { parent_id: parentId, origin: "user" },
      });
      await unwrap(Promise.resolve(res));
      if (res.response.status === 202) return "The item is locked, so your change was saved as a proposal for an approver.";
      if (!parentId) return "Promoted to a goal.";
      return `Moved under “${titleOf(graph, parentId)}”.`;
    });

  const decide = (action: "confirm" | "reject" | "archive", note?: string) =>
    write(async () => {
      const params = { params: { path: { entity_id: entity.id } }, body: { note: note || null } };
      let code: string | null = null;
      if (action === "confirm") {
        // codes-on-join: a feature gets its code as it joins the Ground Truth; the notice says it.
        const e = await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", params));
        code = e.type === "feature" ? named(e.title, e.key).code : null;
      }
      // Archiving a confirmed item rejects it, as the API does: it leaves the baseline, its history keeps why.
      else await unwrap(api.POST("/v1/baseline/entities/{entity_id}/reject", params));
      setAsking(null);
      if (action === "confirm") return `Confirmed “${title}”${code ? ` as ${code}` : ""}.`;
      if (action === "archive") {
        const sub = d?.parent_id ? " Its parent no longer counts it." : "";
        return `Archived “${title}”: it leaves the Ground Truth; its history keeps the reason.${sub}`;
      }
      return `Rejected “${title}”.`;
    });

  const LOCKED = "The link is locked, so your change was saved as a proposal for an approver.";

  const addLink = (link: NewLink) =>
    write(async () => {
      const res = await api.POST("/v1/baseline/edges", { body: { ...link, src_id: entity.id, origin: "user" } });
      await unwrap(Promise.resolve(res));
      setAdding(null);
      if (res.response.status === 202) return "Your link was saved as a proposal for an approver.";
      const name = titleOf(graph, link.dst_id);
      return link.type === "supports" ? `Linked to “${name}”.` : `Added the link to “${name}”.`;
    });

  const patchEdge = (edge: EdgeOut, body: Pick<Schemas["EdgePatch"], "attrs" | "status">, done: string) =>
    write(async () => {
      const res = await api.PATCH("/v1/baseline/edges/{edge_id}", {
        params: { path: { edge_id: edge.id } },
        body: { ...body, origin: "user" },
      });
      await unwrap(Promise.resolve(res));
      return res.response.status === 202 ? LOCKED : done;
    });

  const removeEdge = (edge: EdgeOut) =>
    write(async () => {
      const res = await api.DELETE("/v1/baseline/edges/{edge_id}", { params: { path: { edge_id: edge.id } } });
      await unwrap(Promise.resolve(res));
      if (res.response.status === 202) return LOCKED;
      return `Removed the link to “${endName(graph, edge, entity.id)}”.`;
    });

  const unlockEdge = (edge: EdgeOut) =>
    write(async () => {
      await unwrap(api.POST("/v1/baseline/edges/{edge_id}/unlock", { params: { path: { edge_id: edge.id } } }));
      return "Unlocked: agents can change this link again.";
    });

  const cite = (item: Schemas["ItemOut"]) =>
    write(async () => {
      await unwrap(
        api.POST("/v1/baseline/entities/{entity_id}/evidence", {
          params: { path: { entity_id: entity.id } },
          body: { source_item_id: item.id },
        }),
      );
      setAdding(null);
      return `Cited “${item.title ?? item.external_id}”.`;
    });

  const removeEvidence = (evidenceId: string, label: string, reason: string) =>
    write(async () => {
      await unwrap(
        api.DELETE("/v1/baseline/evidence/{evidence_id}", {
          params: { path: { evidence_id: evidenceId }, query: { reason } },
        }),
      );
      setRemovingEvidence(null);
      return `Removed “${label}”.`;
    });

  const open = (form: "goal" | "dependency" | "cite") => {
    setNotice(null);
    setError(null);
    setAdding(form);
  };

  const promoteBlocker = (body: Schemas["BlockerCreate"]) =>
    write(async () => {
      await unwrap(api.POST("/v1/blockers", { body }));
      setPromoting(false);
      return "Promoted to a blocker. The suggested-blocker mark is cleared.";
    });

  const suggestion = suggestedBlocker(d ?? entity);
  const blocker = (d ?? entity).type === "constraint" && !!(d ?? entity).attrs?.blocker;
  const links = d ? [...d.edges_out, ...d.edges_in].filter((e) => e.status !== "rejected").length : undefined;
  const evidence = d?.evidence.length ?? entity.evidence_count;
  const proposals = d?.open_proposals;

  if (discussionId && entity.type === "goal") {
    return (
      <div role="dialog" aria-label={title} aria-modal="false" data-testid="entity-drawer" ref={root} className="scroll-mt-4">
        <GoalDiscuss goal={entity} discussionId={discussionId} stepper={stepper} onBack={onCloseDiscuss ?? onClose} onChanged={onChanged} />
      </div>
    );
  }

  return (
    <div role="dialog" aria-label={title} aria-modal="false" data-testid="entity-drawer" ref={root} className="scroll-mt-4">
      <Inspector
        label={title}
        // Two stats a row: four in a drawer's width cut "Confidence" to "Confide…" (qa-plan-46).
        statColumns={2}
        eyebrow={
          <>
            {TYPE_LABEL[entity.type]}
            {code && (
              <>
                {" · "}
                <span className="font-mono" data-testid="drawer-code">
                  {code}
                </span>
              </>
            )}
          </>
        }
        title={title}
        chips={
          <>
            <NodeStatusBadge status={(d ?? entity).status} hero />
            <DeliveryChip value={(d ?? entity).type === "feature" ? (d ?? entity).attrs?.status : undefined} hero />
            <LockBadge entity={d ?? entity} meId={meId} name={lockerName} hero />
            {!canComment && <Chip hero>View only</Chip>}
            {(d ?? entity).goal_check?.measurable === false && (
              <Chip kind="warn" hero title={missingTip((d ?? entity).goal_check)}>
                {gapLabel((d ?? entity).goal_check)}
              </Chip>
            )}
            {suggestion && (
              <Chip kind="warn" hero data-testid="suggested-blocker">
                Suggested blocker
              </Chip>
            )}
            {(blocker || onOpenBlocker) && (
              <Chip kind="crit" hero>
                Blocker
              </Chip>
            )}
          </>
        }
        onClose={onClose}
        stats={[
          // A score is built on evidence: none, no score (qa-plan-8).
          { label: "Confidence", figure: <ConfidenceRing value={(d ?? entity).confidence} evidence={evidence} low={low} size={44} /> },
          { label: "Evidence", value: evidence },
          { label: "Links", value: links ?? "–" },
          { label: "Proposals", value: proposals ?? "–", tone: proposals ? "warn" : undefined },
        ]}
      >
        {why}
        {(q.error || error || notice || (q.loading && !d)) && (
          <InspectorSection>
            <div className="flex flex-col gap-2">
              {q.error && <Notice tone="error">{q.error}</Notice>}
              {q.loading && !d && <Loading />}
              {error && <Notice tone="error">{error}</Notice>}
              {notice && <Notice>{notice}</Notice>}
            </div>
          </InspectorSection>
        )}
        {d && (
          <>
            {d.locked && (
              <InspectorSection
                label="Lock"
                tools={
                  canWrite && (
                    <Button onClick={unlock} disabled={busy} icon="lock">
                      Unlock
                    </Button>
                  )
                }
              >
                <p className="flex items-center gap-2">
                  <span className="min-w-0 break-words" data-testid="lock-note">
                    Locked by {d.locked_by && d.locked_by === meId ? "you" : (lockerName ?? "a person")}
                    {d.locked_at && <span className="tnum text-text2"> · {formatDateTime(d.locked_at)}</span>}
                    <span className="sr-only">. Agents can only propose changes.</span>
                  </span>
                  <InfoTip label="the lock">A person&apos;s edit locks the item: agents can only propose changes to it.</InfoTip>
                </p>
              </InspectorSection>
            )}

            {onOpenBlocker && (
              <InspectorSection label="Blocker strategy" tools={<Button onClick={onOpenBlocker}>Open blocker</Button>}>
                <p className="text-text2">Status, options, feasibility scope and experiments.</p>
              </InspectorSection>
            )}

            {blocker && <RecordDecision entity={d ?? entity} />}

            {d.type === "goal" && d.goal_check?.measurable === false && onMakeMeasurable && (
              <InspectorSection
                label={gapLabel(d.goal_check)}
                tools={
                  <Button disabled={busy} onClick={onMakeMeasurable}>
                    {gapLabel(d.goal_check) === "No owner" ? "Name an owner" : "Make measurable"}
                  </Button>
                }
              >
                <p className="text-text2" data-testid="drawer-missing">
                  {gapLabel(d.goal_check) === "No owner"
                    ? `${missingTip(d.goal_check)}. Oracle asks who should own it; an approver confirms.`
                    : `${missingTip(d.goal_check)}. Oracle asks one question at a time and proposes measurable versions.`}
                </p>
              </InspectorSection>
            )}
            {d.type === "goal" && d.goal_check?.measurable === false && !onMakeMeasurable && goalsNote && (
              <InspectorSection label={gapLabel(d.goal_check)}>
                <p className="text-text2" data-testid="drawer-missing">
                  {missingTip(d.goal_check)}.
                </p>
                <p className="text-text2" data-testid="goals-observe">
                  {goalsNote}
                </p>
              </InspectorSection>
            )}

            {promoting && suggestion ? (
              <InspectorSection label="Promote to blocker">
                <PromoteForm
                  entity={d}
                  low={low}
                  busy={busy}
                  onCancel={() => setPromoting(false)}
                  onSave={promoteBlocker}
                />
              </InspectorSection>
            ) : editing ? (
              <InspectorSection label="Edit">
                <EditForm
                  entity={d}
                  graph={graph}
                  busy={busy}
                  problems={problems ?? d.goal_check?.problems ?? []}
                  onCancel={() => {
                    setProblems(null);
                    setEditing(false);
                  }}
                  onSave={save}
                />
              </InspectorSection>
            ) : (
              <>
                {shownBody(d) && (
                  <InspectorSection label="Description">
                    <p className="line-clamp-4 whitespace-pre-line text-text2" title={shownBody(d) ?? undefined}>
                      {shownBody(d)}
                    </p>
                  </InspectorSection>
                )}
                {suggestion && (
                  <InspectorSection
                    label="Suggested blocker"
                    tools={
                      canWrite && (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setNotice(null);
                            setEditing(false);
                            setPromoting(true);
                          }}
                        >
                          Promote to blocker
                        </Button>
                      )
                    }
                  >
                    <p className="text-text2">
                      An intake answer suggests this is a blocker. Nothing gates publishing until an approver promotes
                      it.
                    </p>
                    <p className="mt-1.5 text-sm" data-testid="suggestion">
                      {[
                        suggestion.severity && `${suggestion.severity} severity`,
                        suggestion.type && `${suggestion.type} type`,
                        suggestion.limit_kind && LIMIT_LABEL[suggestion.limit_kind],
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </InspectorSection>
                )}
                <Attrs attrs={d.attrs} graph={graph} />
              </>
            )}

            {d.type === "goal" && (
              <Measurements
                goal={d}
                canWrite={canWrite}
                onChanged={() => {
                  void q.reload();
                  onChanged();
                }}
              />
            )}

            {canWrite && d.type === "goal" && (
              <SubgoalActions goal={d} graph={graph} busy={busy} onMove={moveGoal} onArchive={() => setAsking("archive")} />
            )}

            <History entityId={d.id} updatedAt={d.updated_at} graph={graph} goal={d.type === "goal"} />

            <Links
              detail={d}
              graph={graph}
              tags={tags}
              onOpen={onOpen}
              canWrite={canWrite}
              busy={busy}
              onPatch={patchEdge}
              onRemove={removeEdge}
              onUnlock={unlockEdge}
            />

            {/* Only approvers and owners change links: other roles never see the controls. */}
            {canWrite && (
              <InspectorSection label="Add a link">
                {adding === "goal" ? (
                  <LinkToGoalForm detail={d} graph={graph} busy={busy} onCancel={() => setAdding(null)} onSave={addLink} />
                ) : adding === "dependency" ? (
                  <AddDependencyForm detail={d} graph={graph} busy={busy} onCancel={() => setAdding(null)} onSave={addLink} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {d.type !== "goal" && (
                      <Button icon="plus" disabled={busy} onClick={() => open("goal")}>
                        Link to goal
                      </Button>
                    )}
                    <Button icon="plus" disabled={busy} onClick={() => open("dependency")}>
                      Add dependency
                    </Button>
                  </div>
                )}
              </InspectorSection>
            )}

            <InspectorSection label="Evidence" tools={<span className="tnum text-text">{d.evidence.length}</span>}>
              {d.evidence.length === 0 ? (
                <p className="text-text2">None yet</p>
              ) : (
                <ul className="flex flex-col gap-1.5" aria-label="Evidence">
                  {d.evidence.map((ev) => (
                    <li key={ev.id} className="flex flex-col gap-1.5" data-testid="evidence-row">
                      <div className="flex min-h-8 max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <EvidenceChip evidence={ev} low={low} />
                        <span className="min-w-[6rem] flex-1 truncate text-sm text-text2" title={ev.ref ?? ev.url ?? undefined}>
                          {ev.ref ?? ev.url}
                          {ev.retrieved_at && <span className="tnum"> · {formatDate(ev.retrieved_at)}</span>}
                        </span>
                        {ev.kind && canComment && (
                          <Button
                            variant="ghost"
                            className="flex-none"
                            disabled={busy}
                            aria-label={`Refresh ${ev.ref ?? ev.url}`}
                            title="Fetch the public page again and rescore it"
                            onClick={() => refreshLink(ev.id, ev.ref ?? ev.url ?? "the link")}
                          >
                            Refresh
                          </Button>
                        )}
                        {/* Approvers remove any evidence; a commenter only a link they added (the API checks who). */}
                        {(canWrite || (canComment && ev.kind)) && removingEvidence !== ev.id && (
                          <Button
                            variant="ghost"
                            className="ml-auto flex-none"
                            disabled={busy}
                            aria-label={`Remove ${ev.ref ?? ev.url}`}
                            onClick={() => {
                              setNotice(null);
                              setRemovingEvidence(ev.id);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                      {removingEvidence === ev.id && (
                        <ConfirmRemove
                          name="Remove evidence"
                          prompt="Remove this evidence? The item's confidence is rescored without it."
                          reason
                          busy={busy}
                          onBack={() => setRemovingEvidence(null)}
                          onRemove={(reason) => removeEvidence(ev.id, ev.ref ?? ev.url ?? "the evidence", reason)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && (
                <div className="mt-3">
                  {adding === "cite" ? (
                    <CiteSourceForm busy={busy} onCancel={() => setAdding(null)} onCite={cite} />
                  ) : (
                    <Button icon="plus" disabled={busy} onClick={() => open("cite")}>
                      Cite a source item
                    </Button>
                  )}
                </div>
              )}
              {canComment && (
                <div className="mt-3">
                  <AddEvidenceLink
                    target={{ entity_id: entity.id }}
                    low={low}
                    onSaved={() => {
                      void q.reload();
                      onChanged();
                    }}
                  />
                </div>
              )}
            </InspectorSection>

            {/* v2 screen 2: the outputs built on this item, as a what-if (a preview; nothing is marked). */}
            <InspectorSection label="Impact">
              <Link href={`/impact/entities/${entity.id}`} className="text-sm font-medium text-accent-ink hover:underline">
                What if it changed?
              </Link>
            </InspectorSection>

            {/* Only a role that can decide sees these controls (#370); busy disables them for the moment. */}
            {canWrite && !editing && !(promoting && suggestion) && (
              <InspectorSection>
                {asking ? (
                  <AskReason action={asking} busy={busy} onBack={() => setAsking(null)} onSubmit={(note) => decide(asking, note)} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {d.status === "proposed" && (
                      <>
                        <Button variant="solid" disabled={busy} onClick={() => decide("confirm")}>
                          Confirm
                        </Button>
                        <Button disabled={busy} onClick={() => setAsking("reject")}>
                          Reject
                        </Button>
                      </>
                    )}
                    <Button
                      onClick={() => {
                        setNotice(null);
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                    {/* A subgoal's Archive sits with its place in the goal tree (#345). */}
                    {d.status === "confirmed" && !d.parent_id && (
                      <Button variant="danger" disabled={busy} onClick={() => setAsking("archive")}>
                        Archive
                      </Button>
                    )}
                  </div>
                )}
              </InspectorSection>
            )}
          </>
        )}
      </Inspector>
    </div>
  );
}

/** The in-page confirm for Reject and Archive, with the reason the item's history keeps. */
function AskReason({
  action,
  busy,
  onBack,
  onSubmit,
}: {
  action: "reject" | "archive";
  busy: boolean;
  onBack: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState(false);
  const name = action === "reject" ? "Reject" : "Archive";
  return (
    <form
      aria-label={name}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (action === "archive" && !note.trim()) {
          setInvalid(true);
          return;
        }
        onSubmit(note.trim());
      }}
    >
      <p className="text-text2">
        {action === "reject"
          ? "Reject this proposed item? It leaves the Ground Truth."
          : "Archive this item? It leaves the Ground Truth and the Ledger; its history keeps it."}
      </p>
      <label className="flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2">
        Reason{action === "reject" && " (optional)"}
        <textarea className={INPUT} rows={2} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
      </label>
      {invalid && <Notice tone="error">Say why it is archived.</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={busy}>
          {name}
        </Button>
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </form>
  );
}

function Attrs({ attrs, graph }: { attrs: Record<string, unknown>; graph: GraphOut | undefined }) {
  // The suggested-blocker mark has its own section.
  const entries = Object.entries(attrs ?? {}).filter(([k]) => k !== "proposed_blocker");
  if (entries.length === 0) return null;
  return (
    <InspectorSection label="Attributes">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5" aria-label="Attributes">
        {entries.map(([k, v]) => {
          const lines = PARENT_ATTRS.has(k) ? null : attrLines(v, graph);
          return (
            <div key={k} className="contents">
              <dt className="text-text2">{attrLabel(k)}</dt>
              {lines?.length ? (
                <dd className="tnum font-semibold" data-attr={k}>
                  <ul>
                    {lines.map((line, i) => (
                      <li key={i} className="truncate" title={line}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </dd>
              ) : (
                <dd className="tnum truncate font-semibold" data-attr={k} title={attrValue(k, v, graph)}>
                  {k === "status" ? <DeliveryChip value={v} /> : attrValue(k, v, graph)}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </InspectorSection>
  );
}

function Links({
  detail,
  graph,
  tags,
  onOpen,
  canWrite,
  busy,
  onPatch,
  onRemove,
  onUnlock,
}: {
  detail: EntityDetail;
  graph: GraphOut | undefined;
  tags: Map<string, string>;
  onOpen: (id: string) => void;
  canWrite: boolean;
  busy: boolean;
  onPatch: (edge: EdgeOut, body: Pick<Schemas["EdgePatch"], "attrs" | "status">, done: string) => void;
  onRemove: (edge: EdgeOut) => void;
  onUnlock: (edge: EdgeOut) => void;
}) {
  // Remove asks first, in the row.
  const [removing, setRemoving] = useState<string | null>(null);
  const out = (t: EdgeOut["type"]) => detail.edges_out.filter((e) => e.type === t && e.status !== "rejected");
  const inn = (t: EdgeOut["type"]) => detail.edges_in.filter((e) => e.type === t && e.status !== "rejected");
  const link = (id: string) => (
    <span className="flex min-w-0 items-center gap-2">
      {tags.has(id) && <CodeChip kind="goal" entityId={id} title={titleOf(graph, id)} codeOnly />}
      <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => onOpen(id)}>
        {tags.get(id) ?? titleOf(graph, id)}
      </button>
    </span>
  );
  const list = (title: string, edges: EdgeOut[], end: "src_id" | "dst_id", contribution = false) =>
    edges.length > 0 && (
      <InspectorSection label={title}>
        <ul aria-label={title} className="flex flex-col gap-1">
          {(contribution ? [...edges].sort((a, b) => contributionOf(b.attrs) - contributionOf(a.attrs)) : edges).map((e) => {
            const name = titleOf(graph, e[end]);
            const value = contributionOf(e.attrs);
            return (
              <li key={e.id} className="flex flex-col gap-1.5">
                <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="min-w-[9rem] flex-1">{link(e[end])}</span>
                  {e.status === "proposed" && <Chip kind="warn">Proposed</Chip>}
                  {contribution && e.attrs?.contribution_assumed === true && (
                    <span title="Oracle assumed this contribution: the run named the goal but not how much it helps. Set it to what it is.">
                      <Chip kind="warn">Contribution assumed</Chip>
                    </span>
                  )}
                  {contribution && (
                    <span className="flex flex-none items-center gap-2" data-testid="contribution">
                      <ContributionPips value={value} proposed={e.status === "proposed"} />
                      {canWrite ? (
                        <span className="w-[7.5rem]">
                          <ContributionSelect
                            label={`Contribution to ${name}`}
                            value={String(value)}
                            disabled={busy}
                            onChange={(v) => onPatch(e, { attrs: { contribution: Number(v), contribution_assumed: null } }, `Contribution set to ${v}.`)}
                          />
                        </span>
                      ) : (
                        <span className="tnum font-semibold">
                          <span className="sr-only">contribution </span>
                          {value}/3
                        </span>
                      )}
                    </span>
                  )}
                  {canWrite && (
                    <span className="ml-auto flex flex-none items-center gap-1">
                      {e.status === "proposed" && (
                        <Button
                          variant="solid"
                          disabled={busy}
                          aria-label={`Confirm link to ${name}`}
                          onClick={() => onPatch(e, { status: "confirmed" }, `Confirmed the link to “${name}”.`)}
                        >
                          Confirm
                        </Button>
                      )}
                      {e.locked && (
                        <Button
                          variant="ghost"
                          icon="lock"
                          disabled={busy}
                          aria-label={`Unlock link to ${name}`}
                          title="Locked by a person: agents can only propose changes. Unlock lets them change it."
                          onClick={() => onUnlock(e)}
                        >
                          Unlock
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove link to ${name}`}
                        onClick={() => setRemoving(e.id)}
                      >
                        Remove
                      </Button>
                    </span>
                  )}
                </div>
                {removing === e.id && (
                  <ConfirmRemove
                    name="Remove link"
                    prompt={<>Remove the link to “{name}”?</>}
                    busy={busy}
                    onBack={() => setRemoving(null)}
                    onRemove={() => {
                      setRemoving(null);
                      onRemove(e);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </InspectorSection>
    );

  return (
    <>
      {list("Supports", out("supports"), "dst_id", true)}
      {list("Supported by", inn("supports"), "src_id", true)}
      {list("Depends on", out("depends_on"), "dst_id")}
      {list("Needed by", inn("depends_on"), "src_id")}
      {list("Blocks", out("blocks"), "dst_id")}
      {list("Blocked by", inn("blocks"), "src_id")}
      {list("Part of", out("part_of"), "dst_id")}
      {list("Contains", inn("part_of"), "src_id")}
    </>
  );
}

/**
 * gt-goal-attr-shapes: how the form offers an attribute, or a field or entry in one, keeping the type it is stored as:
 * a parent goal as a picker of goals by name, a list of words or of numbers one line per entry, any other list entry
 * by entry, an object one field per field (each in turn as its type), a yes or no as a two-choice picker, a day as a
 * date; never its raw key or JSON. `start` is what the form first showed, so an untouched value is saved as stored.
 */
type Draft =
  | { kind: "text" | "number" | "day" | "bool" | "parent"; was: unknown; start: string; text: string; multi?: boolean; loose?: boolean }
  | { kind: "lines"; was: unknown; start: string; text: string; numbers: boolean }
  | { kind: "object"; was: unknown; fields: Field[] }
  | { kind: "entries"; was: unknown; entries: Draft[] };
/**
 * An object's field: its key and draft; a field the person added has `fresh` set and its name typed as the key. A text
 * that is `multi` reads in a box of lines (a new entry among entries that do); one that is `loose` is stored as a
 * number when one is typed (a new field among numbers), as text otherwise.
 */
type Field = [key: string, draft: Draft, fresh?: true];
type AttrField = { key: string; label: string; numeric?: boolean };

/** The labelled fields for the type, then every other attribute the entry has (the suggested-blocker mark aside). */
function attrFields(entity: EntityDetail): AttrField[] {
  const fields: AttrField[] = (EDIT_ATTRS[entity.type] ?? []).map((f) => ({ key: f.key, label: f.label, numeric: f.numeric }));
  for (const [key] of Object.entries(entity.attrs ?? {})) {
    if (key === "proposed_blocker" || fields.some((f) => f.key === key)) continue;
    if (entity.type === "goal" && GOAL_TYPED.has(key)) continue;
    fields.push({ key, label: attrLabel(key) });
  }
  return fields;
}

const asText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A value or list entry as the form shows it in a line: no unfilled placeholder. */
function formText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return withoutPlaceholders(v);
  return typeof v === "object" ? attrValue("", v) : String(v);
}

/** Whether a value, or any entry or field in it, holds an unfilled placeholder. */
function holdsPlaceholder(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(holdsPlaceholder);
  if (v != null && typeof v === "object") return Object.values(v).some(holdsPlaceholder);
  return hasPlaceholder(v);
}

/** The form's draft of a stored value; `key` names a top-level attribute (a parent goal is picked), "" a part of one. */
function draftOf(v: unknown, key = "", numeric = false): Draft {
  const plain = (kind: "text" | "number" | "day" | "bool" | "parent", start: string): Draft => ({ kind, was: v, start, text: start });
  if (PARENT_ATTRS.has(key) && (v == null || typeof v === "string")) return plain("parent", typeof v === "string" ? v : "");
  if (numeric || typeof v === "number") return plain("number", formText(v));
  if (typeof v === "boolean") return plain("bool", v ? "yes" : "no");
  if (Array.isArray(v)) {
    const numbers = v.length > 0 && v.every((x) => typeof x === "number");
    // A list of words (none holding a line break) or of numbers reads one line per entry; any other entry by entry.
    if (numbers || v.every((x) => typeof x === "string" && !x.includes("\n"))) {
      const start = v.map(formText).join("\n");
      return { kind: "lines", was: v, start, text: start, numbers };
    }
    return { kind: "entries", was: v, entries: v.map((x) => draftOf(x)) };
  }
  if (v != null && typeof v === "object") return { kind: "object", was: v, fields: Object.entries(v).map(([k, x]) => [k, draftOf(x)]) };
  return plain(typeof v === "string" && DAY.test(v) ? "day" : "text", formText(v));
}

/** A new entry shaped like `d`: the same fields, each of its type, left empty. */
function blankOf(d: Draft): Draft {
  if (d.kind === "object") return { kind: "object", was: undefined, fields: d.fields.filter((f) => !f[2]).map(([k, p]) => [k, blankOf(p)]) };
  if (d.kind === "entries") return { kind: "entries", was: undefined, entries: [] };
  if (d.kind === "lines") return { ...d, was: undefined, start: "", text: "" };
  const multi = d.kind === "text" && (d.multi || d.start.includes("\n"));
  return { kind: d.kind === "parent" ? "text" : d.kind, was: undefined, start: "", text: "", ...(multi ? { multi } : {}) };
}

/** A field's key from the name typed for it: "Weekend hours" is stored as weekend_hours. */
const fieldKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * A value emptied in the form: an attribute is removed, a field or a list entry left out. An object or a list is never
 * left out for being emptied, only when removed with its x; one the person added and left empty is, and so is a list
 * entry the person emptied.
 */
const GONE = Symbol("gone");

/** A label inside its group, for an error: "Reply targets: Hours". */
const within = (group: string | undefined, label: string) => (group ? `${group}: ${label}` : label);

/** A number as a person types one: plain decimal digits, no hex ("0x10") or exponent ("1e3"). */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Typed with leading zeros ("007"), as a code is, not "0" or "0.5". */
const ZEROS = /^[+-]?0\d/;

/** A typed plain decimal as a number, or undefined (one too long to hold, 309 digits or more, included). */
function decimalOf(typed: string): number | undefined {
  const n = DECIMAL.test(typed) ? Number(typed) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A typed plain decimal as a number only when the number holds it exactly: none past Number.MAX_SAFE_INTEGER, and
 * none that reads back as other digits ("12345678901234567890", or a tiny decimal read as 0).
 */
function exactOf(typed: string): number | undefined {
  const n = decimalOf(typed);
  return n !== undefined && Math.abs(n) <= Number.MAX_SAFE_INTEGER && digitsOf(String(n)) === digitsOf(typed) ? n : undefined;
}

/** A decimal as its sign, significant digits and where its point falls: "0.050" and "5e-2" both read "5@-1". */
function digitsOf(s: string): string {
  const [mantissa, exp = "0"] = s.replace(/^[+-]/, "").split("e");
  const [whole, frac = ""] = mantissa.split(".");
  const all = whole + frac;
  const lead = all.length - all.replace(/^0+/, "").length;
  const sig = all.slice(lead).replace(/0+$/, "");
  return sig ? `${s.startsWith("-") ? "-" : ""}${sig}@${whole.length - lead + Number(exp)}` : "0";
}

/** A typed number, or the error its field shows. */
function numberOf(typed: string, label: string): number {
  const n = decimalOf(typed);
  if (n === undefined) throw new Error(`${label} must be a number.`);
  return n;
}

/**
 * A draft back as stored, keeping each value's type: what it was when untouched (the same value, a placeholder kept),
 * a number where one was, a yes or no as true or false, an object or a list as one; throws a field's error, naming
 * the group it is in.
 */
function storedOf(d: Draft, label: string, group?: string): unknown {
  if (d.kind === "object") {
    const was = (d.was ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, part, fresh] of d.fields) {
      const name = fresh ? k.trim() : attrLabel(k);
      const v = storedOf(part, name || "New field", within(group, label));
      if (v === GONE) continue;
      const key = fresh ? fieldKey(k) : k;
      if (!key) throw new Error(`${within(group, label)}: a new field needs a name.`);
      if (Object.prototype.hasOwnProperty.call(next, key) || (fresh && d.fields.some(([o, , f]) => !f && o === key)))
        throw new Error(`${within(group, label)}: ${name} is already a field.`);
      next[key] = v;
    }
    const keys = Object.keys(next);
    if (!keys.length && d.was === undefined) return GONE;
    const same = d.was !== undefined && keys.length === Object.keys(was).length && keys.every((k) => Object.prototype.hasOwnProperty.call(was, k) && next[k] === was[k]);
    return same ? d.was : next;
  }
  if (d.kind === "entries") {
    const next = d.entries.map((e, i) => emptied(e, storedOf(e, `${label} ${i + 1}`, group))).filter((v) => v !== GONE);
    if (!next.length && d.was === undefined) return GONE;
    const was = (d.was ?? []) as unknown[];
    const same = d.was !== undefined && next.length === was.length && next.every((v, i) => v === was[i]);
    return same ? d.was : next;
  }
  if (d.kind === "lines") {
    if (d.text === d.start) return d.was === undefined ? GONE : d.was;
    const list = storedList(d.text, d.was, d.numbers, within(group, label));
    // Only an added empty line: the list as it was.
    if (Array.isArray(d.was) && list.length === d.was.length && list.every((v, i) => v === (d.was as unknown[])[i])) return d.was;
    return list.length ? list : GONE;
  }
  const typed = d.text.trim();
  if (typed === d.start.trim()) return d.was === undefined ? GONE : d.was;
  if (!typed) return GONE;
  if (d.kind === "bool") return typed === "yes";
  if (d.loose) return ZEROS.test(typed) ? typed : (exactOf(typed) ?? typed);
  return d.kind === "number" ? numberOf(typed, within(group, label)) : typed;
}

/** A list entry the person emptied (an object or a list with nothing left in it, at any depth) is left out. */
function emptied(d: Draft, v: unknown): unknown {
  return v !== d.was && hollow(v) ? GONE : v;
}

/** An object or a list holding no value but nulls and empty objects and lists. */
function hollow(v: unknown): boolean {
  return v === null || (typeof v === "object" && Object.values(v as object).every(hollow));
}

/**
 * A list's lines back as stored: each untouched entry as it was (its placeholder kept, an entry that was only a
 * placeholder too, on its empty line), one entry per line, a number in a list of numbers; an empty line is dropped.
 */
function storedList(raw: string, was: unknown, numbers: boolean, label: string): unknown[] {
  const left = Array.isArray(was) ? [...was] : [];
  const out: unknown[] = [];
  for (const line of raw.split("\n").map((l) => l.trim())) {
    const i = left.findIndex((x) => formText(x).trim() === line);
    if (i >= 0) out.push(left.splice(i, 1)[0]);
    else if (line) out.push(numbers ? numberOf(line, label) : line);
  }
  return out;
}

/** The goals a parent goal may be picked from, by name, as the stored value names them (by key, or by id). */
function parentOptions(graph: GraphOut | undefined, entity: EntityDetail, current: string): { value: string; label: string }[] {
  const plain = (k: string) => k.trim().toLowerCase().replace(/[._\s]/g, "-");
  const own = (g: EntityOut) => g.id === current.trim() || plain(g.key) === plain(current);
  // The goal itself only when it is stored as its own parent, so it reads by its name.
  const goals = sortedGoals(graph).filter((g) => g.id !== entity.id || (current.trim() && own(g)));
  const byId = goals.some((g) => g.id === current.trim());
  const out = goals.map((g) => ({ value: byId ? g.id : g.key, label: shownTitle(g) }));
  const found = out.find((o) => o.value === current || plain(o.value) === plain(current));
  if (found) found.value = current;
  else if (current) out.unshift({ value: current, label: graph ? "Not in the Ground Truth" : "…" });
  return [{ value: "", label: "None" }, ...out];
}

function EditForm({
  entity,
  graph,
  busy,
  problems,
  onCancel,
  onSave,
}: {
  entity: EntityDetail;
  graph: GraphOut | undefined;
  busy: boolean;
  /** The goal fields' problems, from the last Save's 422 or the goal's goal_check. */
  problems: GoalProblem[];
  onCancel: () => void;
  onSave: (patch: { title: string; body: string | null; attrs: Record<string, unknown> }) => void;
}) {
  const [fields, setFields] = useState(() => attrFields(entity));
  const [title, setTitle] = useState(entity.title);
  const [body, setBody] = useState(entity.body ?? "");
  // Each attribute's draft, its lists, objects and their fields each as their stored type.
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, draftOf(entity.attrs?.[f.key], f.key, f.numeric)])),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  // The attributes removed with their x.
  const [gone, setGone] = useState<string[]>([]);
  const isGoal = entity.type === "goal";
  const [goal, setGoal] = useState<GoalDraft>(() => goalDraft(entity.attrs ?? {}));
  const addable = (KNOWN_ATTRS[entity.type] ?? []).filter((k) => !fields.some((f) => f.key === k));

  function submit(e: FormEvent) {
    e.preventDefault();
    // Only the attributes that changed: an untouched one is not rewritten.
    const out: Record<string, unknown> = Object.fromEntries(gone.filter((k) => entity.attrs?.[k] !== undefined).map((k) => [k, null]));
    for (const f of fields) {
      const was = entity.attrs?.[f.key];
      let v: unknown;
      try {
        v = storedOf(drafts[f.key], f.label);
      } catch (err) {
        setInvalid((err as Error).message);
        return;
      }
      if (v === was || (v === GONE && was === undefined)) continue;
      out[f.key] = v === GONE ? null : v; // null removes the key
    }
    if (isGoal) {
      // A stored value left as the form showed it ("1e-7", a number or text) saves untouched, not rewritten; a changed
      // Value, Start value or Weight takes only what a number holds exactly, as a new number field does.
      // Text the Weight box cannot read ("1e") reads as "": it is refused as an unreadable Value is, not saved as emptied.
      const weightBox = e.currentTarget instanceof HTMLFormElement ? e.currentTarget.elements.namedItem("weight") : null;
      if (weightBox instanceof HTMLInputElement && weightBox.validity.badInput) {
        setInvalid("Weight must be a number.");
        return;
      }
      const shown = goalDraft(entity.attrs ?? {});
      const patch = goalPatch(goal, entity.attrs ?? {});
      for (const [label, key] of [["Value", "target"], ["Start value", "start"], ["Weight", "weight"]] as const) {
        const raw = goal[key].trim();
        if (raw === shown[key].trim()) delete patch[key];
        else if (raw && exactOf(raw) === undefined) {
          setInvalid(`${label} must be a number.`);
          return;
        }
      }
      Object.assign(out, patch);
    }
    if (!title.trim()) {
      setInvalid("Title cannot be empty.");
      return;
    }
    setInvalid(null);
    onSave({ title: title.trim(), body: body.trim() ? body : null, attrs: out });
  }

  // An object or a list of entries is removed only with its x: emptying it keeps it, as an empty object or list.
  function removeAttr(key: string) {
    setFields((fs) => fs.filter((f) => f.key !== key));
    setGone((g) => [...g, key]);
  }

  function add(key: string) {
    if (!key) return;
    setFields((fs) => [...fs, { key, label: attrLabel(key) }]);
    setGone((g) => g.filter((k) => k !== key));
    setDrafts((a) => ({ ...a, [key]: draftOf(undefined, key) }));
  }

  const label = "flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";
  return (
    <form onSubmit={submit} aria-label="Edit" noValidate className="flex flex-col gap-3">
      <label className={label}>
        Title
        <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className={label}>
        Description
        <textarea className={INPUT} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {isGoal && <GoalFields draft={goal} onChange={setGoal} problems={problems} horizons={entity.goal_check?.horizons as PlanningHorizons | null | undefined} />}
      {fields.map((f) => (
        <DraftField
          key={f.key}
          attr={f.key}
          label={f.label}
          draft={drafts[f.key]}
          onChange={(d) => setDrafts((a) => ({ ...a, [f.key]: d }))}
          parents={(current) => parentOptions(graph, entity, current)}
          onRemove={drafts[f.key].kind === "object" || drafts[f.key].kind === "entries" ? () => removeAttr(f.key) : undefined}
          removeName="Remove attribute"
          missing={
            holdsPlaceholder(entity.attrs?.[f.key]) && (
              <Chip kind="warn" className="ml-1.5">
                Missing
              </Chip>
            )
          }
        />
      ))}
      {addable.length > 0 && (
        <label className={label}>
          Add attribute
          <select className={INPUT} value="" onChange={(e) => add(e.target.value)}>
            <option value="">Choose…</option>
            {addable.map((k) => (
              <option key={k} value={k}>
                {attrLabel(k)}
              </option>
            ))}
          </select>
        </label>
      )}
      {invalid && <Notice tone="error">{invalid}</Notice>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          Save
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <InfoTip label="saving" align="start">
          Saving locks this item: agents can then only propose changes to it. Empty entries are left out.
        </InfoTip>
      </div>
    </form>
  );
}

/**
 * A small icon button in the Edit form: adds or removes a list entry, an object field or an attribute. Its title is
 * the short action; its name says which group and entry it acts on ("Remove Reply targets entry 2").
 */
function EditIcon({
  icon,
  name,
  of,
  onClick,
  className = "self-start",
}: {
  icon: "plus" | "x";
  name: string;
  of: string;
  onClick: () => void;
  className?: string;
}) {
  return <Button variant="ghost" icon={icon} title={name} aria-label={of} className={`h-7 flex-none px-1.5 ${className}`} onClick={onClick} />;
}

/**
 * One attribute, field or list entry in the Edit form, as its draft's type: an object or a list entry by entry as a
 * group of its own fields (in turn), a list of words one line per entry, a yes or no as a two-choice picker. A list
 * adds an entry shaped like the others and an object a field (name and value); `onRemove` puts an x beside it.
 */
function DraftField({
  attr,
  label: name,
  draft: d,
  onChange,
  parents,
  missing,
  onRemove,
  removeName = "Remove field",
  part,
  path = name,
}: {
  /** The top-level attribute's key; none for a field or an entry in one. */
  attr?: string;
  label: string;
  draft: Draft;
  onChange: (d: Draft) => void;
  parents: (current: string) => { value: string; label: string }[];
  missing?: ReactNode;
  onRemove?: () => void;
  removeName?: string;
  /** The field's key, or the entry's number, in its object or list: marks the field with its controls. */
  part?: string;
  /** Its name with the groups it is in, naming its buttons: "Reply targets entry 2". */
  path?: string;
}) {
  const lines = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLFieldSetElement>(null);
  const label = `flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2${attr ? "" : " pl-3"}`;
  // Beside a group's name, or beside a field's input.
  const grouped = d.kind === "object" || d.kind === "entries";
  const remove = onRemove && <EditIcon icon="x" name={removeName} of={`Remove ${path}`} onClick={onRemove} className={grouped ? "self-start" : "mb-1 self-end"} />;
  if (grouped) {
    const parts: [string, string, Draft, boolean][] =
      d.kind === "object"
        ? d.fields.map(([k, p, fresh], i) => [fresh ? `new-${i}` : k, fresh ? "" : attrLabel(k), p, !!fresh])
        : d.entries.map((p, i) => [String(i), `${i + 1}`, p, false]);
    const set = (i: number, p: Draft) =>
      onChange(
        d.kind === "object"
          ? { ...d, fields: d.fields.map((x, j): Field => (j === i ? (x[2] ? [x[0], p, true] : [x[0], p]) : x)) }
          : { ...d, entries: d.entries.map((x, j) => (j === i ? p : x)) },
      );
    const drop = (i: number) =>
      onChange(d.kind === "object" ? { ...d, fields: d.fields.filter((_, j) => j !== i) } : { ...d, entries: d.entries.filter((_, j) => j !== i) });
    const typedName = (i: number) => (d.kind === "object" ? d.fields[i][0].trim() : "");
    const rename = (i: number, key: string) =>
      d.kind === "object" && onChange({ ...d, fields: d.fields.map((x, j): Field => (j === i ? [key, x[1], true] : x)) });
    // A new field's value is a number when typed as one and every other plain field is one, text otherwise; a new
    // entry is shaped like the first, in a box of lines where any other entry is.
    const plainKinds = d.kind === "object" ? d.fields.filter(([, p, f]) => !f && "text" in p && p.kind !== "lines").map(([, p]) => p.kind) : [];
    const numbers = plainKinds.length > 0 && plainKinds.every((k) => k === "number");
    const entry = (): Draft => {
      const blank = blankOf(d.kind === "entries" && d.entries[0] ? d.entries[0] : draftOf(Array.isArray(d.was) ? d.was[0] : ""));
      const multi = d.kind === "entries" && d.entries.some((e) => e.kind === "text" && (e.multi || e.start.includes("\n")));
      return blank.kind === "text" && multi ? { ...blank, multi } : blank;
    };
    const add = () => {
      onChange(
        d.kind === "object"
          ? { ...d, fields: [...d.fields, ["", { kind: "text", was: undefined, start: "", text: "", ...(numbers ? { loose: true } : {}) }, true]] }
          : { ...d, entries: [...d.entries, entry()] },
      );
      // The cursor on the new field's name, or the new entry's first input.
      requestAnimationFrame(() => box.current?.lastElementChild?.previousElementSibling?.querySelector<HTMLElement>("input, textarea, select")?.focus());
    };
    const group = (
      <fieldset ref={box} data-attr-field={attr} className={`flex min-w-0 flex-1 flex-col gap-2${attr ? "" : " pl-3"}`}>
        <legend className={`${label} mb-1`}>
          <span>
            {name}
            {missing}
          </span>
        </legend>
        {parts.map(([k, partLabel, p, fresh], i) =>
          fresh ? (
            <div key={k} className="flex items-start gap-1 pl-3">
              <input
                className={`${INPUT} min-w-0 flex-1`}
                aria-label="Field name"
                placeholder="Name"
                value={d.kind === "object" ? d.fields[i][0] : ""}
                onChange={(e) => rename(i, e.target.value)}
              />
              <input
                className={`${INPUT} min-w-0 flex-1`}
                aria-label="Field value"
                placeholder="Value"
                value={"text" in p ? p.text : ""}
                onChange={(e) => "text" in p && set(i, { ...p, text: e.target.value })}
              />
              <EditIcon icon="x" name="Remove field" of={`Remove ${path} ${typedName(i) ? `field ${typedName(i)}` : "new field"}`} onClick={() => drop(i)} />
            </div>
          ) : (
            <DraftField
              key={k}
              label={partLabel}
              draft={p}
              onChange={(next) => set(i, next)}
              parents={parents}
              onRemove={() => drop(i)}
              removeName={d.kind === "entries" ? "Remove entry" : undefined}
              part={d.kind === "entries" ? partLabel : k}
              path={`${path} ${d.kind === "entries" ? "entry" : "field"} ${partLabel}`}
            />
          ),
        )}
        <EditIcon
          icon="plus"
          name={d.kind === "object" ? "Add field" : "Add entry"}
          of={`${d.kind === "object" ? "Add field" : "Add entry"} to ${path}`}
          onClick={add}
        />
      </fieldset>
    );
    return remove ? (
      <div className="flex items-start gap-1" data-attr-part={part ?? attr}>
        {group}
        {remove}
      </div>
    ) : (
      group
    );
  }
  const set = (text: string) => onChange({ ...d, text });
  // A new line for a list of words; the person types the entry on it.
  const addLine = () => {
    const text = d.text && !d.text.endsWith("\n") ? `${d.text}\n` : d.text;
    set(text);
    requestAnimationFrame(() => {
      const el = lines.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };
  const wrapped = !!remove || d.kind === "lines";
  const field = (
    <label className={wrapped ? label.replace(" pl-3", "") : label} data-attr-field={attr}>
      <span>
        {name}
        {missing}
      </span>
      {d.kind === "parent" ? (
        <select className={INPUT} value={d.text} onChange={(e) => set(e.target.value)}>
          {parents(d.text).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : d.kind === "bool" ? (
        <select className={INPUT} value={d.text} onChange={(e) => set(e.target.value)}>
          {!d.text && <option value="">Choose…</option>}
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      ) : d.kind === "lines" || d.start.includes("\n") || ("multi" in d && d.multi) ? (
        <textarea ref={lines} className={INPUT} rows={Math.max(2, d.text.split("\n").length)} value={d.text} onChange={(e) => set(e.target.value)} />
      ) : (
        <input
          className={INPUT}
          type={d.kind === "day" ? "date" : "text"}
          inputMode={d.kind === "number" ? "decimal" : undefined}
          value={d.text}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </label>
  );
  if (!wrapped) return field;
  return (
    <div className={`flex flex-col gap-1${attr ? "" : " pl-3"}`} data-attr-part={part ?? attr}>
      <div className="flex items-end gap-1">
        <div className="flex min-w-0 flex-1 flex-col">{field}</div>
        {remove}
      </div>
      {d.kind === "lines" && <EditIcon icon="plus" name="Add entry" of={`Add entry to ${path}`} onClick={addLine} />}
    </div>
  );
}

/** What one revision changed: "milestone: Beta → GA", "Title: A → B". */
function revisionChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  graph?: GraphOut,
  goal = false,
) {
  if (!before) return ["Created"];
  // A goal's name as shown: no "[n]" stored before the guard.
  const words = (k: string, v: unknown) => (goal && k === "title" ? withoutPlaceholders(asText(v)) : asText(v));
  if (!after) return ["Removed"];
  const out: string[] = [];
  for (const [k, name] of [
    ["title", "Title"],
    ["body", "Description"],
    ["status", "Status"],
  ] as const) {
    if (asText(before[k]) !== asText(after[k])) out.push(k === "body" ? "Description changed" : `${name}: ${words(k, before[k])} → ${words(k, after[k])}`);
  }
  const was = (before.attrs ?? {}) as Record<string, unknown>;
  const now = (after.attrs ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (asText(was[k]) === asText(now[k])) continue;
    const label = attrLabel(k);
    if (!(k in now)) out.push(`${label} removed`);
    else if (!(k in was)) out.push(`${label}: ${attrValue(k, now[k], graph)}`);
    else out.push(`${label}: ${attrValue(k, was[k], graph)} → ${attrValue(k, now[k], graph)}`);
  }
  return out;
}

/** The entry's history: its revisions, newest first. Reloads when the entry changes. */
function History({ entityId, updatedAt, graph, goal }: { entityId: string; updatedAt: string; graph: GraphOut | undefined; goal: boolean }) {
  const q = useQuery(`baseline-revisions:${entityId}:${updatedAt}`, () =>
    unwrap(
      api.GET("/v1/baseline/entities/{entity_id}/revisions", {
        params: { path: { entity_id: entityId }, query: { limit: 20 } },
      }),
    ),
    { keepPrevious: true },
  );
  const rows = q.data ?? [];
  return (
    <InspectorSection label="History" testId="entity-history">
      {q.loading && !q.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-text2">No changes recorded</p>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="History">
          {rows.map((r) => (
            <li key={r.id} className="text-sm">
              <span className="tnum text-text2">{formatDateTime(r.created_at)}</span>{" "}
              {revisionChanges(r.before, r.after, graph, goal).join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

/** H1: who may record a decision records one about a blocker (Propose decision, about it). */
function RecordDecision({ entity }: { entity: EntityOut }) {
  const { can } = useMe();
  if (!can("create_decision")) return null;
  const href = `/company/decisions?subject=${encodeURIComponent(`blocker:${entity.id}`)}&ref=${encodeURIComponent(entity.title)}&propose=1`;
  return (
    <InspectorSection label="Decisions">
      <p className="flex flex-wrap gap-3 text-sm">
        <Link href={href} className="font-medium text-accent-ink hover:underline">
          Record a decision
        </Link>
        <Link href={`/company/decisions?subject=${encodeURIComponent(`blocker:${entity.id}`)}&class=all`} className="font-medium text-accent-ink hover:underline">
          Decisions about this blocker
        </Link>
      </p>
    </InspectorSection>
  );
}
