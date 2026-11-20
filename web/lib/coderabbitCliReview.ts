// #1560: reads what `coderabbit review --agent` printed and says what really happened. The CLI
// can print an error and still exit 0, and a review can cover only part of a diff, so the exit
// code alone is not a verdict.
//
// --agent prints one JSON event per line, each with a `type` ({"type":"error","phase":"auth",
// "status":...,"message":...} when it cannot sign in). Events are read loosely: a finding is
// any non-error event that names a file; the review is finished when an event's type or status
// says so; lines that are not JSON count as errors when they start with "error".

export type CliReviewState =
  'reviewed' | 'did-not-review' | 'reviewed-nothing-applicable' | 'reviewed-incompletely';

export type CliReviewInput = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The files in the diff under review (`git diff --name-only base...HEAD`). */
  diffFiles: string[];
};

export type CliReviewVerdict = {
  state: CliReviewState;
  findings: number;
  /** Diff files the review names neither as reviewed nor with a finding, when it lists them. */
  unreviewed: string[];
  reasons: string[];
};

/** `--gate` exits 2 when it finds something at or above the gate: a finished review. */
export const GATE_EXIT = 2;

type Event = Record<string, unknown>;

const FINISHED =
  /^(complete|completed|done|finished|review_complete|review_completed|summary|result)$/i;
const SKIPPED = /skip|ignor|not[_ ]?reviewed|limit/i;
const PLAIN_ERROR = /^\s*(\[?error\]?\b|✖|×)/i;

function parse(text: string): { events: Event[]; plainErrors: string[] } {
  const events: Event[] = [];
  const plainErrors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          events.push(value as Event);
          continue;
        }
      } catch {
        // not JSON: read as plain text below
      }
    }
    if (PLAIN_ERROR.test(line)) plainErrors.push(line);
  }
  return { events, plainErrors };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fileOf(e: Event): string {
  return str(e.file) || str(e.path) || str(e.filename) || str(e.fileName);
}

function fileList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? fileOf(f as Event) : ''))
    .filter(Boolean);
}

function isError(e: Event): boolean {
  return str(e.type).toLowerCase() === 'error' || str(e.level).toLowerCase() === 'error';
}

function isFinished(e: Event): boolean {
  return FINISHED.test(str(e.type)) || FINISHED.test(str(e.status)) || FINISHED.test(str(e.phase));
}

function isSkip(e: Event): boolean {
  return SKIPPED.test(str(e.type)) || SKIPPED.test(str(e.status));
}

function norm(path: string): string {
  return path.replace(/^\.\//, '').replace(/^[ab]\//, '');
}

export function adjudicate(input: CliReviewInput): CliReviewVerdict {
  const out = parse(input.stdout);
  const err = parse(input.stderr);
  const events = [...out.events, ...err.events];
  const errors = [
    ...events
      .filter(isError)
      .map(
        (e) => [str(e.phase), str(e.status), str(e.message)].filter(Boolean).join(': ') || 'error',
      ),
    ...out.plainErrors,
    ...err.plainErrors,
  ];
  const finished = events.some((e) => !isError(e) && isFinished(e));
  const skipped = new Set<string>();
  const reviewed = new Set<string>();
  let listed = false;
  let findings = 0;
  for (const e of events) {
    if (isError(e)) continue;
    const file = fileOf(e);
    if (file && isSkip(e)) skipped.add(norm(file));
    else if (file && !isFinished(e)) {
      findings += 1;
      reviewed.add(norm(file));
    }
    for (const key of [
      'skipped',
      'skippedFiles',
      'skipped_files',
      'ignored',
      'ignoredFiles',
      'ignored_files',
    ]) {
      for (const f of fileList(e[key]) ?? []) skipped.add(norm(f));
    }
    for (const key of ['files', 'reviewedFiles', 'reviewed_files']) {
      const list = fileList(e[key]);
      if (list) {
        listed = true;
        for (const f of list) reviewed.add(norm(f));
      }
    }
  }
  const diff = input.diffFiles.map(norm);
  const unreviewed = diff.filter((f) => skipped.has(f) || (listed && !reviewed.has(f)));
  const exitOk = input.exitCode === 0 || (input.exitCode === GATE_EXIT && finished);
  const reasons: string[] = [];

  if (diff.length === 0) reasons.push('the diff is empty');
  if (input.exitCode === null) reasons.push('the CLI was stopped before it exited');
  else if (!exitOk) reasons.push(`the CLI exited ${input.exitCode}`);
  reasons.push(...errors.map((e) => `error: ${e}`));
  if (!finished) reasons.push('no event says the review finished');
  if (unreviewed.length)
    reasons.push(`${unreviewed.length} of ${diff.length} diff files not reviewed`);

  const verdict = (state: CliReviewState): CliReviewVerdict => ({
    state,
    findings,
    unreviewed,
    reasons,
  });
  if (diff.length === 0) return verdict('did-not-review');
  // Nothing came back from a review: whatever the exit code says, it did not happen.
  if (!finished && findings === 0) return verdict('did-not-review');
  if (!exitOk && findings === 0) return verdict('did-not-review');
  if (errors.length || !finished || !exitOk || unreviewed.length)
    return verdict('reviewed-incompletely');
  return verdict(findings ? 'reviewed' : 'reviewed-nothing-applicable');
}

/** 0 when the review covered the whole diff, else 1. */
export function exitCodeFor(state: CliReviewState): number {
  return state === 'reviewed' || state === 'reviewed-nothing-applicable' ? 0 : 1;
}

export function formatVerdict(v: CliReviewVerdict): string {
  const lines = [
    `coderabbit review: ${v.state} (${v.findings} finding${v.findings === 1 ? '' : 's'})`,
  ];
  for (const r of v.reasons) lines.push(`  - ${r}`);
  for (const f of v.unreviewed) lines.push(`  not reviewed: ${f}`);
  return lines.join('\n');
}
