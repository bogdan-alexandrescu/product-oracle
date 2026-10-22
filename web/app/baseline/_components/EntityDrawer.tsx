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
}: Props) {
  const q = useQuery(`baseline-entity:${entity.id}`, () =>
    unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: entity.id } } })),
  );
  const onAuth = useAuthRedirect();
  const [editing, setEditing] = useState(false);
  const [promoting, setPromoting] = useState(promote && canWrite);
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
            {suggestion && (
              <Chip kind="warn" hero data-testid="suggested-blocker">
                Suggested blocker
              </Chip>
            )}
            {blocker && (
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

            <Links detail={d} graph={graph} tags={tags} onOpen={onOpen} />

            <InspectorSection label="Evidence" tools={<span className="tnum text-text">{d.evidence.length}</span>}>
              {d.evidence.length === 0 ? (
                <p className="text-text2">None yet</p>
              ) : (
                <ul className="flex flex-col gap-1.5" aria-label="Evidence">
                  {d.evidence.map((ev) => (
                    <li key={ev.id} className="flex min-h-8 max-w-full min-w-0 items-center gap-2" data-testid="evidence-row">
                      <EvidenceChip evidence={ev} low={low} />
                      <span className="min-w-0 flex-1 truncate text-sm text-text2" title={ev.ref ?? ev.url ?? undefined}>
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
                    </li>
                  ))}
                </ul>
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

            {canWrite && !editing && !(promoting && suggestion) && (
              <InspectorSection>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setNotice(null);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </InspectorSection>
            )}
          </>
        )}
      </Inspector>
    </div>
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
}: {
  detail: EntityDetail;
  graph: GraphOut | undefined;
  tags: Map<string, string>;
  onOpen: (id: string) => void;
}) {
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
        <ul aria-label={title}>
          {(contribution ? [...edges].sort((a, b) => contributionOf(b.attrs) - contributionOf(a.attrs)) : edges).map((e) => (
            <li key={e.id} className="flex min-h-8 min-w-0 items-center gap-2.5">
              <span className="min-w-0 flex-1">{link(e[end])}</span>
              {e.status === "proposed" && <Chip kind="warn">Proposed</Chip>}
              {contribution && (
                <span className="flex flex-none items-center gap-2" data-testid="contribution">
                  <ContributionPips value={contributionOf(e.attrs)} proposed={e.status === "proposed"} />
                  <span className="tnum font-semibold">
                    <span className="sr-only">contribution </span>
                    {contributionOf(e.attrs)}/3
                  </span>
                </span>
              )}
            </li>
          ))}
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
