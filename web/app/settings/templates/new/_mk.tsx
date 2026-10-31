"use client"; // MOCK-HOOK

/*
 * MOCK-HOOK (whole file): mock-up variants for QD4, a new template without raw Markdown.
 * ?qd4=a fields for the name, theme, when to suggest it and the sections (Markdown under
 * "Edit as Markdown"); ?qd4=b start from a copy of a template. Mock-ups only, never merged.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, INPUT, SELECT_FIELD } from "@/app/settings/_components/fields";
import { Button, Notice, PageHeader, Panel } from "@/components/ds";
import { TemplateBodyEditor, useTemplateCheck } from "@/components/TemplateBodyEditor";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

/** The key made from the name: "Launch brief" → "launch-brief". */
export const keyFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

type Sec = { heading: string; guide: string; brief: boolean };

const START: Sec[] = [
  { heading: "Problem", guide: "The customer problem, in the customer's terms.", brief: true },
  { heading: "Solution", guide: "What we will build, as conclusions.", brief: true },
  { heading: "Launch plan", guide: "Who hears about it, when and how.", brief: false },
];
/** Every template ends with this section (the template check asks for it). */
const SOURCES = "## Sources and data points {#sources}\n<!-- The only place for sources, numbers and evidence. -->\n";

function bodyOf(theme: string, when: string, secs: Sec[]) {
  const keyed = secs.filter((s) => s.heading.trim()).map((s) => ({ ...s, key: keyFromName(s.heading) || "section" }));
  return [
    "---",
    `theme: ${theme}`,
    `suggest_when: ${JSON.stringify(when)}`,
    `brief: [${keyed.filter((s) => s.brief).map((s) => s.key).join(", ")}]`,
    "---",
    "",
    "# <Title> {#title}",
    "",
    ...keyed.flatMap((s) => [`## ${s.heading.trim()} {#${s.key}}`, `<!-- ${s.guide.trim()} -->`, ""]),
    SOURCES,
  ].join("\n");
}

function Back() {
  return (
    <Link href="/settings/templates" className="inline-flex items-center hover:text-text hover:underline max-[600px]:min-h-11">
      ← Templates
    </Link>
  );
}

/** a: fields first; the Markdown is one click away under "Edit as Markdown". */
export function TemplateFieldsForm() {
  const router = useRouter();
  const themes = useQuery("mk-themes", () => unwrap(api.GET("/v1/themes")));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"prd" | "roadmap">("prd");
  const [theme, setTheme] = useState("clean-document");
  const [when, setWhen] = useState("");
  const [secs, setSecs] = useState<Sec[]>(START);
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = raw ?? bodyOf(theme, when, secs);
  const live = useTemplateCheck(body);
  const key = keyFromName(name);
  const set = (i: number, patch: Partial<Sec>) => setSecs((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const reason = !name.trim() ? "Enter a name to create the template." : live.data && !live.data.valid ? "Fix the problems in the template to create it." : null;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const t = await unwrap(api.POST("/v1/templates", { body: { key, name: name.trim(), kind, description: when.trim() || null, body } }));
      router.push(`/settings/templates/${t.key}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader back={<Back />} title="New template" />
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3">
        <div className="flex min-w-0 flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          <Panel
            title={raw == null ? "Sections" : "Markdown"}
            tools={
              <Button variant="ghost" onClick={() => setRaw(raw == null ? bodyOf(theme, when, secs) : null)} data-testid="toggle-markdown">
                {raw == null ? "Edit as Markdown" : "Back to fields"}
              </Button>
            }
            bodyClassName="p-4 max-[600px]:p-3"
          >
            {raw == null ? (
              <div className="flex flex-col gap-2" data-testid="template-sections">
                <p className="text-sm text-text2">Every document from this template has these sections, in this order. The guide is what the writer, or Oracle, is told to put there.</p>
                {secs.map((s, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-line bg-surface2 p-2 max-[700px]:grid-cols-1" data-testid="template-section">
                    <input aria-label={`Section ${i + 1} heading`} className={INPUT} value={s.heading} onChange={(e) => set(i, { heading: e.target.value })} placeholder="Heading" />
                    <textarea rows={1} ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }} aria-label={`Section ${i + 1} guide`} className={`${INPUT} resize-none overflow-hidden`} value={s.guide} onChange={(e) => set(i, { guide: e.target.value })} placeholder="What goes here" />
                    <label className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={s.brief} onChange={(e) => set(i, { brief: e.target.checked })} />
                      In the brief
                    </label>
                    <Button variant="ghost" icon="x" aria-label={`Remove ${s.heading || "section"}`} onClick={() => setSecs((xs) => xs.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-2 rounded-lg border border-dashed border-line p-2 text-[15px] text-text2 max-[700px]:grid-cols-1">
                  <span className="px-3 font-semibold text-text">Sources and data points</span>
                  <span className="px-3">Always last: the only place for sources, numbers and evidence.</span>
                </div>
                <span>
                  <Button icon="plus" onClick={() => setSecs((xs) => [...xs, { heading: "", guide: "", brief: false }])}>
                    Add a section
                  </Button>
                </span>
              </div>
            ) : (
              <TemplateBodyEditor value={raw} onChange={setRaw} live={live} />
            )}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-3">
              {reason && <span className="text-sm text-text2">{reason}</span>}
              <Button variant="primary" icon="plus" disabled={busy || !!reason || live.pending} onClick={() => void create()}>
                {busy ? "Creating…" : "Create template"}
              </Button>
            </div>
          </Panel>
        </div>
        <Panel title="Details" bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3">
          <Field label="Name">
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch brief" data-testid="template-name" />
          </Field>
          <p className="-mt-1 text-sm text-text2" data-testid="template-key">
            {key ? (
              <>
                Saved as <b className="font-semibold text-text">{key}</b>, made from the name.
              </>
            ) : (
              "Its key is made from the name."
            )}
          </p>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Kind</legend>
            <div className="flex gap-4 text-[15px]">
              {(["prd", "roadmap"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1.5">
                  <input type="radio" name="kind" className="size-4 accent-[var(--accent)]" checked={kind === k} onChange={() => setKind(k)} />
                  {k === "prd" ? "PRD" : "Roadmap"}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Theme">
            <select className={SELECT_FIELD} value={theme} onChange={(e) => setTheme(e.target.value)}>
              {(themes.data ?? [{ key: "clean-document", name: "Clean document" }]).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When to suggest it">
            <textarea className={`${INPUT} h-auto min-h-20 py-2`} rows={3} value={when} onChange={(e) => setWhen(e.target.value)} placeholder="A launch that needs sales and support ready on the day" />
          </Field>
        </Panel>
      </div>
    </>
  );
}

/** b: start from a copy of a template, name it, then change it on its own page. */
export function TemplateCopyForm() {
  const router = useRouter();
  const list = useQuery("mk-templates", () => unwrap(api.GET("/v1/templates")));
  const [from, setFrom] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = (list.data ?? []).filter((t) => !t.archived_at && (t.kind === "prd" || t.kind === "roadmap"));
  const picked = rows.find((t) => t.key === from);

  async function create() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const full = await unwrap(api.GET("/v1/templates/{key}", { params: { path: { key: picked.key } } }));
      const body = full.versions.find((v) => v.version === full.latest_version)?.body ?? full.versions[0]?.body ?? "";
      const t = await unwrap(api.POST("/v1/templates", { body: { key: keyFromName(name), name: name.trim(), kind: picked.kind as "prd" | "roadmap", description: picked.description, body } }));
      router.push(`/settings/templates/${t.key}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader back={<Back />} title="New template" />
      <Panel title="Start from a copy" bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3">
        <p className="text-sm text-text2">Pick the template closest to what you need. You get a copy to change on its own page: rename, add or drop sections, change the theme.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2" data-testid="copy-from">
          {rows.map((t) => (
            <li key={t.key}>
              <label className={`flex h-full cursor-pointer flex-col gap-1 rounded-lg border p-3 ${from === t.key ? "border-accent bg-accent-soft" : "border-line bg-surface2 hover:border-line-strong"}`}>
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="copy-from" className="size-4 accent-[var(--accent)]" checked={from === t.key} onChange={() => { setFrom(t.key); if (!name) setName(`${t.name} (copy)`); }} />
                  {t.name}
                </span>
                <span className="text-sm text-text2">{t.suggest_when ?? t.description ?? (t.kind === "prd" ? "A PRD template" : "A roadmap template")}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name of the copy">
            <input className={`${INPUT} w-80 max-w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch brief" />
          </Field>
          <Button variant="primary" icon="plus" disabled={!picked || !name.trim() || busy} onClick={() => void create()}>
            {busy ? "Copying…" : "Make the copy"}
          </Button>
        </div>
      </Panel>
    </>
  );
}
