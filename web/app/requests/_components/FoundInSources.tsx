"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button, Chip, Notice, Panel, SegmentedControl, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

type Candidate = Schemas["CandidateOut"];
type Channel = Candidate["channel"];
type Kind = Schemas["RequestCreate"]["requester_kind"];

const CHANNEL_LABEL: Record<Channel, string> = {
  support: "Support",
  sales: "Sales",
  team: "Team",
  slack: "Slack",
  meeting: "Meeting",
  doc: "Doc",
  other: "Other",
};
const KINDS: { value: Kind; label: string }[] = [
  { value: "customer", label: "Customer" },
  { value: "team", label: "Team" },
  { value: "unknown", label: "Unknown" },
];
const SHARING =
  "Filing shares this item: everyone who can see Requests will read your text, the item's title and link, and this excerpt";

/**
 * Found in your sources (C1, decision S6): possible requests Oracle's triage spotted in the
 * signed-in person's own sources. Only they see them, and only while some are open. Each is
 * filed as a request (filing shares the item in full) or dismissed. `refresh` changes when a
 * triage run ends, so new finds show.
 */
export function FoundInSources({ refresh }: { refresh: string }) {
  const q = useQuery(`request-candidates:${refresh}`, () =>
    unwrap(api.GET("/v1/request-candidates", { params: { query: { status: "open" } } })),
  );
  const [filing, setFiling] = useState<Candidate | null>(null);
  const [filed, setFiled] = useState<Schemas["RequestOut"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = q.data ?? [];

  async function dismiss(c: Candidate) {
    setError(null);
    try {
      await unwrap(api.POST("/v1/request-candidates/{candidate_id}/dismiss", { params: { path: { candidate_id: c.id } } }));
      q.setData((rows) => rows?.filter((r) => r.id !== c.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      {filed && (
        <Notice tone="pass" testId="filed-notice">
          Filed &ldquo;{filed.title}&rdquo; as a new request.
        </Notice>
      )}
      {open.length > 0 && (
        <Panel testId="found-in-sources" title={`Oracle found ${open.length} possible request${open.length === 1 ? "" : "s"} in your sources`}>
          <p className="px-4 pt-3 text-sm text-text2">Only you see these until you file one.</p>
          {error && (
            <div className="px-4 pt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <ul className="divide-y divide-line">
            {open.map((c) => (
              <li key={c.id} data-testid="found-item" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-semibold" title={c.body ?? c.title}>
                    {c.title}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-sm text-text2">
                    <Chip kind="line">{CHANNEL_LABEL[c.channel]}</Chip>
                    <span className="truncate">{c.source.title ?? "Untitled item"}</span>
                  </span>
                </div>
                <div className="flex flex-none gap-2">
                  <Button variant="solid" onClick={() => setFiling(c)}>
                    File as request
                  </Button>
                  <Button variant="ghost" onClick={() => dismiss(c)}>
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {filing && (
        <FileDialog
          candidate={filing}
          onClose={() => setFiling(null)}
          onFiled={(request) => {
            setFiling(null);
            setFiled(request);
            q.setData((rows) => rows?.filter((r) => r.id !== filing.id));
          }}
        />
      )}
    </>
  );
}

/**
 * Add request, pre-filled from a found item. Before filing it shows what everyone else will
 * read: the sharing line and the item's excerpt (decided 2026-10-21, C1 "Found items").
 */
function FileDialog({
  candidate,
  onClose,
  onFiled,
}: {
  candidate: Candidate;
  onClose: () => void;
  onFiled: (request: Schemas["RequestOut"]) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const [title, setTitle] = useState(candidate.title);
  const [body, setBody] = useState(candidate.body ?? "");
  const [channel, setChannel] = useState<Channel>(candidate.channel);
  const [askedBy, setAskedBy] = useState(candidate.requester_name ?? "");
  const [kind, setKind] = useState<Kind>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Give the request a title");
    setBusy(true);
    setError(null);
    try {
      const request = await unwrap(
        api.POST("/v1/request-candidates/{candidate_id}/file", {
          params: { path: { candidate_id: candidate.id } },
          body: { title: title.trim(), body: body.trim() || null, channel, requester_name: askedBy.trim() || null, requester_kind: kind },
        }),
      );
      onFiled(request);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const src = candidate.source;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-request-title"
        tabIndex={-1}
        className="w-full max-w-xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="file-request-title" className="font-display text-xl font-bold tracking-heading">
            Add request
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Title
            <input data-autofocus className={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            What did they ask for?
            <textarea className={INPUT} rows={3} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Where it came from
              <select className={INPUT} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Asked by
              <input className={INPUT} value={askedBy} maxLength={200} onChange={(e) => setAskedBy(e.target.value)} placeholder="Name as given" />
            </label>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-text2">Customer or team</span>
            <SegmentedControl label="Customer or team" size="sm" items={KINDS} value={kind} onChange={setKind} />
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface2 p-3">
            <p data-testid="filing-shares" className="text-sm font-semibold">
              {SHARING}
            </p>
            <p className="min-w-0 text-sm break-words">
              {src.url ? (
                <a className="font-semibold text-accent-ink underline" href={src.url} target="_blank" rel="noreferrer">
                  {src.title ?? src.url}
                </a>
              ) : (
                <span className="font-semibold">{src.title ?? "Untitled item"}</span>
              )}
            </p>
            {src.excerpt && (
              <blockquote data-testid="filing-excerpt" className="border-l-2 border-line-strong pl-3 text-sm break-words text-text2">
                {src.excerpt}
              </blockquote>
            )}
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              Add request
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
