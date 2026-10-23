"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Button, Notice, SegmentedControl, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { interviewsCall, LIMITS, type InterviewCreate, type InterviewLink, type InterviewOut, type InterviewPatch } from "@/lib/api/interviews";
import { errorMessage, useQuery } from "@/lib/use-query";
import { formatDateTime } from "@/lib/format";

type About = "intake" | "theme" | "topic";
type Step = "subject" | "guide" | "link";
type Draft = { id?: string; prompt: string; purpose: string | null };

const ABOUT: { value: About; label: string }[] = [
  { value: "intake", label: "A PRD idea" },
  { value: "theme", label: "A request theme" },
  { value: "topic", label: "A topic" },
];

/** A link's expiry in the Company time zone, labelled ("Oct 29, 9:14 AM PDT", #447). */
const formatPt = (iso: string) => formatDateTime(iso);

/**
 * Interview a customer (C3): who and what about; then Oracle drafts the questions (a queued
 * job, polled like RefineSection) and the member edits, reorders, deletes and adds them;
 * then Create link shows the private one-time link, once.
 */
export function InterviewDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const [step, setStep] = useState<Step>("subject");
  const [interview, setInterview] = useState<InterviewOut | null>(null);
  const [link, setLink] = useState<InterviewLink | null>(null);

  const title = step === "subject" ? "Interview a customer" : step === "guide" ? "Draft questions" : "Link created";
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="interview-dialog-title"
        tabIndex={-1}
        data-testid="interview-dialog"
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="interview-dialog-title" className="font-display text-xl font-bold tracking-heading">
            {title}
          </h2>
        </div>
        {step === "subject" && (
          <SubjectStep
            onCancel={onClose}
            onCreated={(iv) => {
              setInterview(iv);
              setStep("guide");
              onChanged?.();
            }}
          />
        )}
        {step === "guide" && interview && (
          <GuideStep
            initial={interview}
            onCancel={onClose}
            onLinked={(l) => {
              setLink(l);
              setStep("link");
              onChanged?.();
            }}
          />
        )}
        {step === "link" && link && <LinkStep link={link} onDone={onClose} />}
      </div>
    </div>
  );
}

function SubjectStep({ onCancel, onCreated }: { onCancel: () => void; onCreated: (iv: InterviewOut) => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [about, setAbout] = useState<About>("topic");
  const [intakeId, setIntakeId] = useState("");
  const [themeId, setThemeId] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intakes = useQuery("interview:intakes", () => unwrap(api.GET("/v1/intakes", { params: { query: { limit: 200 } } })));
  const themes = useQuery("interview:themes", () => unwrap(api.GET("/v1/request-themes")));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the customer's name");
    const subject =
      about === "intake" ? (intakeId ? { intake_id: intakeId } : null) : about === "theme" ? (themeId ? { theme_id: themeId } : null) : topic.trim() ? { topic: topic.trim() } : null;
    if (!subject) return setError(about === "topic" ? "Say what to learn about" : about === "intake" ? "Pick a PRD idea" : "Pick a request theme");
    setBusy(true);
    setError(null);
    try {
      const body: InterviewCreate = { kind: "customer", interviewee_name: name.trim(), interviewee_company: company.trim() || null, subject };
      onCreated(await interviewsCall<InterviewOut>("POST", "/v1/interviews", body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Customer name
          <input data-autofocus className={INPUT} value={name} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} placeholder="Name as given" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Company (optional)
          <input className={INPUT} value={company} maxLength={LIMITS.company} onChange={(e) => setCompany(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-text2">What to learn about</span>
        <SegmentedControl label="What to learn about" size="sm" items={ABOUT} value={about} onChange={setAbout} />
      </div>
      {about === "intake" && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          PRD idea
          <select className={INPUT} value={intakeId} onChange={(e) => setIntakeId(e.target.value)}>
            <option value="">Pick a PRD idea</option>
            {(intakes.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {about === "theme" && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Request theme
          <select className={INPUT} value={themeId} onChange={(e) => setThemeId(e.target.value)}>
            <option value="">Pick a theme</option>
            {(themes.data ?? []).filter((t) => !t.archived).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {about === "topic" && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Topic in your words
          <textarea className={INPUT} rows={2} value={topic} maxLength={LIMITS.topic} onChange={(e) => setTopic(e.target.value)} />
        </label>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Next
        </Button>
      </div>
    </form>
  );
}

function GuideStep({ initial, onCancel, onLinked }: { initial: InterviewOut; onCancel: () => void; onLinked: (l: InterviewLink) => void }) {
  const [iv, setIv] = useState(initial);
  const [intro, setIntro] = useState(initial.intro ?? "");
  const [items, setItems] = useState<Draft[]>(initial.guide);
  const [loaded, setLoaded] = useState(initial.guide_job?.status === "succeeded");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const job = iv.guide_job?.status;
  const running = job === "queued" || job === "running";
  const reload = useCallback(async () => {
    const next = await interviewsCall<InterviewOut>("GET", `/v1/interviews/${iv.id}`);
    setIv(next);
    if (next.guide_job?.status === "succeeded") {
      setIntro(next.intro ?? "");
      setItems(next.guide);
      setLoaded(true);
    }
  }, [iv.id]);
  usePolling(running, reload, 600);

  const edit = (update: (list: Draft[]) => Draft[]) => {
    setItems(update);
    setDirty(true);
    setSaved(false);
  };
  const move = (i: number, by: -1 | 1) =>
    edit((list) => {
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  function problem(): string | null {
    if (!items.length) return "Keep at least one question";
    if (items.length > LIMITS.questions) return `At most ${LIMITS.questions} questions`;
    if (items.some((x) => !x.prompt.trim())) return "A question is empty: write it or delete it";
    if (intro.trim().length > LIMITS.intro) return `The intro is at most ${LIMITS.intro} characters`;
    return null;
  }

  async function save(): Promise<InterviewOut | null> {
    const bad = problem();
    if (bad) {
      setError(bad);
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const body: InterviewPatch = {
        lock_version: iv.lock_version,
        intro: intro.trim(),
        guide: items.map((x) => ({ ...(x.id ? { id: x.id } : {}), prompt: x.prompt.trim(), purpose: x.purpose })),
      };
      const next = await interviewsCall<InterviewOut>("PATCH", `/v1/interviews/${iv.id}`, body);
      setIv(next);
      setItems(next.guide);
      setIntro(next.intro ?? "");
      setDirty(false);
      setSaved(true);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createLink() {
    if (dirty && !(await save())) return;
    setBusy(true);
    setError(null);
    try {
      onLinked(await interviewsCall<InterviewLink>("POST", `/v1/interviews/${iv.id}/link`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function redraft() {
    setError(null);
    try {
      setIv(await interviewsCall<InterviewOut>("POST", `/v1/interviews/${iv.id}/guide`));
      setLoaded(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!loaded) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4">
        {job === "failed" || job === "cancelled" ? (
          <Notice tone="error" action={<Button onClick={redraft}>Draft again</Button>}>
            Oracle could not draft the questions{iv.guide_job?.error ? `: ${iv.guide_job.error}` : "."}
          </Notice>
        ) : (
          <p role="status" data-testid="guide-drafting" className="text-[15px] text-text2">
            Oracle is drafting questions for {iv.interviewee_name}…
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4">
      <p className="text-sm text-text2">
        Nothing reaches {iv.interviewee_name} that you did not approve here, except Oracle&rsquo;s short acknowledgements and at most one
        follow-up per question.
      </p>
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Intro
        <textarea
          className={INPUT}
          rows={2}
          value={intro}
          maxLength={LIMITS.intro}
          onChange={(e) => {
            setIntro(e.target.value);
            setDirty(true);
            setSaved(false);
          }}
        />
      </label>
      <ol className="flex flex-col gap-2" aria-label="Questions" data-testid="guide-questions">
        {items.map((x, i) => (
          <li key={x.id ?? `new-${i}`} data-testid="guide-question" className="flex flex-col gap-1 rounded-lg border border-line p-2.5">
            <div className="flex items-start gap-2">
              <span className="tnum mt-1.5 w-5 flex-none text-sm font-semibold text-text2">{i + 1}.</span>
              <textarea
                aria-label={`Question ${i + 1}`}
                className={`${INPUT} min-w-0 flex-1`}
                rows={2}
                value={x.prompt}
                maxLength={LIMITS.prompt}
                onChange={(e) => edit((list) => list.map((y, j) => (j === i ? { ...y, prompt: e.target.value } : y)))}
              />
              <div className="flex flex-none flex-col gap-1">
                <Button variant="ghost" icon="chevron-up" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                <Button
                  variant="ghost"
                  icon="chevron-down"
                  aria-label={`Move question ${i + 1} down`}
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                />
                <Button variant="ghost" icon="x" aria-label={`Delete question ${i + 1}`} onClick={() => edit((list) => list.filter((_, j) => j !== i))} />
              </div>
            </div>
            {x.purpose && <p className="pl-7 text-sm text-text2">{x.purpose}</p>}
          </li>
        ))}
      </ol>
      <div>
        <Button icon="plus" disabled={items.length >= LIMITS.questions} onClick={() => edit((list) => [...list, { prompt: "", purpose: null }])}>
          Add a question
        </Button>
      </div>
      {saved && !dirty && (
        <Notice tone="pass" testId="guide-saved">
          Saved
        </Notice>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
        <Button onClick={() => void save()} disabled={busy || !dirty}>
          Save
        </Button>
        <Button variant="primary" onClick={createLink} disabled={busy}>
          Create link
        </Button>
      </div>
    </div>
  );
}

function LinkStep({ link, onDone }: { link: InterviewLink; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4">
      <p className="text-sm text-text2">Copy it now: it shows only once. Send it to the customer yourself.</p>
      <div className="flex min-w-0 items-center gap-2">
        <input aria-label="Interview link" data-testid="interview-link" readOnly className={`${INPUT} min-w-0 flex-1 font-mono text-sm`} value={link.url} onFocus={(e) => e.target.select()} />
        <Button variant="solid" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p data-testid="interview-link-terms" className="text-sm font-semibold">
        Works once · expires {formatPt(link.expires_at)}
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
