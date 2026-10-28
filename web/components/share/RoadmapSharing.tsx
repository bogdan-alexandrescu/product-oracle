"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button, DataTable, Icon, LinkButton, Notice, Panel, toast, useFocusTrap, type Column } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { dateBlocksOf } from "@/components/PublishView";
import { formatDate, formatDateTime, formatShortDate, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Doc = Pick<Schemas["DocumentSummary"], "slug" | "title" | "kind" | "audience" | "latest_version">;
type Audience = Schemas["ShareLinkOut"]["audience"];
type Link_ = Schemas["ShareLinkOut"];
type Created = { url: string; passcode: string; expires_at: string };
type Expiry = NonNullable<Schemas["ShareLinkIn"]["expires_in"]>;

const AUDIENCES: { key: Audience; label: string }[] = [
  { key: "board", label: "Board" },
  { key: "team", label: "Team" },
  { key: "engineering", label: "Engineering" },
  { key: "public", label: "Public" },
];
const audienceLabel = (a: Audience) => AUDIENCES.find((x) => x.key === a)!.label;
const isAudience = (v: string | null): v is Audience => !!v && AUDIENCES.some((a) => a.key === v);

// O5-Q3: required, 14 days preselected, 90 days at most.
const EXPIRIES: { key: Expiry; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "14d", label: "14 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days (the most)" },
];
const STATE_LABEL: Record<Link_["state"], string> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const SHOWN_ONCE = "This passcode is shown once. Send it apart from the link.";
const LABEL = "mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2";

/** The app's modal frame: a scrim, a titled panel, focus kept inside, Escape closes. */
function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, true, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="w-full max-w-lg min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line pr-2 pl-5 max-[600px]:pl-4">
          <h2 id={id} className="min-w-0 flex-1 font-display text-lg font-bold break-words tracking-heading">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-9 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="space-y-3.5 px-5 py-4 text-[15px] leading-6 max-[600px]:px-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">{footer}</div>
      </div>
    </div>
  );
}

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast({ message: `${what} copied` }),
    () => toast({ message: `Select the ${what.toLowerCase()} and copy it` }),
  );
}

/** A value shown once (the link's address or its passcode), read-only, with Copy. */
function ShownOnce({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <div className="flex gap-2">
        <input id={id} readOnly value={value} className={`${INPUT} font-mono`} onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={() => copy(value, label)}>{copyLabel}</Button>
      </div>
    </div>
  );
}

/** Board · Team · Engineering · Public: one rendering of the same roadmap (spec-O5 §1). */
export function AudienceSwitch({ value, onChange, showPublic }: { value: Audience; onChange: (a: Audience) => void; showPublic: boolean }) {
  const items = AUDIENCES.filter((a) => a.key !== "public" || showPublic);
  return (
    <div role="radiogroup" aria-label="Audience" className="inline-flex max-w-full flex-none overflow-x-auto rounded-button border border-line-strong bg-surface">
      {items.map((a) => {
        const on = a.key === value;
        return (
          <button
            key={a.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(a.key)}
            className={`flex h-9 items-center border-r border-line px-3.5 text-[15px] font-medium whitespace-nowrap last:border-r-0 ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

/** The version as its audience reads it: the export's own HTML (or the Public page), never a client-side copy. */
function AudienceView({ doc, n, audience }: { doc: string; n: number; audience: Audience }) {
  const q = useQuery(`audience-view|${doc}|${n}|${audience}`, () =>
    audience === "public"
      ? unwrap<string>(api.GET("/v1/roadmaps/{doc}/versions/{n}/public-preview", { params: { path: { doc, n } }, parseAs: "text" }))
      : unwrap<string>(
          api.GET("/v1/documents/{doc}/versions/{n}/export", { params: { path: { doc, n }, query: { format: "html", audience } }, parseAs: "text" }),
        ),
  );
  const [failed, setFailed] = useState<string | null>(null);
  // The export in this audience (the API's audience= on the version export, O5 §1).
  const pdf = async () => {
    setFailed(null);
    try {
      const blob = await unwrap<Blob>(
        api.GET("/v1/documents/{doc}/versions/{n}/export", { params: { path: { doc, n }, query: { format: "pdf", audience } }, parseAs: "blob" }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc}-v${n}-${audience}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setFailed(errorMessage(e));
    }
  };
  return (
    <Panel
      title={`Audience view · ${audienceLabel(audience)}`}
      testId="audience-view"
      tools={audience !== "public" ? <Button onClick={pdf}>Export PDF for {audienceLabel(audience)}</Button> : undefined}
    >
      {failed && <ErrorNote>{failed}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data && !q.error && <Loading />}
      {q.data && (
        <iframe
          title={`Roadmap for ${audienceLabel(audience)}`}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={q.data}
          className="h-[560px] w-full rounded-lg border border-line bg-white max-[600px]:h-[420px]"
        />
      )}
    </Panel>
  );
}

/**
 * A roadmap's sharing on its document page (spec-O5 "Screens and copy"): the Audience switch
 * (?audience=), the audience view, the Share sheet (approvers and owners; Public owners only,
 * O5-Q1) and the Links table with View log, Extend, Move, New passcode and Revoke.
 */
export function RoadmapSharing({ d }: { d: Doc }) {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params.get("audience");
  const showPublic = can("get_public_preview");
  // The Public preview is for approvers: anyone else starts on Team, whatever the roadmap's default.
  const fallback: Audience = d.audience && (d.audience !== "public" || showPublic) ? d.audience : "team";
  const audience: Audience = isAudience(fromUrl) && (fromUrl !== "public" || showPublic) ? fromUrl : fallback;
  const shareParam = params.get("share");
  const [sharing, setSharing] = useState<Audience | null>(isAudience(shareParam) ? shareParam : null);
  const [linksKey, setLinksKey] = useState(0);
  const canShare = can("create_share_link", true);
  const setAudience = (a: Audience) => {
    const next = new URLSearchParams(params.toString());
    next.set("audience", a);
    next.delete("share");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  if (d.latest_version == null) return null;
  return (
    <div className="mb-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-text2">Audience</span>
        <AudienceSwitch value={audience} onChange={setAudience} showPublic={showPublic} />
        {canShare && (
          <Button variant="primary" onClick={() => setSharing(audience)}>
            Share
          </Button>
        )}
        {can("list_public_texts") && (
          <LinkButton variant="secondary" href={`/documents/${d.slug}/public`}>
            Public version
          </LinkButton>
        )}
      </div>
      <AudienceView doc={d.slug} n={d.latest_version} audience={audience} />
      {can("list_share_links") && <ShareLinks doc={d.slug} reloadKey={linksKey} />}
      {sharing && (
        <ShareSheet
          doc={d.slug}
          n={d.latest_version}
          initial={sharing}
          onClose={() => {
            setSharing(null);
            if (shareParam) {
              const next = new URLSearchParams(params.toString());
              next.delete("share");
              router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
            }
          }}
          onCreated={() => setLinksKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function usePublications(doc: string) {
  return useQuery(`publications|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/publications", { params: { path: { doc } } })));
}

/** The newest publication: what a new link shows (a share pins a publication, never a draft). */
function newest(pubs: Schemas["PublicationSummary"][] | null | undefined) {
  return [...(pubs ?? [])].sort((a, b) => b.number - a.number)[0] ?? null;
}

/**
 * qa-docs-2: what still keeps the latest version from being published (a share needs a
 * publication): the dates its approve refuses, else the publish check's own problems; when
 * nothing does, the approver publishes it from here.
 */
function NotPublished({ doc, n, onClose, onPublished }: { doc: string; n: number; onClose: () => void; onPublished: () => void }) {
  const { can } = useMe();
  const q = useQuery(`share-unpublished|${doc}|${n}`, () =>
    Promise.all([
      unwrap(api.GET("/v1/documents/{doc}/versions/{n}/publish-check", { params: { path: { doc, n } } })),
      unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })),
    ]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishLink = (
    <Link href={`/documents/${doc}/publish`} onClick={onClose} className="font-semibold text-accent-ink underline">
      Go to Publish
    </Link>
  );
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const [check, version] = q.data;
  const dates = dateBlocksOf(version.date_marks, new Map(version.sections.map((s) => [s.section_key, s.heading])));
  const problems = check.blockers.filter((b) => b.code !== "already_published");
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/publish", { params: { path: { doc, n } }, body: { content_hash: check.content_hash } }));
      onPublished();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (dates.length > 0) {
    return (
      <div role="status" className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn">
        <p className="font-semibold" data-testid="share-not-published">
          v{n} can&apos;t be published yet: {plural(dates.length, "date")} {dates.length === 1 ? "is" : "are"} not backed by a confirmed schedule.
        </p>
        <ul className="my-1 list-disc pl-5" data-testid="share-blocks">
          {dates.map((b) => (
            <li key={b.id}>{b.title}</li>
          ))}
        </ul>
        <p>
          Record a schedule basis for each on{" "}
          <Link href="/plan/dates" onClick={onClose} className="font-semibold text-accent-ink underline">
            Plan › Dates
          </Link>{" "}
          (or ask the engineering lead to), then publish. {publishLink}
        </p>
      </div>
    );
  }
  if (check.can_publish) {
    return (
      <div role="status" className="rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink">
        <p data-testid="share-not-published">v{n} is approved but not published yet. A link shows a published version, never a draft.</p>
        {can("publish_version") ? (
          <div className="mt-2">
            <Button variant="primary" disabled={busy} onClick={publish}>
              {busy ? "Publishing…" : `Publish v${n}`}
            </Button>
          </div>
        ) : (
          <p className="mt-1">Ask an approver or owner to publish it.</p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    );
  }
  return (
    <div role="status" className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn">
      <p className="font-semibold" data-testid="share-not-published">
        Publish v{n} first: a link shows a published version, never a draft.{problems.length > 0 && " What still stops it:"}
      </p>
      {/* "Already published" is no reason it can't be (it was filtered out above): no list, no heading, when nothing else is left. */}
      {problems.length > 0 && (
        <ul className="my-1 list-disc pl-5" data-testid="share-blocks">
          {problems.map((b, i) => (
            // A code can come twice (two sections, two messages): the place keeps each key apart.
            <li key={`${b.code}-${i}`}>{b.code === "version_not_approved" ? `v${n} is not approved yet` : b.message}</li>
          ))}
        </ul>
      )}
      <p>{publishLink}</p>
    </div>
  );
}

function ShareSheet({ doc, n, initial, onClose, onCreated }: { doc: string; n: number; initial: Audience; onClose: () => void; onCreated: () => void }) {
  const { can } = useMe();
  const pubs = usePublications(doc);
  const pub = newest(pubs.data);
  const [audience, setAudience] = useState<Audience>(initial);
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState<Expiry>("14d");
  const [download, setDownload] = useState(true);
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const ownerPublic = can("create_share_link");
  const check = useQuery(`share-public-check|${doc}|${pub?.version_number ?? 0}|${audience}`, () =>
    audience === "public" && pub && can("list_public_texts")
      ? unwrap(api.GET("/v1/roadmaps/{doc}/public-texts", { params: { path: { doc }, query: { version: pub.version_number } } }))
      : Promise.resolve(null),
  );
  const checkState = check.data?.check.state ?? "none";
  const blockedPublic = audience === "public" && (!ownerPublic || checkState !== "checked");
  const ids = { audience: useId(), label: useId(), expires: useId(), download: useId(), passcode: useId(), why: useId() };
  // qa-docs-20: a disabled Create link says why.
  const why = !label.trim()
    ? "Add a label first"
    : blockedPublic
      ? !ownerPublic
        ? "Only an owner can share the public version"
        : "Check the public version first"
      : passcode.length > 0 && passcode.length < 8
        ? "The passcode needs at least 8 characters"
        : null;

  const create = async () => {
    if (!pub) return;
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/documents/{doc}/share-links", {
          params: { path: { doc } },
          body: { publication_id: pub.id, audience, label: label.trim(), expires_in: expires, allow_download: download, passcode: passcode || null },
        }),
      );
      setCreated({ url: out.url, passcode: out.passcode, expires_at: out.expires_at });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal title="Share roadmap" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <ShownOnce label="Link" value={created.url} copyLabel="Copy link" />
        <ShownOnce label="Passcode" value={created.passcode} copyLabel="Copy passcode" />
        <p>
          Only people you send this link and passcode to can open it. It ends on {formatDate(created.expires_at)}.
        </p>
        <Notice>{SHOWN_ONCE}</Notice>
      </Modal>
    );
  }
  return (
    <Modal
      title="Share roadmap"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {pub && why && (
            <span id={ids.why} data-testid="create-why" className="mr-auto self-center text-sm text-text2">
              {why}
            </span>
          )}
          {pub && (
            <Button variant="primary" disabled={busy || !!why} aria-describedby={why ? ids.why : undefined} onClick={create}>
              Create link
            </Button>
          )}
        </>
      }
    >
      {pubs.error && <ErrorNote>{pubs.error}</ErrorNote>}
      {!pubs.data && !pubs.error && <Loading />}
      {pubs.data && !pub && <NotPublished doc={doc} n={n} onClose={onClose} onPublished={() => void pubs.reload()} />}
      {pub && (
        <>
          <p className="text-text2" data-testid="share-shares">
            Shares the published v{pub.version_number} ({formatShortDate(pub.created_at)}).
          </p>
          <div>
            <label htmlFor={ids.audience} className={LABEL}>
              Audience
            </label>
            <select id={ids.audience} className={INPUT} value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
              {AUDIENCES.map((a) => (
                <option key={a.key} value={a.key} disabled={a.key === "public" && !ownerPublic}>
                  {a.key === "public" && !ownerPublic ? "Public (owners only)" : a.label}
                </option>
              ))}
            </select>
          </div>
          {audience === "public" && (
            <div className="rounded-lg border border-line px-3 py-2">
              <span className="text-sm text-text2">Public check: </span>
              <span data-testid="public-check-state" className="font-semibold">
                {checkState === "checked" ? "Checked" : checkState === "lapsed" ? "Changed since checked" : "Not checked yet"}
              </span>
              {checkState !== "checked" && (
                <div className="mt-1">
                  <Link href={`/documents/${doc}/public`} onClick={onClose} className="font-semibold text-accent-ink underline">
                    Check public version
                  </Link>
                </div>
              )}
            </div>
          )}
          <div>
            <label htmlFor={ids.label} className={LABEL}>
              Label <span className="font-normal">(required)</span>
            </label>
            <input
              id={ids.label}
              className={INPUT}
              maxLength={120}
              required
              aria-required="true"
              aria-describedby={`${ids.label}-hint`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p id={`${ids.label}-hint`} className="text-sm text-text2">
              Who the link is for, for example Board, October meeting. Only you and your team see it.
            </p>
          </div>
          <div>
            <label htmlFor={ids.expires} className={LABEL}>
              Expires
            </label>
            <select id={ids.expires} className={INPUT} value={expires} onChange={(e) => setExpires(e.target.value as Expiry)}>
              {EXPIRIES.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="flex items-center gap-2">
              <input id={ids.download} type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} />
              Allow PDF download
            </label>
            <p className="text-sm text-text2">A downloaded PDF can&apos;t be revoked</p>
          </div>
          <div>
            <label htmlFor={ids.passcode} className={LABEL}>
              Passcode (optional)
            </label>
            <input
              id={ids.passcode}
              className={INPUT}
              autoComplete="off"
              maxLength={128}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              aria-describedby={`${ids.passcode}-hint`}
            />
            <p id={`${ids.passcode}-hint`} className="text-sm text-text2">
              Leave it empty and Oracle makes one. At least 8 characters. Whoever opens the link enters it first.
            </p>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
        </>
      )}
    </Modal>
  );
}

type Dialog =
  | { kind: "log"; link: Link_ }
  | { kind: "extend"; link: Link_ }
  | { kind: "passcode"; link: Link_ }
  | { kind: "revoke"; link: Link_ }
  | { kind: "revoke-all" };

/** Share › Links: the document's links, newest first (approvers and owners). */
function ShareLinks({ doc, reloadKey }: { doc: string; reloadKey: number }) {
  const { can, me } = useMe();
  const q = useQuery(`share-links|${doc}|${reloadKey}`, () => unwrap(api.GET("/v1/documents/{doc}/share-links", { params: { path: { doc } } })));
  const pubs = usePublications(doc);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const links = q.data ?? [];
  const mine = (l: Link_) => !!me?.user_id && l.created_by === me.user_id;
  const move = async (l: Link_) => {
    const target = pubs.data?.find((p) => p.number === l.newer_publication);
    if (!target) return;
    setBusy(true);
    try {
      await unwrap(api.PATCH("/v1/share-links/{link_id}", { params: { path: { link_id: l.id } }, body: { publication_id: target.id } }));
      toast({ message: `${l.label} now shows v${target.version_number}` });
      q.reload();
    } catch (e) {
      toast({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const columns: Column<Link_>[] = [
    { key: "label", header: "Label", phone: "title", cell: (l) => <span className="font-medium">{l.label}</span> },
    { key: "audience", header: "Audience", width: "110px", phone: "meta", cell: (l) => audienceLabel(l.audience) },
    { key: "version", header: "Version", width: "80px", phone: "meta", cell: (l) => <span className="tnum">v{l.version_number}</span> },
    { key: "by", header: "Created by", width: "120px", phone: "hide", cell: (l) => l.created_by_name ?? "A member" },
    {
      key: "expires",
      header: "Expires",
      width: "120px",
      phone: "meta",
      cell: (l) => (
        <span data-testid="share-expires" className="tnum">
          {formatDate(l.expires_at)}
        </span>
      ),
    },
    {
      key: "views",
      header: "Views",
      width: "90px",
      align: "right",
      phone: "meta",
      cell: (l) => (
        <span className="tnum" title={`${l.distinct_browsers} distinct browser${l.distinct_browsers === 1 ? "" : "s"}`}>
          <span data-testid="share-views">{l.views}</span>
        </span>
      ),
    },
    { key: "last", header: "Last viewed", width: "150px", phone: "hide", cell: (l) => (l.last_viewed_at ? formatDateTime(l.last_viewed_at) : "Not yet") },
    {
      key: "state",
      header: "State",
      width: "90px",
      phone: "meta",
      cell: (l) => (
        <span data-testid="share-state" title={l.revoked_reason ?? undefined}>
          {STATE_LABEL[l.state]}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      phone: "meta",
      cell: (l) => {
        const live = l.state !== "revoked";
        return (
          <span className="flex flex-wrap justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            {can("share_link_views") && (
              <Button onClick={() => setDialog({ kind: "log", link: l })}>
                View log
              </Button>
            )}
            {live && can("update_share_link", mine(l)) && (
              <Button onClick={() => setDialog({ kind: "extend", link: l })}>
                Extend
              </Button>
            )}
            {live && l.newer_version != null && can("update_share_link", mine(l)) && (
              <Button disabled={busy} onClick={() => move(l)}>
                Move to v{l.newer_version}
              </Button>
            )}
            {live && can("rotate_share_link_passcode", mine(l)) && (
              <Button onClick={() => setDialog({ kind: "passcode", link: l })}>
                New passcode
              </Button>
            )}
            {live && can("revoke_share_link", mine(l) || l.audience !== "public") && (
              <Button onClick={() => setDialog({ kind: "revoke", link: l })}>
                Revoke
              </Button>
            )}
          </span>
        );
      },
    },
  ];
  const close = (changed: boolean) => {
    setDialog(null);
    if (changed) q.reload();
  };
  return (
    <Panel
      title="Share links"
      count={links.filter((l) => l.state === "active").length}
      tools={
        can("revoke_all_share_links") && links.some((l) => l.state === "active") ? (
          <Button onClick={() => setDialog({ kind: "revoke-all" })}>
            Revoke all
          </Button>
        ) : undefined
      }
    >
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data && !q.error && <Loading />}
      {q.data && (
        <DataTable label="Share links" testId="share-links" columns={columns} rows={links} rowKey={(l) => l.id} empty="No links yet. Share makes one." />
      )}
      {dialog?.kind === "log" && <ViewLog link={dialog.link} onClose={() => close(false)} />}
      {dialog?.kind === "extend" && <Extend link={dialog.link} onClose={close} />}
      {dialog?.kind === "passcode" && <NewPasscode link={dialog.link} onClose={close} />}
      {dialog?.kind === "revoke" && <Revoke link={dialog.link} onClose={close} />}
      {dialog?.kind === "revoke-all" && <RevokeAll doc={doc} onClose={close} />}
    </Panel>
  );
}

function useAct(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Extend({ link, onClose }: { link: Link_; onClose: (changed: boolean) => void }) {
  const [expires, setExpires] = useState<Expiry>("14d");
  const id = useId();
  const act = useAct(() => onClose(true));
  return (
    <Modal
      title="Extend link"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() => act.run(() => unwrap(api.PATCH("/v1/share-links/{link_id}", { params: { path: { link_id: link.id } }, body: { expires_in: expires } })))}
          >
            Extend
          </Button>
        </>
      }
    >
      <p>
        {link.label} ends on {formatDate(link.expires_at)}. A link lives at most 90 days from now.
      </p>
      <div>
        <label htmlFor={id} className={LABEL}>
          Expires
        </label>
        <select id={id} className={INPUT} value={expires} onChange={(e) => setExpires(e.target.value as Expiry)}>
          {EXPIRIES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label} from now
            </option>
          ))}
        </select>
      </div>
      {act.error && <ErrorNote>{act.error}</ErrorNote>}
    </Modal>
  );
}

function NewPasscode({ link, onClose }: { link: Link_; onClose: (changed: boolean) => void }) {
  const [value, setValue] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const id = useId();
  const act = useAct(() => undefined);
  if (made) {
    return (
      <Modal title="New passcode" onClose={() => onClose(true)} footer={<Button variant="primary" onClick={() => onClose(true)}>Done</Button>}>
        <ShownOnce label="Passcode" value={made} copyLabel="Copy passcode" />
        <p>The link&apos;s address stays the same. Whoever opened it with the old passcode enters the new one.</p>
        <Notice>{SHOWN_ONCE}</Notice>
      </Modal>
    );
  }
  return (
    <Modal
      title="New passcode"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || (value.length > 0 && value.length < 8)}
            onClick={() =>
              act.run(async () => {
                const out = await unwrap(
                  api.POST("/v1/share-links/{link_id}/passcode", { params: { path: { link_id: link.id } }, body: { passcode: value || null } }),
                );
                setMade(out.passcode);
              })
            }
          >
            Make a new passcode
          </Button>
        </>
      }
    >
      <p>{link.label} keeps its address; the old passcode stops opening it.</p>
      <div>
        <label htmlFor={id} className={LABEL}>
          New passcode (optional)
        </label>
        <input id={id} className={INPUT} autoComplete="off" maxLength={128} value={value} onChange={(e) => setValue(e.target.value)} />
        <p className="text-sm text-text2">Leave it empty and Oracle makes one. At least 8 characters.</p>
      </div>
      {act.error && <ErrorNote>{act.error}</ErrorNote>}
    </Modal>
  );
}

function Revoke({ link, onClose }: { link: Link_; onClose: (changed: boolean) => void }) {
  const [reason, setReason] = useState("");
  const id = useId();
  const act = useAct(() => onClose(true));
  return (
    <Modal
      title="Revoke link"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={act.busy}
            onClick={() =>
              act.run(() => unwrap(api.POST("/v1/share-links/{link_id}/revoke", { params: { path: { link_id: link.id } }, body: { reason: reason.trim() || null } })))
            }
          >
            Revoke link
          </Button>
        </>
      }
    >
      <p>{link.label} stops working on its next request. Revoking can&apos;t be undone; make a new link instead.</p>
      <div>
        <label htmlFor={id} className={LABEL}>
          Reason (optional)
        </label>
        <input id={id} className={INPUT} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {act.error && <ErrorNote>{act.error}</ErrorNote>}
    </Modal>
  );
}

function RevokeAll({ doc, onClose }: { doc: string; onClose: (changed: boolean) => void }) {
  const [reason, setReason] = useState("");
  const id = useId();
  const act = useAct(() => onClose(true));
  return (
    <Modal
      title="Revoke all links"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={act.busy || !reason.trim()}
            onClick={() => act.run(() => unwrap(api.POST("/v1/documents/{doc}/share-links/revoke-all", { params: { path: { doc } }, body: { reason: reason.trim() } })))}
          >
            Revoke all
          </Button>
        </>
      }
    >
      <p>Every active link on this roadmap stops working at once.</p>
      <div>
        <label htmlFor={id} className={LABEL}>
          Reason
        </label>
        <input id={id} className={INPUT} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {act.error && <ErrorNote>{act.error}</ErrorNote>}
    </Modal>
  );
}

/** View log (O5-Q4): when, page or download, browser and country; never who. */
function ViewLog({ link, onClose }: { link: Link_; onClose: () => void }) {
  const q = useQuery(`share-views|${link.id}`, () => unwrap(api.GET("/v1/share-links/{link_id}/views", { params: { path: { link_id: link.id } } })));
  const v = q.data;
  const most = Math.max(1, ...(v?.days ?? []).map((d) => d.views));
  return (
    <Modal title={`View log: ${link.label}`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-text2">Counts browsers, not people. Oracle never records who opened a link.</p>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!v && !q.error && <Loading />}
      {v && (
        <>
          <p>
            {v.views} view{v.views === 1 ? "" : "s"} ·{" "}
            <span data-testid="distinct-browsers">
              {v.distinct_browsers} browser{v.distinct_browsers === 1 ? "" : "s"}
            </span>
          </p>
          {v.days.length > 0 && (
            <ul aria-label="Views per day" className="space-y-1">
              {v.days.map((d) => (
                <li key={d.day} data-testid="view-day" className="flex items-center gap-2 text-sm">
                  <span className="tnum w-24 flex-none">{formatDate(`${d.day}T12:00:00Z`)}</span>
                  <span className="h-2.5 rounded bg-accent" style={{ width: `${(d.views / most) * 100}%`, maxWidth: "60%" }} aria-hidden />
                  <span className="tnum">{d.views}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-text2">Times in {v.zone} (Company time zone).</p>
          {v.entries.length === 0 ? (
            <p>Nobody has opened this link yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text2">
                  <th className="py-1 font-semibold">Date and time</th>
                  <th className="py-1 font-semibold">Kind</th>
                  <th className="py-1 font-semibold">Browser</th>
                  <th className="py-1 font-semibold">Country</th>
                </tr>
              </thead>
              <tbody>
                {v.entries.map((e, i) => (
                  <tr key={i} data-testid="view-entry" className="border-t border-line">
                    <td className="tnum py-1">{formatDateTime(e.viewed_at)}</td>
                    <td className="py-1">{e.kind === "page" ? "Page" : "Download"}</td>
                    <td className="py-1">{e.browser_family ?? "Other"}</td>
                    <td className="py-1">{e.country ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
