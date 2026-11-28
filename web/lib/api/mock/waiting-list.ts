import { requestWords } from '@/app/inbox/_request-words';

import { mockNowMs } from './clock';
import { companyDayIso } from './connections';

import type { Schemas } from '../client';

type Item = Schemas['SimpleWaitingItem'];

/** What a run stop asks, in plain words (oracle.simple.waiting_list _STOP_ACTION). */
const STOP_ACTION: Record<string, string> = {
  feature_set: 'Check the feature set',
  eng_review: 'Check the engineering review',
  priority_order: 'Set the order',
  prd_review: 'Review the PRD',
  eng_dates: 'Review the dates',
  roadmap_items: 'Check the roadmap items',
  baseline_confirm: 'Confirm the Ground Truth',
};

/** draw-time (#1870): built once, not per row (building a formatter is slow on the page's thread). */
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Nov 4", with the year when it is not this year's in the company's time zone ("Jan 8, 2027"). */
function day(d: string): string {
  const at = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  const year = companyDayIso(new Date(mockNowMs())).slice(0, 4);
  const thisYear = String(at.getUTCFullYear()) === year;
  return (thisYear ? MONTH_DAY : MONTH_DAY_YEAR).format(at);
}

/**
 * home-waiting-one-list: the mock of oracle.simple.waiting_list. GET
 * /v1/simple/decisions/waiting's `items`, everything that waits on the signed-in person, read
 * from the mock's own answers to the routes each kind lives on (so it can never disagree with
 * them): the run stops they may decide, the PRD questions they own, the decision-log calls
 * proposed to them (the Inbox's decisions they decide, as the waiting count's `others`), broken links and dates on
 * items they decide, drafts waiting for their approval, proposals on their items, the goal
 * suggestions they decide and the proposed goals they may confirm (an approver or the owner, as
 * POST /v1/baseline/entities/{id}/confirm takes), then the Inbox's other counted rows (Add
 * predictions, launches, rituals, metrics, requests).
 */
export async function waitingItems(
  get: (path: string) => Promise<unknown>,
  meId: string,
  questions: Schemas['SimpleQuestion'][],
  role = '',
  // #1913: a Simple change's own words (changes.words), for a proposal the reader's changes list leaves out.
  wordsOf: (id: string) => string | null = () => null,
): Promise<Item[]> {
  const read = async <T>(path: string): Promise<T | undefined> =>
    (await get(path).catch(() => undefined)) as T | undefined;
  const confirmsGoals = role === 'approver' || role === 'owner';
  const [inbox, roadmap, drafts, changes, goals, entities] = await Promise.all([
    read<Schemas['InboxOut']>('/v1/inbox'),
    read<Schemas['SimpleRoadmapOut']>('/v1/simple/roadmap'),
    read<Schemas['SimpleDraftOut'][]>('/v1/simple/drafts'),
    read<Schemas['SimpleChangeOut'][]>('/v1/simple/changes?status=proposed'),
    read<Schemas['SimpleGoalSuggestionsOut']>('/v1/simple/goal-suggestions?status=open'),
    confirmsGoals
      ? read<Schemas['EntityOut'][]>('/v1/baseline/entities?type=goal&status=proposed')
      : undefined,
  ]);
  const out: Item[] = [];
  for (const c of [...(inbox?.checkpoints ?? [])].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )) {
    if (!c.can_decide || c.status !== 'pending') continue;
    const action = STOP_ACTION[c.kind] ?? 'Open the stop';
    out.push({
      kind: 'run_stop',
      key: `run_stop:${c.id}`,
      ref_id: c.id,
      title: action,
      detail:
        c.document_title ||
        (c.document_slug
          ? `${c.document_slug.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase())} PRD`
          : c.flow_title || 'A run'),
      action,
      href: `/runs/${c.run_id}`,
      at: c.created_at,
      op: null,
    });
  }
  for (const q of questions) {
    out.push({
      kind: 'question',
      key: `question:${q.id}`,
      ref_id: q.id,
      title: `${q.code} ${q.title}`.trim(),
      detail: q.prd.title,
      action: 'Decide',
      href: `/simple/decisions?prd=${q.prd.slug}`,
      at: null,
      op: null,
    });
  }
  const calls = (inbox?.decisions ?? [])
    .filter((d) => d.counts && d.reason === 'needs_decision')
    .sort((a, b) => a.number - b.number);
  for (const c of calls) {
    const d = await read<Schemas['DecisionOut']>(`/v1/decisions/${c.number}`);
    out.push({
      kind: 'decision',
      key: `decision:${c.id}`,
      ref_id: String(c.number),
      title: c.title,
      detail: d?.question ?? '',
      action: 'Decide',
      href: `/simple/decisions?decision=${c.number}`,
      at: c.since,
      op: null,
    });
  }
  const titles = new Map((roadmap?.items ?? []).map((i) => [i.id, i.title]));
  for (const i of roadmap?.items ?? []) {
    if (!i.can_decide) continue;
    for (const f of i.flags) {
      // qa-simple-home-3: every red flag with a fix (waiting_list._roadmap, isBrokenLink).
      if (f.state !== 'red' || !f.fixes.length) continue;
      const dep = f.subject ? titles.get(f.subject) : undefined;
      out.push({
        kind: 'broken_link',
        key: `broken_link:${i.id}:${f.kind}:${f.subject ?? ''}`,
        ref_id: i.id,
        title: i.title,
        detail: dep && !f.reason.includes(dep) ? `${f.reason} (${dep})` : f.reason,
        action: 'Fix the link',
        href: `/simple/roadmap?item=${i.id}`,
        at: null,
        op: null,
      });
    }
    const s = i.suggestion;
    if (s && s.status === 'open' && s.can_decide) {
      out.push({
        kind: 'date',
        key: `date:${s.id}`,
        ref_id: s.id,
        title: i.title,
        detail: `Oracle suggests ${day(s.start_date)} – ${day(s.end_date)}`,
        action: 'Confirm the dates',
        href: `/simple/roadmap?item=${i.id}`,
        at: s.created_at,
        op: null,
      });
    }
  }
  for (const d of drafts ?? []) {
    // A required reviewer's, or the decider's whose final approval is not in yet (waiting_list._drafts).
    if (!d.can_approve) continue;
    out.push({
      kind: 'draft',
      key: `draft:${d.id}`,
      ref_id: d.id,
      title: d.document.title,
      detail: 'A roadmap draft waits for your approval',
      action: 'Approve',
      href: `/simple/roadmap?roadmap=${d.document.id}`,
      at: null,
      op: null,
    });
  }
  // inbox-2 (#1893): and every proposal the Inbox counts for me (waiting_reads.proposals); one I
  // may not decide now opens in the Inbox.
  const routed = new Map((inbox?.simple_proposals ?? []).map((p) => [p.id, p]));
  const listed = (changes ?? []).filter(
    (c) => c.status === 'proposed' && (c.can_decide || routed.has(c.id)),
  );
  const known = new Set(listed.map((c) => c.id));
  const proposals = [
    ...listed.map((c) => ({ ...c, item: (c.target as { item_id?: string }).item_id })),
    ...[...routed.values()]
      .filter((p) => !known.has(p.id))
      .map((p) => ({
        ...p,
        item: p.item_id ?? undefined,
        // #1913: as changes.words says it, a request naming its item by code and name.
        words: wordsOf(p.id) ?? (p.asked ? requestWords(p.by_name, p.asked) : ''),
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  for (const c of proposals) {
    const date = c.op === 'accept_date_suggestion';
    const decides = !!c.can_decide;
    const title = c.words || (date ? 'New dates proposed' : 'A proposed change');
    out.push({
      kind: decides ? (date ? 'date' : 'proposal') : 'inbox',
      key: `proposal:${c.id}`,
      ref_id: c.id,
      title,
      detail: `Proposed by ${c.by_name}`,
      action: decides ? 'Accept' : 'Open',
      href: !decides
        ? '/simple/inbox'
        : c.item
          ? `/simple/roadmap?item=${c.item}`
          : '/simple/roadmap',
      at: c.at,
      op: c.op,
    });
  }
  for (const s of goals?.suggestions ?? []) {
    if (s.status !== 'open' || !s.can_accept) continue;
    out.push({
      kind: 'goal_suggestion',
      key: `goal_suggestion:${s.id}`,
      ref_id: s.id,
      title: s.title,
      detail: `Suggested for ${s.goal.title}`,
      action: 'Confirm',
      href: '/simple/goals',
      at: s.created_at,
      op: null,
    });
  }
  const proposed = (entities ?? [])
    .filter((g) => g.type === 'goal' && g.status === 'proposed')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const g of proposed) {
    out.push({
      kind: 'goal',
      key: `goal:${g.id}`,
      ref_id: g.id,
      title: g.title,
      detail: '',
      action: 'Confirm',
      href: '/simple',
      at: g.created_at,
      op: null,
    });
  }
  // The Inbox's other counted rows (waiting_list._inbox), in the Inbox's words, so Home and the Inbox agree.
  const row = (
    key: string,
    title: string,
    detail: string,
    href: string,
    at: string | null = null,
    action = 'Open',
    ref_id = key.split(':').at(-1)!,
  ): Item => ({ kind: 'inbox', key, ref_id, title, detail, action, href, at, op: null });
  for (const o of inbox?.outcomes ?? [])
    if (o.counts)
      out.push(
        row(
          `outcome:${o.reason}:${o.id}`,
          o.title,
          'Plan › Outcomes',
          `/plan/outcomes?outcome=${o.id}`,
        ),
      );
  for (const r of inbox?.launches ?? [])
    if (r.counted)
      out.push(
        row(
          `launch:${r.reason}:${r.launch_id}`,
          `${LAUNCH[r.reason] ?? 'Launch'} · ${r.title}`,
          r.item,
          `/roadmap/launches?launch=${r.launch_id}`,
          r.at ?? null,
        ),
      );
  // A ritual that failed to prepare: Retry (its ritual's prepare) and Company › Rituals, as the Inbox.
  for (const r of inbox?.rituals ?? []) {
    if (!r.counts || (r.state !== 'new' && r.state !== 'open')) continue;
    const failed = r.reason === 'failed';
    out.push(
      row(
        `ritual:${r.reason}:${r.occurrence_id}`,
        `${RITUAL[r.reason]} · ${r.title}`,
        'Rituals',
        failed ? '/company/rituals' : `/company/rituals/${r.occurrence_id}`,
        r.due_at,
        failed ? 'Retry' : 'Open',
        failed ? r.ritual_id : undefined,
      ),
    );
  }
  for (const m of inbox?.metrics ?? []) {
    if (!m.counts) continue;
    const href =
      m.reason !== 'pull_failed' && m.occurrence_id
        ? `/company/rituals/${m.occurrence_id}`
        : `/company/metrics?metric=${m.metric_id}`;
    out.push(
      row(
        `metric:${m.reason}:${m.variance_id ?? m.metric_id}`,
        `${METRIC[m.reason]} · ${m.metric_title}`,
        'Metrics',
        href,
      ),
    );
  }
  for (const r of inbox?.requests ?? [])
    if (r.counts)
      out.push(
        row(
          `request:${r.reason}:${r.request_id}`,
          `${REQUEST[r.reason]} · ${r.title}`,
          'Requests',
          `/requests?request=${r.request_id}`,
          r.at ?? null,
        ),
      );
  // #1817: my open meeting action items, closed in the Inbox.
  for (const a of inbox?.simple_action_items ?? [])
    out.push(
      row(
        `action:${a.id}`,
        `Action item · ${a.title}`,
        [a.due_date && `Due ${day(a.due_date)}`, a.item_title, a.meeting_title]
          .filter(Boolean)
          .join(' · '),
        '/simple/inbox',
        a.at,
      ),
    );
  return out;
}

/** The Inbox's words for each row (oracle.simple.waiting_list _LAUNCH, _RITUAL, _METRIC, _REQUEST). */
const LAUNCH: Record<string, string> = {
  ready: 'Ready to launch',
  set_tier: 'Set tier',
  notes_to_send: 'Notes to send',
};
const RITUAL: Record<string, string> = {
  pre_read: 'Pre-read ready',
  record_notes: 'Record notes',
  failed: 'Ritual failed to prepare',
};
const METRIC: Record<string, string> = {
  explain: 'Explain an unusual week',
  find_out: 'Find out',
  pull_failed: 'Metric not read for a day',
};
const REQUEST: Record<string, string> = {
  replies_to_send: 'Replies to send',
  asked_again: 'Asked again since you said no',
  answer: 'Answer to your request',
};
