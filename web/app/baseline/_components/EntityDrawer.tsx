"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";
import { Button, Chip, GoalTag, InfoTip, Inspector, InspectorSection, Notice } from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, unwrap, type EdgeOut, type EntityDetail, type EntityOut, type GraphOut, type Schemas } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { EvidenceChip } from "./EvidenceChip";
import {
  AddDependencyForm,
  CiteSourceForm,
  ConfirmRemove,
  ContributionSelect,
  endName,
  LinkToGoalForm,
  type NewLink,
} from "./LinkTools";
import { LIMIT_LABEL, PromoteForm, suggestedBlocker } from "./PromoteBlocker";
import {
  ConfidenceRing,
  contributionOf,
  ContributionPips,
  DEFAULT_LOW,
  DeliveryChip,
  formatValue,
  LockBadge,
  NodeStatusBadge,
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
  goal: [
    { key: "weight", label: "Weight", numeric: true },
    { key: "metric", label: "Metric" },
    { key: "target", label: "Target" },
    { key: "horizon", label: "Horizon" },
  ],
};

/** Attributes the edit form offers to add when the entry lacks them, per entity type. */
const KNOWN_ATTRS: Partial<Record<EntityOut["type"], string[]>> = {
  feature: ["milestone", "size", "evidence_gap", "confidence", "priority_note"],
  goal: ["current"],
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
  /** For a blocker: opens its blocker inspector (#340). */
  onOpenBlocker?: () => void;
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
  onOpenBlocker,
}: Props) {
  const q = useQuery(`baseline-entity:${entity.id}`, () =>
    unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: entity.id } } })),
  );
  const onAuth = useAuthRedirect();
  const [editing, setEditing] = useState(false);
  const [promoting, setPromoting] = useState(promote && canWrite);
  // Reject (a proposed item) or Archive (a confirmed one) asks for the reason first.
  const [asking, setAsking] = useState<"reject" | "archive" | null>(null);
  // Link to goal, Add dependency or Cite a source item, open below its section.
  const [adding, setAdding] = useState<"goal" | "dependency" | "cite" | null>(null);
  const [removingEvidence, setRemovingEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const d = q.data;
  const title = d?.title ?? entity.title;
  const tag = tags.get(entity.id);
  const root = useRef<HTMLDivElement>(null);

  // Below the tables (narrow screens), bring the inspector into view when it opens.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1100px)").matches) root.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      if (res.response.status === 202) {
        setEditing(false);
        return "The item is locked, so your change was saved as a proposal for an approver.";
      }
      await unwrap(Promise.resolve(res));
      setEditing(false);
      return "Saved. The item is now locked against agent changes.";
    });

  const decide = (action: "confirm" | "reject" | "archive", note?: string) =>
    write(async () => {
      const params = { params: { path: { entity_id: entity.id } }, body: { note: note || null } };
      if (action === "confirm") await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", params));
      // Archiving a confirmed item rejects it, as the API does: it leaves the baseline, its history keeps why.
      else await unwrap(api.POST("/v1/baseline/entities/{entity_id}/reject", params));
      setAsking(null);
      if (action === "confirm") return `Confirmed “${title}”.`;
      if (action === "archive") return `Archived “${title}”: it leaves the baseline; its history keeps the reason.`;
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

  return (
    <div role="dialog" aria-label={title} aria-modal="false" data-testid="entity-drawer" ref={root} className="scroll-mt-4">
      <Inspector
        label={title}
        eyebrow={
          <>
            {TYPE_LABEL[entity.type]} · <span className="font-mono">{d?.key ?? entity.key}</span>
          </>
        }
        title={title}
        chips={
          <>
            {tag && <GoalTag id={tag} proposed={(d ?? entity).status === "proposed"} />}
            <NodeStatusBadge status={(d ?? entity).status} hero />
            <DeliveryChip value={(d ?? entity).type === "feature" ? (d ?? entity).attrs?.status : undefined} hero />
            <LockBadge entity={d ?? entity} meId={meId} hero />
            {!canComment && <Chip hero>View only</Chip>}
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
        action={
          <Button variant="hero" icon="x" onClick={onClose} aria-label="Close">
            Close
          </Button>
        }
        stats={[
          { label: "Confidence", figure: <ConfidenceRing value={(d ?? entity).confidence} low={low} size={44} /> },
          { label: "Evidence", value: evidence },
          { label: "Links", value: links ?? "–" },
          { label: "Proposals", value: proposals ?? "–", tone: proposals ? "warn" : undefined },
        ]}
      >
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
                  <span className="min-w-0 truncate" data-testid="lock-note">
                    Locked by {d.locked_by === meId ? "you" : d.locked_by ? `member ${d.locked_by.slice(0, 8)}` : "a person"}
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
                <EditForm entity={d} busy={busy} onCancel={() => setEditing(false)} onSave={save} />
              </InspectorSection>
            ) : (
              <>
                {d.body && (
                  <InspectorSection label="Description">
                    <p className="line-clamp-4 whitespace-pre-line text-text2" title={d.body}>
                      {d.body}
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
                <Attrs attrs={d.attrs} />
              </>
            )}

            <History entityId={d.id} updatedAt={d.updated_at} />

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
                    {d.status === "confirmed" && (
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
          ? "Reject this proposed item? It leaves the baseline."
          : "Archive this item? It leaves the baseline and the Ledger; its history keeps it."}
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

function Attrs({ attrs }: { attrs: Record<string, unknown> }) {
  // The suggested-blocker mark has its own section.
  const entries = Object.entries(attrs ?? {}).filter(([k]) => k !== "proposed_blocker");
  if (entries.length === 0) return null;
  return (
    <InspectorSection label="Attributes">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5" aria-label="Attributes">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text2">{k}</dt>
            <dd className="tnum truncate font-semibold" data-attr={k} title={formatValue(v)}>
              {k === "status" ? <DeliveryChip value={v} /> : formatValue(v)}
            </dd>
          </div>
        ))}
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
      {tags.get(id) && <GoalTag id={tags.get(id)!} />}
      <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => onOpen(id)}>
        {titleOf(graph, id)}
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
                  {contribution && (
                    <span className="flex flex-none items-center gap-2" data-testid="contribution">
                      <ContributionPips value={value} proposed={e.status === "proposed"} />
                      {canWrite ? (
                        <span className="w-[7.5rem]">
                          <ContributionSelect
                            label={`Contribution to ${name}`}
                            value={String(value)}
                            disabled={busy}
                            onChange={(v) => onPatch(e, { attrs: { contribution: Number(v) } }, `Contribution set to ${v}.`)}
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

type AttrField = { key: string; label: string; numeric?: boolean; json?: boolean };

/** The labelled fields for the type, then every other attribute the entry has (the suggested-blocker mark aside). */
function attrFields(entity: EntityDetail): AttrField[] {
  const fields: AttrField[] = [...(EDIT_ATTRS[entity.type] ?? [])];
  for (const [key, v] of Object.entries(entity.attrs ?? {})) {
    if (key === "proposed_blocker" || fields.some((f) => f.key === key)) continue;
    fields.push({ key, label: key, numeric: typeof v === "number", json: v != null && typeof v === "object" });
  }
  return fields;
}

const asText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function EditForm({
  entity,
  busy,
  onCancel,
  onSave,
}: {
  entity: EntityDetail;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: { title: string; body: string | null; attrs: Record<string, unknown> }) => void;
}) {
  const [fields, setFields] = useState(() => attrFields(entity));
  const [title, setTitle] = useState(entity.title);
  const [body, setBody] = useState(entity.body ?? "");
  const [attrs, setAttrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, asText(entity.attrs?.[f.key])])),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const addable = (KNOWN_ATTRS[entity.type] ?? []).filter((k) => !fields.some((f) => f.key === k));

  function submit(e: FormEvent) {
    e.preventDefault();
    // Only the attributes that changed: an untouched one is not rewritten.
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = attrs[f.key].trim();
      if (raw === asText(entity.attrs?.[f.key]).trim()) continue;
      if (!raw) {
        out[f.key] = null; // removes the key
      } else if (f.numeric) {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setInvalid(`${f.label} must be a number.`);
          return;
        }
        out[f.key] = n;
      } else if (f.json) {
        try {
          out[f.key] = JSON.parse(raw);
        } catch {
          setInvalid(`${f.label} must be valid JSON.`);
          return;
        }
      } else {
        out[f.key] = raw;
      }
    }
    if (!title.trim()) {
      setInvalid("Title cannot be empty.");
      return;
    }
    setInvalid(null);
    onSave({ title: title.trim(), body: body.trim() ? body : null, attrs: out });
  }

  function add(key: string) {
    if (!key) return;
    setFields((fs) => [...fs, { key, label: key }]);
    setAttrs((a) => ({ ...a, [key]: "" }));
  }

  const label = "flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";
  return (
    <form onSubmit={submit} aria-label="Edit" className="flex flex-col gap-3">
      <label className={label}>
        Title
        <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className={label}>
        Description
        <textarea className={INPUT} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {fields.map((f) => (
        <label key={f.key} className={label}>
          {f.label}
          <input
            className={INPUT}
            inputMode={f.numeric ? "decimal" : undefined}
            value={attrs[f.key]}
            onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      {addable.length > 0 && (
        <label className={label}>
          Add attribute
          <select className={INPUT} value="" onChange={(e) => add(e.target.value)}>
            <option value="">Choose…</option>
            {addable.map((k) => (
              <option key={k} value={k}>
                {k}
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
          Saving locks this item: agents can then only propose changes to it.
        </InfoTip>
      </div>
    </form>
  );
}

/** What one revision changed: "milestone: Beta → GA", "Title: A → B". */
function revisionChanges(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined) {
  if (!before) return ["Created"];
  if (!after) return ["Removed"];
  const out: string[] = [];
  for (const [k, name] of [
    ["title", "Title"],
    ["body", "Description"],
    ["status", "Status"],
  ] as const) {
    if (asText(before[k]) !== asText(after[k])) out.push(k === "body" ? "Description changed" : `${name}: ${asText(before[k])} → ${asText(after[k])}`);
  }
  const was = (before.attrs ?? {}) as Record<string, unknown>;
  const now = (after.attrs ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (asText(was[k]) === asText(now[k])) continue;
    if (!(k in now)) out.push(`${k} removed`);
    else if (!(k in was)) out.push(`${k}: ${formatValue(now[k])}`);
    else out.push(`${k}: ${formatValue(was[k])} → ${formatValue(now[k])}`);
  }
  return out;
}

/** The entry's history: its revisions, newest first. Reloads when the entry changes. */
function History({ entityId, updatedAt }: { entityId: string; updatedAt: string }) {
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
              {revisionChanges(r.before, r.after).join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

/** H1: commenters and above record a decision about a blocker (Propose decision, about it). */
function RecordDecision({ entity }: { entity: EntityOut }) {
  const { role } = useMe();
  if (!hasRole(role, "commenter")) return null;
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
