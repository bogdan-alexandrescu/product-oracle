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
/** A field's hint, under it (qa-docs-69). */
const HINT = "mt-1 text-sm text-text2";
const SHARE_HINT = "Share a link sends a published version to people you choose, shown for one audience.";
const CHECK_HINT = "Check public text is where you approve what the Public page shows before anyone gets a public link.";

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
  const [sharing, setSharing] = useState<Audience | null>(isAudience(shareParam) ? shareParam : params.get("open") === "1" ? audience : null); // MOCK-HOOK
  const [linksKey, setLinksKey] = useState(0);
  const canShare = can("create_share_link", true);
  const checkPublic = can("list_public_texts");
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
        {/* qa-docs-68: two plainly named actions, each with what it does under them. */}
        {canShare && (
          <Button variant="primary" title={SHARE_HINT} onClick={() => setSharing(audience)}>
            Share a link
          </Button>
        )}
        {checkPublic && (
          <LinkButton variant="secondary" title={CHECK_HINT} href={`/documents/${d.slug}/public`}>
            Check public text
          </LinkButton>
        )}
      </div>
      {(canShare || checkPublic) && (
        <p data-testid="sharing-hint" className="-mt-2 text-[13px] text-text2">
          {[canShare && SHARE_HINT, checkPublic && CHECK_HINT].filter(Boolean).join(" ")}
        </p>
      )}
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
    <LinkButton variant="primary" href={`/documents/${doc}/publish`} onClick={onClose}>
      Go to Publish
    </LinkButton>
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
        <p>Record a schedule basis for each date on Plan › Dates, or ask the engineering lead to. Then publish v{n}.</p>
        {/* qa-docs-16: the way to fix it, as buttons, not only words. */}
        <div className="mt-2 flex flex-wrap gap-2">
          <LinkButton variant="primary" href="/plan/dates" onClick={onClose}>
            Go to Plan › Dates
          </LinkButton>
          <LinkButton href={`/documents/${doc}/v/${n}/items`} onClick={onClose}>
            See v{n}&apos;s items
          </LinkButton>
        </div>
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
      <div className="mt-2">{publishLink}</div>
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
  const qv4 = useSearchParams().get("qv4"); // MOCK-HOOK
  const qv = qv4 === "a" || qv4 === "b" || qv4 === "c" ? qv4 : null; // MOCK-HOOK
  const check = useQuery(`share-public-check|${doc}|${pub?.version_number ?? 0}|${audience}`, () =>
    audience === "public" && pub && can("list_public_texts")
      ? unwrap(api.GET("/v1/roadmaps/{doc}/public-texts", { params: { path: { doc }, query: { version: pub.version_number } } }))
      : Promise.resolve(null),
  );
  const checkState = check.data?.check.state ?? "none";
  const blockedPublic = audience === "public" && (!ownerPublic || checkState !== "checked");
  const ids = { audience: useId(), label: useId(), expires: useId(), download: useId(), passcode: useId(), why: useId() };
  // qa-docs-20: a disabled Create link says why.
  // qa-docs-69: the reason sits under the field it is about, as a sentence.
  const why: { field: "audience" | "label" | "passcode"; text: string } | null = !label.trim()
    ? { field: "label", text: "Add a label first." }
    : blockedPublic
      ? { field: "audience", text: !ownerPublic ? "Only an owner can share the public version." : "Check the public text first." }
      : passcode.length > 0 && passcode.length < 8
        ? { field: "passcode", text: "The passcode needs at least 8 characters." }
        : null;
  const whyNote = (field: "audience" | "label" | "passcode") =>
    pub && why?.field === field ? (
      <p id={ids.why} data-testid="create-why" className="mt-1 text-sm font-medium text-text">
        {why.text}
      </p>
    ) : null;

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
          {/* qa-docs-16: with nothing to create, the sheet only closes. */}
          <Button onClick={onClose}>{pub ? "Cancel" : "Close"}</Button>
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
      {pubs.data && !pub && !qv && <NotPublished doc={doc} n={n} onClose={onClose} onPublished={() => void pubs.reload()} />}{/* MOCK-HOOK */}
      {pubs.data && !pub && qv && ( // MOCK-HOOK
        <Qv4Blockers // MOCK-HOOK
          qv={qv} // MOCK-HOOK
          doc={doc} // MOCK-HOOK
          n={n} // MOCK-HOOK
          audience={audience} // MOCK-HOOK
          onClose={onClose} // MOCK-HOOK
          onPublished={() => void pubs.reload()} // MOCK-HOOK
          onShared={(out) => { // MOCK-HOOK
            setCreated(out); // MOCK-HOOK
            onCreated(); // MOCK-HOOK
          }} // MOCK-HOOK
        /> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
      {pub && (
        <>
          {qv && <Qv4Ready qv={qv} n={pub.version_number} />}{/* MOCK-HOOK */}
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
                    Check public text
                  </Link>
                </div>
              )}
            </div>
          )}
          {whyNote("audience")}
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
            <p id={`${ids.label}-hint`} className={HINT}>
              Who the link is for, for example Board, October meeting. Only you and your team see it.
            </p>
            {whyNote("label")}
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
            <p className={HINT}>A downloaded PDF can&apos;t be revoked.</p>
          </div>
          <div>
            <label htmlFor={ids.passcode} className={LABEL}>
              Passcode <span className="font-normal">(optional)</span>
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
            <p id={`${ids.passcode}-hint`} className={HINT}>
              Leave it empty and Oracle makes one. At least 8 characters. Whoever opens the link enters it first.
            </p>
            {whyNote("passcode")}
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
    {
      // qa-docs-15: the time wraps whole (its zone too), never cut off.
      key: "last",
      header: "Last viewed",
      width: "150px",
      phone: "hide",
      wrap: true,
      cell: (l) => (
        <span data-testid="share-last-viewed" className="tnum">
          {l.last_viewed_at ? formatDateTime(l.last_viewed_at) : "Not yet"}
        </span>
      ),
    },
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
        <DataTable label="Share links" testId="share-links" columns={columns} rows={links} rowKey={(l) => l.id} empty="No links yet. Use Share above to create one." />
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
// MOCK-HOOK
/* QV4 mock-up: one meaning for Publish, and every sharing blocker shown together (?qv4=a|b|c). */ // MOCK-HOOK
type Qv = "a" | "b" | "c"; // MOCK-HOOK
const QV_FIX = "font-semibold whitespace-nowrap text-accent-ink underline"; // MOCK-HOOK
// MOCK-HOOK
/** One row of a list: done or not, what it is, and how to fix it. */ // MOCK-HOOK
function Qv4Row({ done, testId, children, fix }: { done: boolean; testId: string; children: ReactNode; fix?: ReactNode }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <li data-testid={testId} data-done={done} className="flex min-h-9 items-center gap-2 border-t border-line py-1.5 first:border-t-0">{/* MOCK-HOOK */}
      <Icon name={done ? "check" : "alert"} size={16} className={`flex-none ${done ? "text-pass" : "text-warn"}`} />{/* MOCK-HOOK */}
      <span className={`min-w-0 flex-1 ${done ? "text-text2 line-through" : "font-medium text-text"}`}>{children}</span>{/* MOCK-HOOK */}
      {!done && fix}{/* MOCK-HOOK */}
    </li> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** b: the three steps, all on screen; the current one carries its action. */ // MOCK-HOOK
function Qv4Steps({ steps }: { steps: { label: string; done: boolean; note: string; action?: ReactNode }[] }) { // MOCK-HOOK
  const current = steps.findIndex((x) => !x.done); // MOCK-HOOK
  return ( // MOCK-HOOK
    <ol aria-label="Steps to share" data-testid="qv4-steps" className="space-y-2">{/* MOCK-HOOK */}
      {steps.map((x, i) => ( // MOCK-HOOK
        <li key={x.label} data-testid="qv4-step" data-state={x.done ? "done" : i === current ? "current" : "waiting"} aria-current={i === current ? "step" : undefined} className={`flex gap-3 rounded-lg border px-3 py-2 ${i === current ? "border-accent bg-accent-soft" : "border-line"}`}>{/* MOCK-HOOK */}
          <span className={`grid size-7 flex-none place-items-center rounded-full text-sm font-bold ${x.done ? "bg-pass text-on-accent" : i === current ? "bg-accent text-on-accent" : "bg-surface2 text-text2"}`}>{/* MOCK-HOOK */}
            {x.done ? <Icon name="check" size={16} /> : i + 1}{/* MOCK-HOOK */}
          </span>{/* MOCK-HOOK */}
          <div className="min-w-0 flex-1">{/* MOCK-HOOK */}
            <p className="font-semibold">{x.label}</p>{/* MOCK-HOOK */}
            <p className="text-sm text-text2">{x.note}</p>{/* MOCK-HOOK */}
            {i === current && x.action && <div className="mt-2">{x.action}</div>}{/* MOCK-HOOK */}
          </div>{/* MOCK-HOOK */}
        </li> // MOCK-HOOK
      ))}{/* MOCK-HOOK */}
    </ol> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** Above the form once v is published: what is done, in each proposal's words. */ // MOCK-HOOK
function Qv4Ready({ qv, n }: { qv: Qv; n: number }) { // MOCK-HOOK
  if (qv === "b") { // MOCK-HOOK
    return ( // MOCK-HOOK
      <Qv4Steps // MOCK-HOOK
        steps={[ // MOCK-HOOK
          { label: "Dates set", done: true, note: "Every date has a source." }, // MOCK-HOOK
          { label: "Approved", done: true, note: `v${n} is approved.` }, // MOCK-HOOK
          { label: "Published", done: true, note: `v${n} is published for sharing. Make the link below.` }, // MOCK-HOOK
        ]} // MOCK-HOOK
      /> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  return ( // MOCK-HOOK
    <p data-testid="qv4-ready" className="flex items-center gap-2 rounded-button bg-pass-bg px-3 py-2 text-sm font-medium text-pass">{/* MOCK-HOOK */}
      <Icon name="check" size={16} className="flex-none" />{/* MOCK-HOOK */}
      v{n} is published and ready to share.{/* MOCK-HOOK */}
    </p> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** What still stops sharing, all at once, with each proposal's way through. */ // MOCK-HOOK
function Qv4Blockers({ qv, doc, n, audience, onClose, onPublished, onShared }: { qv: Qv; doc: string; n: number; audience: Audience; onClose: () => void; onPublished: () => void; onShared: (out: Created) => void }) { // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  const q = useQuery(`qv4-blockers|${doc}|${n}`, () => // MOCK-HOOK
    Promise.all([ // MOCK-HOOK
      unwrap(api.GET("/v1/documents/{doc}/versions/{n}/publish-check", { params: { path: { doc, n } } })), // MOCK-HOOK
      unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })), // MOCK-HOOK
    ]), // MOCK-HOOK
  ); // MOCK-HOOK
  const [busy, setBusy] = useState(false); // MOCK-HOOK
  const [error, setError] = useState<string | null>(null); // MOCK-HOOK
  const [label, setLabel] = useState(""); // MOCK-HOOK
  const labelId = useId(); // MOCK-HOOK
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>; // MOCK-HOOK
  if (!q.data) return <Loading />; // MOCK-HOOK
  const [check, version] = q.data; // MOCK-HOOK
  const dates = dateBlocksOf(version.date_marks, new Map(version.sections.map((s) => [s.section_key, s.heading]))); // MOCK-HOOK
  const datesOk = dates.length === 0; // MOCK-HOOK
  const approved = !!version.approved_at; // MOCK-HOOK
  const other = check.blockers.filter((b) => !["already_published", "version_not_approved"].includes(b.code)); // MOCK-HOOK
  const mayApprove = can("approve_version", true); // MOCK-HOOK
  const mayPublish = can("publish_version"); // MOCK-HOOK
  const mkdates = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("mkdates"); // MOCK-HOOK
  const publishPage = `/documents/${doc}/publish?qv4=${qv}${mkdates ? `&mkdates=${mkdates}` : ""}`; // MOCK-HOOK
  const datesFix = ( // MOCK-HOOK
    <Link href="/plan/dates" onClick={onClose} className={QV_FIX}>{/* MOCK-HOOK */}
      Fix in Plan › Dates{/* MOCK-HOOK */}
    </Link> // MOCK-HOOK
  ); // MOCK-HOOK
  const datesText = `Pick where dates come from: ${plural(dates.length, "date")} ${dates.length === 1 ? "has" : "have"} no source yet`; // MOCK-HOOK
  // The steps, as the API's own calls: approve, then publish (a fresh check gives the content hash). // MOCK-HOOK
  const doApprove = async () => { // MOCK-HOOK
    await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/approve", { params: { path: { doc, n } } })); // MOCK-HOOK
  }; // MOCK-HOOK
  const doPublish = async () => { // MOCK-HOOK
    const fresh = await unwrap(api.GET("/v1/documents/{doc}/versions/{n}/publish-check", { params: { path: { doc, n } } })); // MOCK-HOOK
    return unwrap(api.POST("/v1/documents/{doc}/versions/{n}/publish", { params: { path: { doc, n } }, body: { content_hash: fresh.content_hash } })); // MOCK-HOOK
  }; // MOCK-HOOK
  const run = async (steps: () => Promise<unknown>) => { // MOCK-HOOK
    setBusy(true); // MOCK-HOOK
    setError(null); // MOCK-HOOK
    try { // MOCK-HOOK
      await steps(); // MOCK-HOOK
    } catch (e) { // MOCK-HOOK
      setError(errorMessage(e)); // MOCK-HOOK
    } finally { // MOCK-HOOK
      setBusy(false); // MOCK-HOOK
      void q.reload(); // MOCK-HOOK
    } // MOCK-HOOK
  }; // MOCK-HOOK
  const errorNote = error && <ErrorNote>{error}</ErrorNote>; // MOCK-HOOK
  const otherRows = other.map((b, i) => ( // MOCK-HOOK
    <Qv4Row key={`${b.code}-${i}`} done={false} testId="qv4-blocker" fix={<Link href={publishPage} onClick={onClose} className={QV_FIX}>Fix on Publish page</Link>}>{/* MOCK-HOOK */}
      {b.message}{/* MOCK-HOOK */}
    </Qv4Row> // MOCK-HOOK
  )); // MOCK-HOOK
  // MOCK-HOOK
  if (qv === "a") { // MOCK-HOOK
    const left = Number(!datesOk) + other.length + 1; // MOCK-HOOK
    return ( // MOCK-HOOK
      <div data-testid="qv4-checklist" className="space-y-2">{/* MOCK-HOOK */}
        <p className="font-semibold" data-testid="share-not-published">{/* MOCK-HOOK */}
          Before you can share v{n}, {left === 1 ? "1 thing is" : `${left} things are`} left:{/* MOCK-HOOK */}
        </p>{/* MOCK-HOOK */}
        <ul className="rounded-lg border border-line px-3">{/* MOCK-HOOK */}
          <Qv4Row done={datesOk} testId="qv4-blocker" fix={datesFix}>{/* MOCK-HOOK */}
            {datesOk ? "Dates have a source" : datesText}{/* MOCK-HOOK */}
          </Qv4Row>{/* MOCK-HOOK */}
          {otherRows}{/* MOCK-HOOK */}
          <Qv4Row // MOCK-HOOK
            done={false} // MOCK-HOOK
            testId="qv4-blocker" // MOCK-HOOK
            fix={<Link href={publishPage} onClick={onClose} className={QV_FIX}>Fix on Publish page</Link>} // MOCK-HOOK
          >{/* MOCK-HOOK */}
            Publish v{n}{approved ? "" : " (this approves it too)"}{/* MOCK-HOOK */}
          </Qv4Row>{/* MOCK-HOOK */}
        </ul>{/* MOCK-HOOK */}
        <p className="text-sm text-text2">A link shows a published version, never a draft.</p>{/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  // MOCK-HOOK
  if (qv === "b") { // MOCK-HOOK
    return ( // MOCK-HOOK
      <div className="space-y-2">{/* MOCK-HOOK */}
        <p className="font-semibold" data-testid="share-not-published">Three steps before you can share v{n}:</p>{/* MOCK-HOOK */}
        <Qv4Steps // MOCK-HOOK
          steps={[ // MOCK-HOOK
            { label: "Dates set", done: datesOk, note: datesOk ? "Every date has a source." : datesText, action: <LinkButton variant="primary" href="/plan/dates" onClick={onClose}>Fix in Plan › Dates</LinkButton> }, // MOCK-HOOK
            { // MOCK-HOOK
              label: "Approved", // MOCK-HOOK
              done: approved, // MOCK-HOOK
              note: approved ? `v${n} is approved.` : `An approver or owner approves v${n}.`, // MOCK-HOOK
              action: mayApprove ? <Button variant="primary" disabled={busy} onClick={() => run(doApprove)}>{busy ? "Approving…" : `Approve v${n}`}</Button> : <span className="text-sm">Ask an approver or owner to approve it.</span>, // MOCK-HOOK
            }, // MOCK-HOOK
            { // MOCK-HOOK
              label: "Published", // MOCK-HOOK
              done: false, // MOCK-HOOK
              note: `Publishing for sharing fixes what the link shows. A link never shows a draft.`, // MOCK-HOOK
              action: mayPublish ? ( // MOCK-HOOK
                <Button variant="primary" disabled={busy || other.length > 0} onClick={() => run(async () => { await doPublish(); onPublished(); })}>{/* MOCK-HOOK */}
                  {busy ? "Publishing…" : `Publish v${n} for sharing`}{/* MOCK-HOOK */}
                </Button> // MOCK-HOOK
              ) : <span className="text-sm">Ask an approver or owner to publish it.</span>, // MOCK-HOOK
            }, // MOCK-HOOK
          ]} // MOCK-HOOK
        />{/* MOCK-HOOK */}
        {other.length > 0 && <ul className="rounded-lg border border-line px-3">{otherRows}</ul>}{/* MOCK-HOOK */}
        {errorNote}{/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  // MOCK-HOOK
  // c: everything that can be done, in one button; the dates still need their fix. // MOCK-HOOK
  const why = !datesOk ? "Pick where dates come from first." : other.length > 0 ? "Fix the other problems first." : !(approved || mayApprove) || !mayPublish || !can("create_share_link", true) ? "Only an approver or owner can do this." : !label.trim() ? "Add a label first." : null; // MOCK-HOOK
  const verb = approved ? `Publish and share v${n}` : `Approve, publish and share v${n}`; // MOCK-HOOK
  const goAll = () => // MOCK-HOOK
    run(async () => { // MOCK-HOOK
      if (!approved) await doApprove(); // MOCK-HOOK
      const pub = await doPublish(); // MOCK-HOOK
      const out = await unwrap(api.POST("/v1/documents/{doc}/share-links", { params: { path: { doc } }, body: { publication_id: pub.id, audience, label: label.trim(), expires_in: "14d", allow_download: true, passcode: null } })); // MOCK-HOOK
      onShared({ url: out.url, passcode: out.passcode, expires_at: out.expires_at }); // MOCK-HOOK
    }); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="space-y-3">{/* MOCK-HOOK */}
      <p className="font-semibold" data-testid="share-not-published">To share v{n}, this still has to happen:</p>{/* MOCK-HOOK */}
      <ul className="rounded-lg border border-line px-3">{/* MOCK-HOOK */}
        <Qv4Row done={datesOk} testId="qv4-blocker" fix={datesFix}>{/* MOCK-HOOK */}
          {datesOk ? "Dates have a source" : datesText}{/* MOCK-HOOK */}
        </Qv4Row>{/* MOCK-HOOK */}
        {otherRows}{/* MOCK-HOOK */}
        <Qv4Row done={approved} testId="qv4-blocker">{approved ? `v${n} is approved` : `Approve v${n}: done by the button below`}</Qv4Row>{/* MOCK-HOOK */}
        <Qv4Row done={false} testId="qv4-blocker">Publish v{n}: done by the button below</Qv4Row>{/* MOCK-HOOK */}
      </ul>{/* MOCK-HOOK */}
      <div>{/* MOCK-HOOK */}
        <label htmlFor={labelId} className={LABEL}>{/* MOCK-HOOK */}
          Label <span className="font-normal">(required)</span>{/* MOCK-HOOK */}
        </label>{/* MOCK-HOOK */}
        <input id={labelId} className={INPUT} maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />{/* MOCK-HOOK */}
        <p className={HINT}>Who the link is for, for example Board, November meeting. {audienceLabel(audience)} view, ends in 14 days.</p>{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
      <div className="flex flex-wrap items-center gap-2">{/* MOCK-HOOK */}
        <Button variant="primary" disabled={busy || !!why} aria-describedby={why ? `${labelId}-why` : undefined} onClick={goAll}>{/* MOCK-HOOK */}
          {busy ? "Sharing…" : verb}{/* MOCK-HOOK */}
        </Button>{/* MOCK-HOOK */}
        {why && <span id={`${labelId}-why`} data-testid="create-why" className="text-sm font-medium">{why}</span>}{/* MOCK-HOOK */}
      </div>{/* MOCK-HOOK */}
      {errorNote}{/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
