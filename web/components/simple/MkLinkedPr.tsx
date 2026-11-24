// MOCK-HOOK (whole file): mk-linked-pr mock-ups for the owner to pick from, behind local-only
// URL switches: ?lp1=a|b|c|d (linking and showing), ?lp2=a|b|c (the status suggestion),
// ?lp3=a|c|d (set-up and failures), with &open=1, &phase=mid|done, &data=many, &host=off,
// &link=gone. Without lp1/lp2/lp3 nothing here draws. Throwaway branch, never merged.
import { useState, useSyncExternalStore, type ReactNode } from 'react'; // MOCK-HOOK

import { Button, Chip, InfoTip, type ChipKind } from '@/components/ds'; // MOCK-HOOK
import { useMe } from '@/lib/me'; // MOCK-HOOK
import {
  MK_CANDIDATES,
  MK_GONE,
  MK_MANY,
  MK_PRS_LP1,
  MK_PRS_LP2,
  MK_REPO,
  MK_SUGGESTS,
  MK_SUGGESTS_MANY,
  type MkPr,
  type MkSuggest,
} from '@/lib/api/mock/mk-linked-pr'; // MOCK-HOOK

type Step = 'rest' | 'open' | 'mid' | 'done';
type St = {
  step: Step;
  query: string;
  linked: number[];
  accepted: string[];
  dismissed: string[];
  removed: number[];
  connected: boolean;
  copied: boolean;
  menu: number | null;
};

// The switches are read once per page load, so they hold across in-app navigation.
let firstQs: URLSearchParams | null = null;
const qs = () =>
  (firstQs ??= new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search));
export const mkParam = (k: string) => qs().get(k);
export const mkOn = () => !!(mkParam('lp1') || mkParam('lp2') || mkParam('lp3'));

function first(): St {
  const p = qs();
  const step: Step =
    p.get('phase') === 'done'
      ? 'done'
      : p.get('phase') === 'mid'
        ? 'mid'
        : p.get('open')
          ? 'open'
          : 'rest';
  return {
    step,
    query: step === 'mid' ? (p.get('q') ?? '') : '',
    linked: [],
    accepted: [],
    dismissed: [],
    removed: [],
    connected: p.get('host') !== 'off',
    copied: false,
    menu: null,
  };
}
let st: St | null = null;
const subs = new Set<() => void>();
const get = () => (st ??= first());
const set = (f: (s: St) => Partial<St>) => {
  st = { ...get(), ...f(get()) };
  subs.forEach((s) => s());
};
function useSt(): St {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    get,
    get,
  );
}

const DIGEST = 'Weekly alert digest';
const STATE_WORD: Record<MkPr['state'], string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  gone: "Can't be found",
};
const STATE_KIND: Record<MkPr['state'], ChipKind> = {
  open: 'acc',
  merged: 'pass',
  closed: 'na',
  gone: 'crit',
};
const LINK = 'text-sm font-semibold text-accent-ink hover:underline';

/** The pull requests a feature shows, as the active switches draw them. */
function prsFor(title: string, s: St): MkPr[] {
  const lp2 = mkParam('lp2');
  let base = (lp2 ? MK_PRS_LP2 : MK_PRS_LP1)[title] ?? [];
  if (mkParam('data') === 'many' && title === DIGEST) base = MK_MANY;
  if (mkParam('lp1') === 'b' && s.step === 'done' && title === DIGEST)
    base = [
      ...base,
      {
        n: 503,
        title: 'F-79 Unsubscribe link in the digest footer',
        state: 'open',
        by: 'Lena Ortiz',
        when: 'Nov 24',
        via: 'code',
      },
    ];
  if (mkParam('lp3') && mkParam('link') === 'gone' && title === DIGEST) base = [MK_GONE, ...base];
  const added = title === DIGEST ? MK_CANDIDATES.filter((c) => s.linked.includes(c.n)) : [];
  return [...base, ...added].filter((p) => !s.removed.includes(p.n));
}

function Glyph({ className = '' }: { className?: string }) {
  // A merge glyph: two nodes joined, drawn in the chip's own colour.
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`size-3.5 flex-none ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V8a3 3 0 0 0-3-3H6" />
    </svg>
  );
}

function summary(prs: MkPr[]): { kind: ChipKind; words: string } | null {
  const live = prs.filter((p) => p.state !== 'closed' && p.state !== 'gone');
  if (!prs.length) return null;
  const merged = live.filter((p) => p.state === 'merged').length;
  if (prs.some((p) => p.state === 'gone') && !live.length)
    return { kind: 'crit', words: "Can't be found" };
  if (!live.length) return { kind: 'na', words: 'Closed' };
  if (merged === live.length)
    return {
      kind: 'pass',
      words: live.length === 1 ? 'Merged' : `${merged} of ${live.length} merged`,
    };
  if (live.length === 1) return { kind: 'acc', words: 'Open' };
  return { kind: 'acc', words: `${merged} of ${live.length} merged` };
}

function PrLine({ pr, menu }: { pr: MkPr; menu?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-baseline gap-1.5 py-0.5" data-testid={`mk-pr-${pr.n}`}>
      <Chip kind={STATE_KIND[pr.state]} className="!h-5 !px-1.5 !text-xs">
        {STATE_WORD[pr.state]}
      </Chip>
      <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
        <span className="font-semibold text-accent-ink">#{pr.n}</span>{' '}
        {pr.state === 'gone' ? <span className="text-text2">{MK_REPO}</span> : pr.title}
        {pr.via === 'code' && (
          <>
            {' '}
            <InfoTip label={`How #${pr.n} was linked`} align="start">
              Its title names the feature&apos;s code.
            </InfoTip>
          </>
        )}
      </span>
      {menu}
    </li>
  );
}

/** Whether the signed-in member decides (owners, approvers), proposes (commenters) or only reads. */
function useRights() {
  const { can } = useMe();
  return { decide: can('approve_version'), propose: can('create_simple_change') };
}

/** LP2 A: the status Oracle suggests is shown in its place by the panel's Status field. */
export function mkStatus(title: string): string | null {
  const s = get();
  if (mkParam('lp2') && s.accepted.includes(title)) {
    const g = MK_SUGGESTS_MANY.find((x) => x.title === title);
    return g ? g.to : null;
  }
  return null;
}
export function useMkStatus(title: string): string | null {
  useSt();
  return mkStatus(title);
}

function openSuggestion(title: string, s: St): MkSuggest | undefined {
  const list = mkParam('data') === 'many' ? MK_SUGGESTS_MANY : MK_SUGGESTS;
  const g = list.find((x) => x.title === title);
  if (!g || s.accepted.includes(title) || s.dismissed.includes(title)) return undefined;
  return g;
}

function Picker({ title }: { title: string }) {
  const s = useSt();
  const shown = MK_CANDIDATES.filter(
    (c) =>
      !s.linked.includes(c.n) && `#${c.n} ${c.title}`.toLowerCase().includes(s.query.toLowerCase()),
  );
  return (
    <div
      className="mt-1.5 rounded-xl border border-line bg-surface p-2 shadow-tip"
      data-testid="mk-picker"
    >
      <input
        autoFocus
        aria-label="Find a pull request"
        placeholder={`Find in ${MK_REPO}`}
        value={s.query}
        onChange={(e) => set(() => ({ query: e.target.value, step: 'mid' }))}
        className="block h-8 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-text"
      />
      <ul className="mt-1.5 max-h-56 overflow-auto">
        {shown.map((c) => (
          <li key={c.n} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface2">
            <Chip kind={STATE_KIND[c.state]} className="!h-5 !px-1.5 !text-xs">
              {STATE_WORD[c.state]}
            </Chip>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">#{c.n}</span> {c.title}
            </span>
            <Button
              aria-label={`Link #${c.n} to ${title}`}
              onClick={() =>
                set((x) => ({
                  linked: [...x.linked, c.n],
                  // LP3 C: relinking resolves the broken link too.
                  removed: mkParam('lp3') ? [...x.removed, MK_GONE.n] : x.removed,
                  step: 'done',
                  query: '',
                }))
              }
            >
              Link
            </Button>
          </li>
        ))}
        {!shown.length && <li className="px-1 py-1 text-sm text-text2">No match</li>}
      </ul>
    </div>
  );
}

/** The panel's rows (dt/dd pairs in the fields' grid), right under Status. */
export function MkPanelRows({
  title,
  code,
  canChange,
}: {
  title: string;
  code: string | null;
  canChange: boolean;
}) {
  const s = useSt();
  const rights = useRights();
  const lp1 = mkParam('lp1');
  const lp2 = mkParam('lp2');
  const lp3 = mkParam('lp3');
  if (!lp1 && !lp2 && !lp3) return null;
  if (lp1 === 'd') return null; // D draws its own section under the fields.
  const prs = prsFor(title, s);
  const off = !!lp3 && !s.connected;

  let list: ReactNode;
  if (off && lp3 === 'a') {
    list = (
      <span className="flex flex-wrap items-center gap-2">
        <Chip kind="na" className="!h-5 !px-1.5 !text-xs">
          GitHub not connected
        </Chip>
        {rights.decide && (
          <Button onClick={() => set(() => ({ step: 'mid' }))} disabled={s.step === 'mid'}>
            {s.step === 'mid' ? 'Connecting…' : 'Connect GitHub'}
          </Button>
        )}
      </span>
    );
  } else if (off) {
    list = <span className="text-text2">Nothing linked</span>;
  } else {
    list = (
      <ul data-testid="mk-prs">
        {prs.map((p) => (
          <PrLine
            key={p.n}
            pr={p}
            menu={
              lp3 === 'a' && p.state === 'gone' && rights.propose ? (
                <span className="relative flex-none">
                  <button
                    type="button"
                    className={LINK}
                    aria-expanded={s.menu === p.n}
                    onClick={() =>
                      set((x) => ({ menu: x.menu === p.n ? null : p.n, step: 'open' }))
                    }
                  >
                    Fix
                  </button>
                  {s.menu === p.n && (
                    <span
                      className="absolute top-6 right-0 z-30 flex w-48 flex-col rounded-xl border border-line bg-surface p-1 shadow-tip"
                      role="menu"
                    >
                      <button
                        role="menuitem"
                        type="button"
                        className="rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface2"
                        onMouseEnter={() => set(() => ({ step: 'mid' }))}
                        onClick={() =>
                          set((x) => ({ removed: [...x.removed, p.n], menu: null, step: 'done' }))
                        }
                      >
                        {rights.decide ? 'Remove the link' : 'Propose removing it'}
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        className="rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface2"
                      >
                        Link another
                      </button>
                    </span>
                  )}
                </span>
              ) : undefined
            }
          />
        ))}
        {!prs.length && <li className="text-text2">Nothing linked</li>}
      </ul>
    );
  }

  let control: ReactNode = null;
  if (!off && canChange && (lp1 === 'a' || lp2 || lp3)) {
    control =
      s.step === 'open' || s.step === 'mid' ? (
        lp1 === 'a' ? (
          <Picker title={title} />
        ) : null
      ) : (
        <button type="button" className={LINK} onClick={() => set(() => ({ step: 'open' }))}>
          {rights.decide ? 'Link a pull request' : 'Propose a link'}
        </button>
      );
    if (lp3 && s.step !== 'rest') control = null;
  }
  if (lp1 === 'b') {
    control = code ? (
      <span className="flex flex-wrap items-center gap-2">
        <Button onClick={() => set(() => ({ step: 'mid', copied: true }))}>
          {s.copied || s.step === 'mid' ? `✓ Copied ${code}` : `Copy ${code}`}
        </Button>
        <InfoTip label="Link by code" align="start">
          <ol className="list-decimal pl-4">
            <li>Put {code} in the pull request&apos;s title.</li>
            <li>Oracle links it when it opens.</li>
          </ol>
        </InfoTip>
      </span>
    ) : (
      <span className="flex items-center gap-1.5">
        <Chip kind="warn" className="!h-5 !px-1.5 !text-xs">
          Needs a code first
        </Chip>
        <InfoTip label="No code" align="start">
          A pull request names a feature by its code.
        </InfoTip>
      </span>
    );
  }
  if (lp1 === 'c' && canChange) {
    control = (
      <form
        className="mt-1 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          set((x) => ({ linked: [...x.linked, 503], step: 'done', query: '' }));
        }}
      >
        <input
          aria-label="Paste a pull request link"
          placeholder="Paste a pull request link"
          value={s.query}
          onFocus={() => s.step === 'rest' && set(() => ({ step: 'open' }))}
          onChange={(e) => set(() => ({ query: e.target.value, step: 'mid' }))}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm text-text"
        />
        <Button type="submit" disabled={!s.query}>
          Link
        </Button>
      </form>
    );
  }

  const sug = lp2 === 'a' ? openSuggestion(title, s) : undefined;
  return (
    <>
      <dt className="text-text2">Pull requests</dt>
      <dd className="min-w-0" data-testid="mk-panel-prs">
        {list}
        {control}
      </dd>
      {sug && (rights.decide || rights.propose) && (
        <>
          <dt className="sr-only">Oracle&apos;s status</dt>
          <dd
            className="col-span-full rounded-xl border border-accent bg-accent-soft p-3"
            data-testid="mk-suggest"
          >
            <p className="text-sm font-semibold">
              Oracle suggests {sug.to}{' '}
              <InfoTip label="Why Oracle suggests it" align="start">
                {sug.why}
              </InfoTip>
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                onClick={() => set((x) => ({ accepted: [...x.accepted, title], step: 'done' }))}
              >
                {rights.decide ? 'Accept' : `Propose ${sug.to}`}
              </Button>
              {rights.decide && (
                <Button
                  variant="ghost"
                  onClick={() => set((x) => ({ dismissed: [...x.dismissed, title] }))}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </dd>
        </>
      )}
    </>
  );
}

/** LP1 D: the panel's own "Pull requests" section, and a dialog to link several at once. */
export function MkPanelSection({ title, canChange }: { title: string; canChange: boolean }) {
  const s = useSt();
  const [picked, setPicked] = useState<number[]>(mkParam('phase') === 'mid' ? [503, 502] : []);
  if (mkParam('lp1') !== 'd') return null;
  const prs = prsFor(title, s);
  const groups: MkPr['state'][] = ['open', 'merged', 'closed'];
  return (
    <section className="mt-4" data-testid="mk-section">
      <h3 className="text-xs font-semibold tracking-[0.06em] text-text2 uppercase">
        Pull requests
      </h3>
      {groups.map((g) => {
        const of = prs.filter((p) => p.state === g);
        return of.length ? (
          <div key={g} className="mt-1">
            <p className="text-xs text-text2">
              {STATE_WORD[g]} · {of.length}
            </p>
            <ul>
              {of.map((p) => (
                <PrLine key={p.n} pr={p} />
              ))}
            </ul>
          </div>
        ) : null;
      })}
      {canChange && (
        <button
          type="button"
          className={`${LINK} mt-1`}
          onClick={() => set(() => ({ step: 'open' }))}
        >
          + Link pull requests
        </button>
      )}
      {(s.step === 'open' || s.step === 'mid') && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-label="Link pull requests"
        >
          <div className="w-[520px] max-w-full rounded-2xl border border-line bg-surface p-4 shadow-tip">
            <h2 className="text-lg font-semibold">Link pull requests to {title}</h2>
            <input
              aria-label="Find a pull request"
              placeholder={`Find in ${MK_REPO}`}
              className="mt-3 block h-9 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-text"
            />
            <ul className="mt-2">
              {MK_CANDIDATES.map((c) => (
                <li key={c.n}>
                  <label className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-surface2">
                    <input
                      type="checkbox"
                      checked={picked.includes(c.n)}
                      onChange={() =>
                        setPicked((p) =>
                          p.includes(c.n) ? p.filter((n) => n !== c.n) : [...p, c.n],
                        )
                      }
                    />
                    <Chip kind={STATE_KIND[c.state]} className="!h-5 !px-1.5 !text-xs">
                      {STATE_WORD[c.state]}
                    </Chip>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-semibold">#{c.n}</span> {c.title}
                    </span>
                    <span className="text-xs text-text2">{c.when}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => set(() => ({ step: 'rest' }))}>
                Cancel
              </Button>
              <Button
                variant="solid"
                disabled={!picked.length}
                onClick={() => set((x) => ({ linked: [...x.linked, ...picked], step: 'done' }))}
              >
                Link {picked.length || ''}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** The mark on a Priorities row, beside the feature's name. */
export function MkRowChip({ title, onOpen }: { title: string; onOpen?: () => void }) {
  const s = useSt();
  const rights = useRights();
  const lp1 = mkParam('lp1');
  const lp2 = mkParam('lp2');
  const lp3 = mkParam('lp3');
  if (!lp1 && !lp2 && !lp3) return null;
  if (lp1 === 'd') return null;
  if (lp3 && !s.connected) return null;
  const prs = prsFor(title, s);
  const sum = summary(prs);
  const sug = openSuggestion(title, s);
  const accepted = !!lp2 && s.accepted.includes(title);
  const chip = sum && (
    <button
      type="button"
      onClick={onOpen}
      className="flex-none"
      data-testid="mk-row-chip"
      title={`${prs.length} pull requests`}
    >
      <Chip kind={sum.kind} className="!h-6 !px-2 !text-xs">
        <Glyph />
        {lp1 === 'b' ? prs.length : sum.words}
      </Chip>
    </button>
  );
  if (lp1 === 'c') {
    const shown = prs.slice(0, 2);
    return (
      <span className="flex flex-none items-center gap-1" data-testid="mk-row-chips">
        {shown.map((p) => (
          <Chip key={p.n} kind={STATE_KIND[p.state]} className="!h-6 !px-2 !text-xs">
            #{p.n} {STATE_WORD[p.state]}
          </Chip>
        ))}
        {prs.length > 2 && (
          <Chip kind="line" className="!h-6 !px-2 !text-xs">
            +{prs.length - 2}
          </Chip>
        )}
      </span>
    );
  }
  const gone = lp3 === 'a' && prs.some((p) => p.state === 'gone');
  return (
    <span className="flex flex-none items-center gap-1.5">
      {chip}
      {gone && (
        <Chip kind="crit" className="!h-6 !px-2 !text-xs">
          ⚠ 1 link
        </Chip>
      )}
      {accepted && (
        <Chip kind="pass" className="!h-6 !px-2 !text-xs" data-testid="mk-row-done">
          ✓ Done
        </Chip>
      )}
      {lp2 === 'a' && sug && (
        <button type="button" onClick={onOpen} data-testid="mk-row-suggest" className="flex-none">
          <Chip kind="acc" className="!h-6 !border !border-accent !px-2 !text-xs">
            ✦ {sug.to}?
          </Chip>
        </button>
      )}
      {lp2 === 'c' && sug && (
        <span className="relative flex-none" data-testid="mk-row-inline">
          <button
            type="button"
            aria-expanded={s.step !== 'rest'}
            onClick={() => set((x) => ({ step: x.step === 'rest' ? 'open' : 'rest' }))}
          >
            <Chip kind="acc" className="!h-6 !border !border-accent !px-2 !text-xs">
              ✦ {sug.to}?
            </Chip>
          </button>
          {s.step !== 'rest' && (
            <span
              role="dialog"
              aria-label="Oracle's status suggestion"
              className="absolute top-8 left-0 z-30 block w-[300px] rounded-xl border border-line bg-surface p-3 text-left shadow-tip"
            >
              <span className="block text-sm font-semibold">
                Oracle suggests {sug.to} <span className="font-normal text-text2">· {sug.why}</span>
              </span>
              {(rights.decide || rights.propose) && (
                <span className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    aria-label={rights.decide ? `Accept ${sug.to}` : `Propose ${sug.to}`}
                    variant={s.step === 'mid' ? 'solid' : 'secondary'}
                    onMouseEnter={() => set(() => ({ step: 'mid' }))}
                    onClick={() => set((x) => ({ accepted: [...x.accepted, title], step: 'done' }))}
                  >
                    {rights.decide ? 'Accept' : `Propose ${sug.to}`}
                  </Button>
                  {rights.decide && (
                    <Button
                      variant="ghost"
                      onClick={() => set((x) => ({ dismissed: [...x.dismissed, title] }))}
                    >
                      Dismiss
                    </Button>
                  )}
                </span>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** LP3 D: one strip at the top of Priorities for the code host's problems. */
export function MkPageStrip() {
  const s = useSt();
  const rights = useRights();
  if (mkParam('lp3') !== 'd') return null;
  const gone = mkParam('link') === 'gone' && !s.removed.includes(MK_GONE.n);
  if (s.connected && !gone) return null;
  return (
    <div
      className="mb-3 rounded-xl border border-warn bg-warn-bg px-3 py-2 text-sm"
      data-testid="mk-strip"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-warn">⚠</span>
        {!s.connected && (
          <>
            <span className="font-semibold">GitHub not connected</span>
            {rights.decide && (
              <Button onClick={() => set(() => ({ connected: true }))}>Connect GitHub</Button>
            )}
          </>
        )}
        {s.connected && gone && (
          <>
            <span className="font-semibold">1 pull request link can&apos;t be found</span>
            <button
              type="button"
              className={LINK}
              aria-expanded={s.step !== 'rest'}
              onClick={() => set((x) => ({ step: x.step === 'rest' ? 'open' : 'rest' }))}
            >
              {s.step === 'rest' ? 'Show' : 'Hide'}
            </button>
          </>
        )}
      </div>
      {s.connected && gone && s.step !== 'rest' && (
        <ul className="mt-2 border-t border-line pt-2">
          <li className="flex flex-wrap items-center gap-2">
            <Chip kind="crit" className="!h-5 !px-1.5 !text-xs">
              Can&apos;t be found
            </Chip>
            <span>
              <span className="font-semibold">#466</span> on{' '}
              <span className="font-medium">F-79 Weekly alert digest</span>
            </span>
            {rights.propose && (
              <Button
                onMouseEnter={() => set(() => ({ step: 'mid' }))}
                onClick={() => set((x) => ({ removed: [...x.removed, MK_GONE.n], step: 'done' }))}
              >
                {rights.decide ? 'Remove the link' : 'Propose removing it'}
              </Button>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}

/** Rows at the top of the Inbox's New tab (LP2 A and B, LP3 C), in the Inbox's own columns. */
export function MkInboxRows() {
  const s = useSt();
  const rights = useRights();
  const lp2 = mkParam('lp2');
  const lp3 = mkParam('lp3');
  const rows: ReactNode[] = [];
  const row = (
    key: string,
    kind: ReactNode,
    what: ReactNode,
    ctx: ReactNode,
    actions: ReactNode,
  ) => (
    <div
      key={key}
      data-testid={`mk-inbox-${key}`}
      className="grid grid-cols-[170px_minmax(0,1fr)_24%_48px_minmax(0,300px)] items-center gap-x-3 border-t border-line px-4 py-2.5 text-base max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-y-1"
    >
      <span className="flex items-center gap-2.5 font-medium max-[700px]:col-span-2">{kind}</span>
      <span className="min-w-0">{what}</span>
      <span className="min-w-0 text-text2 max-[700px]:hidden">{ctx}</span>
      <span className="text-text2 max-[700px]:hidden">1d</span>
      <span className="flex flex-wrap items-center justify-end gap-2 max-[700px]:col-span-2 max-[700px]:justify-start">
        {actions}
      </span>
    </div>
  );
  const code = (c: string | null, t: string) => (
    <span className="font-medium text-accent-ink">
      {c && <span className="mr-1.5 rounded bg-accent-soft px-1 font-mono text-sm">{c}</span>}
      {t}
    </span>
  );
  if (lp2 === 'a' || lp2 === 'b') {
    const list = (mkParam('data') === 'many' ? MK_SUGGESTS_MANY : MK_SUGGESTS).filter(
      (g) => !s.accepted.includes(g.title) && !s.dismissed.includes(g.title),
    );
    if (lp2 === 'b' && list.length > 1 && rights.decide)
      rows.push(
        <div
          key="all"
          className="flex items-center justify-between border-t border-line px-4 py-2 text-sm"
          data-testid="mk-inbox-all"
        >
          <span className="font-semibold text-text2">Status · {list.length}</span>
          <Button
            onClick={() =>
              set((x) => ({ accepted: [...x.accepted, ...list.map((g) => g.title)], step: 'done' }))
            }
          >
            Accept all {list.length}
          </Button>
        </div>,
      );
    for (const g of list)
      rows.push(
        row(
          `status-${g.title}`,
          <>
            <Glyph className="size-4 text-text2" /> Status
          </>,
          <>
            {code(g.code, g.title)}
            <br />
            <span className="text-sm text-text2">
              {g.from} → Oracle suggests <span className="font-semibold text-text">{g.to}</span>
            </span>
          </>,
          <>
            {g.why}{' '}
            <InfoTip label={`Pull requests on ${g.title}`} align="start">
              <ul>
                {(MK_PRS_LP2[g.title] ?? []).map((p) => (
                  <li key={p.n}>
                    #{p.n} {p.title} · {STATE_WORD[p.state]}
                  </li>
                ))}
              </ul>
            </InfoTip>
          </>,
          rights.decide || rights.propose ? (
            <>
              <Button
                onClick={() => set((x) => ({ accepted: [...x.accepted, g.title], step: 'done' }))}
              >
                {rights.decide ? 'Accept' : `Propose ${g.to}`}
              </Button>
              {rights.decide && (
                <button
                  type="button"
                  className="text-sm font-semibold text-text2 hover:underline"
                  onClick={() => set((x) => ({ dismissed: [...x.dismissed, g.title] }))}
                >
                  Dismiss
                </button>
              )}
            </>
          ) : null,
        ),
      );
    rows.push(
      row(
        'late',
        <>
          <Glyph className="size-4 text-warn" /> Status
        </>,
        <>
          {code(null, 'Sample data import')}
          <br />
          <span className="text-sm text-warn">Past its end date · no pull request</span>
        </>,
        'Ended Nov 15',
        <Button>Open</Button>,
      ),
    );
  }
  if (lp3 === 'c') {
    if (!s.connected)
      rows.push(
        row(
          'host',
          <>
            <Glyph className="size-4 text-text2" /> GitHub
          </>,
          <>
            <span className="font-medium">Not connected</span>
            <br />
            <span className="text-sm text-text2">4 features wait on it</span>
          </>,
          'Pull requests',
          rights.decide ? (
            <Button onClick={() => set(() => ({ connected: true, step: 'done' }))}>
              Connect GitHub
            </Button>
          ) : null,
        ),
      );
    if (s.connected && mkParam('link') === 'gone' && !s.removed.includes(MK_GONE.n))
      rows.push(
        row(
          'gone',
          <>
            <Glyph className="size-4 text-crit" /> Link broken
          </>,
          <>
            {code('F-79', DIGEST)}
            <br />
            <span className="text-sm">
              <span className="font-semibold">#466</span>{' '}
              <span className="text-crit">can&apos;t be found</span>{' '}
              <InfoTip label="Why a link breaks" align="start">
                Deleted, moved, or access removed.
              </InfoTip>
            </span>
          </>,
          MK_REPO,
          rights.propose ? (
            <>
              {s.step === 'open' || s.step === 'mid' ? (
                <span className="w-full">
                  <Picker title={DIGEST} />
                </span>
              ) : (
                <>
                  <Button onClick={() => set(() => ({ step: 'open' }))}>Relink</Button>
                  <button
                    type="button"
                    className="text-sm font-semibold text-text2 hover:underline"
                    onClick={() =>
                      set((x) => ({ removed: [...x.removed, MK_GONE.n], step: 'done' }))
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </>
          ) : null,
        ),
      );
  }
  if (!rows.length) return null;
  return <div data-testid="mk-inbox">{rows}</div>;
}
