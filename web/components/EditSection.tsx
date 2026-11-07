"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button, InfoTip, Notice, SegmentedControl } from "@/components/ds";
import { MarkdownBody } from "@/components/MarkdownBody";
import { InlineError, TEXTAREA } from "@/components/review/parts";
import { api, type CitationOut, type Schemas, type SectionOut } from "@/lib/api/client";
import { parseBlocks } from "@/lib/markdown";
import { sectionHref } from "@/lib/section-link";

const NO_HIGHLIGHTS: never[] = [];

/**
 * "Edit section": type into a section's markdown, its preview (citation chips kept) behind
 * Edit / Preview so the text shows once (D-13). Save is the next version with this section replaced; a section that changed
 * since it opened is refused with Reload, which loads its current text.
 */
export function EditSection({
  doc,
  n,
  section,
  citations,
  onClose,
}: {
  doc: string;
  n: number;
  section: SectionOut;
  citations: Map<string, { citation: CitationOut; number: number }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(section.body_md);
  // The API checks the section's revision (its text, what it cites, its layer), not its content hash.
  const [base, setBase] = useState({ version: n, revision: section.revision ?? section.content_hash });
  const [conflict, setConflict] = useState<Schemas["ConflictResponse"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const blocks = useMemo(() => parseBlocks(draft), [draft]);

  async function save() {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const { data, error: err, response } = await api.PUT("/v1/documents/{doc}/sections/{key}", {
        params: { path: { doc, key: section.section_key } },
        body: { base_version: base.version, base_revision: base.revision, body_md: draft, resolutions: [] },
      });
      if (response.status === 409 && err && typeof err === "object" && "code" in err) {
        setConflict(err as Schemas["ConflictResponse"]);
      } else if (!response.ok || !data) {
        const detail = err && typeof err === "object" && "detail" in err ? err.detail : null;
        setError(typeof detail === "string" ? detail : "Could not save the section.");
      } else {
        onClose();
        router.push(sectionHref(doc, data.number, section.section_key));
      }
    } catch {
      setError("Could not save the section.");
    } finally {
      setBusy(false);
    }
  }

  function reload() {
    const current = conflict?.sections.find((s) => s.section_key === section.section_key);
    if (!conflict || !current) return;
    setBase({ version: conflict.latest_version ?? base.version, revision: current.current_revision ?? base.revision });
    setDraft(current.current_body_md ?? "");
    setConflict(null);
  }

  return (
    <div className="mt-3 w-full rounded-button border border-line bg-surface2 px-3 py-2.5 text-left" data-testid="section-editor">
      <div className="flex items-center gap-2">
        <p className="min-w-0 truncate font-semibold text-text">Edit “{section.heading}”</p>
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Edit or preview"
            size="sm"
            items={[
              { value: "edit", label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
            value={pane}
            onChange={setPane}
          />
          <InfoTip label="editing a section">
            The text is markdown (# a heading, - a list, **bold**). Preview shows it as the document reads it, its
            citations included.
          </InfoTip>
        </div>
        {pane === "edit" ? (
          <textarea
            rows={8}
            aria-label="Section text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={TEXTAREA}
          />
        ) : (
          <div className="doc-body rounded-lg border border-line bg-surface px-2.5 py-2" data-testid="section-edit-preview">
            <MarkdownBody blocks={blocks} highlights={NO_HIGHLIGHTS} activeId={null} citations={citations} onHighlightClick={() => {}} />
          </div>
        )}
        {conflict && (
          <div data-testid="section-edit-conflict">
            <Notice
              tone="error"
              action={
                <Button onClick={reload} disabled={busy}>
                  Reload
                </Button>
              }
            >
              This section changed since you opened it
              {conflict.latest_version ? ` (now in v${conflict.latest_version})` : ""}. Nothing was saved. Reloading
              discards your edit here.
            </Notice>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="solid" icon="check" disabled={busy || draft === section.body_md} onClick={save}>
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}
