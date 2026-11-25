// task-push (#1816): a task under a roadmap item goes to the connected tracker, as
// api/oracle/simple/task_push.py does. In the "task-tracker" scenario a tracker is connected
// (two-way sync on) but, as in the API, no connector is verified: every push is refused and the
// refusal is kept on the task, shown with Retry. The item "alert-export" carries
// one task already linked to its record (made as if a connector had created it).
import { MOCK_SCENARIO_KEY } from './ids';
import { canDecideItem, taskOut } from './simple-roadmap';

type SimpleDb = Parameters<typeof canDecideItem>[0];
type Role = Parameters<typeof canDecideItem>[2]['role'];

export const TASK_TRACKER_SCENARIO = 'task-tracker';
// api/oracle/roadmap/tracker.py UNVERIFIED_REASON.
export const TRACKER_UNVERIFIED =
  'Two-way tracker sync is switched on, but no tracker connector has been verified end to end, so Oracle still writes nothing.';

export const trackerConnected = () =>
  typeof localStorage !== 'undefined' &&
  localStorage.getItem(MOCK_SCENARIO_KEY) === TASK_TRACKER_SCENARIO;

/** task_push.push: when a tracker is connected, the push's outcome is stored on the task. */
export function pushTask(task: Record<string, unknown> | undefined): void {
  if (!task || !trackerConnected()) return;
  task.tracker_error = TRACKER_UNVERIFIED;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** POST /v1/simple/tasks/{task_id}/tracker-push (task_push.retry): whoever changes the task
 * directly (service.can_decide on its item) pushes it again and reads it back. */
export function retryTask(db: SimpleDb, id: string, me: { id: string; role: Role }): Response {
  const t = db.targets?.[id];
  if (!t || t.kind !== 'item_task') return reply(404, { detail: 'No such task' });
  const key = Object.keys(db.ids).find((k) => db.ids[k] === t.item_id);
  const s = key ? db.items.find((x) => x.key === key) : undefined;
  if (s ? !canDecideItem(db, s, me) : me.role !== 'owner')
    return reply(403, { detail: 'Only those who change this task directly retry its push' });
  pushTask(t);
  return reply(200, taskOut({ ...(t as Parameters<typeof taskOut>[0]), id }));
}

/** The scenario's linked task, under "alert-export". */
export function seedTrackedTask(db: SimpleDb, itemId: string | undefined): void {
  if (!itemId || !trackerConnected()) return;
  db.targets ??= {};
  db.targets['5e7a0c1e-0000-4000-8000-000000001816'] ??= {
    kind: 'item_task',
    item_id: itemId,
    title: 'Write the setup guide',
    status: 'todo',
    owner_id: null,
    owner_name: null,
    due_date: null,
    at: '2026-11-20T09:00:00Z',
    tracker_ref: 'ENG-12',
    tracker_url: 'https://tracker.example.com/ENG-12',
    tracker_error: null,
  };
}
