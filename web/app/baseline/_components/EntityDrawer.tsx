"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type EdgeOut, type EntityDetail, type EntityOut, type GraphOut } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { EvidenceChip } from "./EvidenceChip";
import { ConfidenceBadge, DEFAULT_LOW, formatValue, LockBadge, NodeStatusBadge, titleOf } from "./common";

const TYPE_LABEL: Record<EntityOut["type"], string> = {
  goal: "Goal",
  product: "Product",
  feature: "Feature",
  requirement: "Requirement",
  constraint: "Constraint",
  decision: "Decision",
  person: "Person",
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
  meId?: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Called after a write, so the lists behind the drawer refresh. */
  onChanged: () => void;
};

/** Right-side panel with one entity: its links, evidence and (for approvers) edit and unlock. */
export function EntityDrawer({ entity, graph, low = DEFAULT_LOW, canWrite, meId, onClose, onOpen, onChanged }: Props) {
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

  return (
    <div
      role="dialog"
      aria-label={title}
      aria-modal="false"
      data-testid="entity-drawer"
      className="fixed top-0 right-0 bottom-0 z-40 flex w-[30rem] max-w-full flex-col border-l border-neutral-200 bg-white shadow-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs text-neutral-500">
            {TYPE_LABEL[entity.type]} · <span className="font-mono">{d?.key ?? entity.key}</span>
          </p>
          <h2 className="mt-0.5 text-lg font-semibold text-neutral-900">{title}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {q.error && <ErrorNote>{q.error}</ErrorNote>}
        {q.loading && !d && <Loading />}
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && (
          <p role="status" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900">
            {notice}
          </p>
        )}
        {d && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <NodeStatusBadge status={d.status} />
              <ConfidenceBadge value={d.confidence} low={low} />
              <LockBadge entity={d} meId={meId} />
              {d.open_proposals > 0 && (
                <Badge tone="blue">
                  {d.open_proposals} open proposal{d.open_proposals === 1 ? "" : "s"}
                </Badge>
              )}
            </div>

            {d.locked && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
                <p className="text-neutral-700" data-testid="lock-note">
                  Locked by {d.locked_by === meId ? "you" : d.locked_by ? `member ${d.locked_by.slice(0, 8)}` : "a person"}
                  {d.locked_at && ` on ${formatDateTime(d.locked_at)}`}. Agents can only propose changes.
                </p>
                {canWrite && (
                  <Button size="sm" onClick={unlock} disabled={busy}>
                    Unlock
                  </Button>
                )}
              </div>
            )}

            {editing ? (
              <EditForm entity={d} busy={busy} onCancel={() => setEditing(false)} onSave={save} />
            ) : (
              <>
                {d.body && <p className="whitespace-pre-line text-neutral-700">{d.body}</p>}
                <Attrs attrs={d.attrs} />
                {canWrite && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setNotice(null);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </>
            )}

            <Links detail={d} graph={graph} onOpen={onOpen} />

            <Section title={`Evidence (${d.evidence.length})`}>
              {d.evidence.length === 0 ? (
                <p className="text-neutral-500">Nothing cites this yet.</p>
              ) : (
                <ul className="flex flex-col items-start gap-2" aria-label="Evidence">
                  {d.evidence.map((ev) => (
                    <li key={ev.id} className="flex max-w-full items-center gap-2">
                      <EvidenceChip evidence={ev} low={low} />
                      <span className="truncate text-xs text-neutral-500">
                        {ev.ref ?? ev.url}
                        {ev.retrieved_at && ` · ${formatDate(ev.retrieved_at)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Attrs({ attrs }: { attrs: Record<string, unknown> }) {
  const entries = Object.entries(attrs ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" aria-label="Attributes">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500">{k}</dt>
          <dd className="text-neutral-800" data-attr={k}>
            {formatValue(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Links({ detail, graph, onOpen }: { detail: EntityDetail; graph: GraphOut | undefined; onOpen: (id: string) => void }) {
  const out = (t: EdgeOut["type"]) => detail.edges_out.filter((e) => e.type === t && e.status !== "rejected");
  const inn = (t: EdgeOut["type"]) => detail.edges_in.filter((e) => e.type === t && e.status !== "rejected");
  const link = (id: string) => (
    <button type="button" className="text-left text-neutral-900 underline-offset-2 hover:underline" onClick={() => onOpen(id)}>
      {titleOf(graph, id)}
    </button>
  );
  const list = (title: string, edges: EdgeOut[], end: "src_id" | "dst_id") =>
    edges.length > 0 && (
      <Section title={title}>
        <ul className="space-y-1" aria-label={title}>
          {edges.map((e) => (
            <li key={e.id} className="flex items-center gap-2">
              {link(e[end])}
              {e.status === "proposed" && <Badge tone="blue">Proposed</Badge>}
            </li>
          ))}
        </ul>
      </Section>
    );

  const supports = out("supports");
  const supportedBy = inn("supports");
  const contribution = (e: EdgeOut) => {
    const c = Number(e.attrs?.contribution ?? 0);
    return Number.isFinite(c) ? c : 0;
  };
  const supportList = (title: string, edges: EdgeOut[], end: "src_id" | "dst_id") =>
    edges.length > 0 && (
      <Section title={title}>
        <ul className="space-y-1" aria-label={title}>
          {[...edges]
            .sort((a, b) => contribution(b) - contribution(a))
            .map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {link(e[end])}
                  {e.status === "proposed" && <Badge tone="blue">Proposed</Badge>}
                </span>
                <span
                  className="text-xs text-neutral-500"
                  title="Contribution, 0 (none) to 3 (strong)"
                  data-testid="contribution"
                >
                  contribution {contribution(e)}/3
                </span>
              </li>
            ))}
        </ul>
      </Section>
    );

  return (
    <>
      {supportList("Supports", supports, "dst_id")}
      {supportList("Supported by", supportedBy, "src_id")}
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

  const input = "mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none";
  return (
    <form onSubmit={submit} aria-label="Edit" className="space-y-3 rounded-md border border-neutral-200 p-3">
      <label className="block text-xs font-medium text-neutral-600">
        Title
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block text-xs font-medium text-neutral-600">
        Description
        <textarea className={input} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {fields.map((f) => (
        <label key={f.key} className="block text-xs font-medium text-neutral-600">
          {f.label}
          <input
            className={input}
            inputMode={f.numeric ? "decimal" : undefined}
            value={attrs[f.key]}
            onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      <p className="text-xs text-neutral-500">Saving locks this item: agents can then only propose changes to it.</p>
      {invalid && <ErrorNote>{invalid}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          Save
        </Button>
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
