"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Chip, Icon, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { DOCS_ONLY, FRESHNESS, sizeText } from "@/components/tech-brief";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

type TechBrief = Schemas["TechBriefOut"];

const KIND: Record<string, string> = { module: "Module", api: "API", data_model: "Data model", flag: "Flag", job: "Job" };
const CHANGE: Record<string, string> = { new: "New", change: "Change", remove: "Remove" };
const LEVEL: Record<string, ChipKind> = { low: "na", medium: "warn", high: "crit" };

const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

function Block({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <Panel title={title} testId={testId} bodyClassName="px-4 py-3 text-[15px] leading-6">
      {children}
    </Panel>
  );
}

function CodeMap({ b }: { b: TechBrief }) {
  if (!b.code_map.used) {
    return (
      <Block title="Code map" testId="brief-code-map">
        <p className="font-semibold">No code map: assumptions</p>
        <ul className="mt-1 list-disc pl-5">
          {b.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Block>
    );
  }
  return (
    <Block title="Code map" testId="brief-code-map">
      <ul className="flex flex-col gap-1">
        {b.code_map.repos.map((r) => (
          <li key={r.repo} className="break-words">
            <span className="font-mono text-[13px]">{r.repo}</span>
            {r.commit && <span className="text-text2"> at {r.commit}</span>}
            {r.as_of && <span className="text-text2"> · as of {formatDateTime(r.as_of)}</span>}
            {r.partial && (
              <>
                {" "}
                <Chip kind="warn">{DOCS_ONLY}</Chip>
              </>
            )}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Touches({ b }: { b: TechBrief }) {
  return (
    <Block title="What it touches" testId="brief-touches">
      {b.touches.length === 0 ? (
        <p className="text-text2">Nothing listed</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="What it touches" className="w-full text-left text-[14px]">
            <thead className="text-[13px] text-text2">
              <tr>
                <th className="py-1 pr-3 font-semibold">Area</th>
                <th className="py-1 pr-3 font-semibold">Kind</th>
                <th className="py-1 pr-3 font-semibold">Change</th>
                <th className="py-1 font-semibold">Code map ref</th>
              </tr>
            </thead>
            <tbody>
              {b.touches.map((t, i) => (
                <tr key={`${t.area}-${i}`} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 break-all">{t.area}</td>
                  <td className="py-1.5 pr-3">{KIND[t.kind] ?? t.kind}</td>
                  <td className="py-1.5 pr-3">{CHANGE[t.change] ?? t.change}</td>
                  <td className="py-1.5 font-mono text-[13px] break-all">{t.ref ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {b.reuse.length > 0 && (
        <p className="mt-2 break-words text-text2">
          Reuses <span className="font-mono text-[13px] text-text">{b.reuse.join(", ")}</span>
        </p>
      )}
    </Block>
  );
}

function Questions({ b }: { b: TechBrief }) {
  const answers = new Map(b.answers.map((a) => [a.question_id, a.answer]));
  return (
    <Block title="Questions" testId="brief-questions">
      {b.questions.length === 0 ? (
        <p className="text-text2">No questions</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {b.questions.map((q) => (
            <li key={q.id} data-testid={`brief-question-${q.id}`}>
              <p className="font-semibold">
                {q.question} {q.blocking && <Chip kind="crit">Blocking</Chip>}
              </p>
              {q.why && <p className="text-text2">Why: {q.why}</p>}
              <p>{answers.get(q.id) ? <>Answer: {answers.get(q.id)}</> : <span className="text-text2">Not answered</span>}</p>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function Verdict({ b }: { b: TechBrief }) {
  const v = b.verdict;
  return (
    <Block title="Engineering check" testId="brief-verdict">
      {!v ? (
        <p className="text-text2">Not checked yet</p>
      ) : (
        <>
          <p className="font-semibold">{v.value ? sentence(v.value) : "Approved at the Engineering check"}</p>
          {v.note && <p>{v.note}</p>}
          {v.at && <p className="text-[13px] text-text2">{formatDateTime(v.at)}</p>}
        </>
      )}
    </Block>
  );
}

export function BriefDetail({ id }: { id: string }) {
  const q = useQuery(`tech-brief|${id}`, () => unwrap(api.GET("/v1/tech-briefs/{artifact_version_id}", { params: { path: { artifact_version_id: id } } })));
  const b = q.data;
  const fresh = b ? FRESHNESS[b.freshness] : null;
  return (
    <Page>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!b && !q.error && <Loading />}
      {b && fresh && (
        <>
          <PageHeader
            title={b.feature.title}
            back={
              <Link href={`/documents/${b.prd.slug}`} className="inline-flex items-center gap-1 hover:text-text hover:underline">
                <Icon name="back" size={16} />
                {b.prd.slug}
                {b.prd.version != null ? ` v${b.prd.version}` : ""}
              </Link>
            }
            status={
              <>
                <Chip kind="acc">Tech brief</Chip>
                <span data-testid="brief-freshness" className="inline-flex flex-wrap items-center gap-2">
                  <Chip kind={fresh.kind} dot>
                    {fresh.label}
                  </Chip>
                  {b.stale_reasons.map((r) => (
                    <span key={r} className="text-sm text-text2">
                      {r}
                    </span>
                  ))}
                </span>
              </>
            }
          />
          <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3">
            <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
              <Block title="Approach" testId="brief-approach">
                <p className="break-words">{b.approach}</p>
              </Block>
              <Touches b={b} />
              <Block title="Risks" testId="brief-risks">
                {b.risks.length === 0 ? (
                  <p className="text-text2">No risks listed</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {b.risks.map((r) => (
                      <li key={r.risk}>
                        <span className="font-semibold">{r.risk}</span> <Chip kind={LEVEL[r.level] ?? "na"}>{sentence(r.level)}</Chip>
                        {r.mitigation && <p className="text-text2">Mitigation: {r.mitigation}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
              <Questions b={b} />
            </div>
            <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
              <Verdict b={b} />
              <Block title="Size" testId="brief-size">
                <p className="font-semibold">{sizeText(b.size)}</p>
                {b.size_why && <p className="text-text2">{b.size_why}</p>}
                {b.depends_on.length > 0 && <p className="mt-1">Depends on {b.depends_on.join(", ")}</p>}
              </Block>
              <CodeMap b={b} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
