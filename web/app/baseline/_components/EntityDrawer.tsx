"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";
import { Button, Chip, GoalTag, InfoTip, Inspector, InspectorSection, Notice } from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, unwrap, type EdgeOut, type EntityDetail, type EntityOut, type GraphOut } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { EvidenceChip } from "./EvidenceChip";
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
}: Props) {
  const q = useQuery(`baseline-entity:${entity.id}`, () =>
    unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: entity.id } } })),
  );
  const onAuth = useAuthRedirect();
  const [editing, setEditing] = useState(false);
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

            {editing ? (
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
                <Attrs attrs={d.attrs} />
              </>
            )}

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

            {canWrite && !editing && (
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
  const entries = Object.entries(attrs ?? {});
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
  const fields = EDIT_ATTRS[entity.type] ?? [];
  const [title, setTitle] = useState(entity.title);
  const [body, setBody] = useState(entity.body ?? "");
  const [attrs, setAttrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, entity.attrs?.[f.key] == null ? "" : String(entity.attrs[f.key])])),
  );
  const [invalid, setInvalid] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = attrs[f.key].trim();
      if (!raw) {
        out[f.key] = null; // removes the key
      } else if (f.numeric) {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setInvalid(`${f.label} must be a number.`);
          return;
        }
        out[f.key] = n;
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
