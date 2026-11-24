// #1557: npm run test:unit (Vitest, #1583).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  BINARIES,
  GIT_CONFIG,
  TYPESCRIPT_LINK,
  attributesBlock,
  checkMessage,
  hookMessage,
  inSwarmLane,
  missingItems,
  wantedVersions,
  withAttributesBlock,
  type SetupState,
} from './agentSetup.ts';

function ready(): SetupState {
  return {
    present: new Set([...Object.keys(BINARIES), TYPESCRIPT_LINK]),
    versions: wantedVersions(),
    gitConfig: Object.fromEntries(GIT_CONFIG),
    attributes: attributesBlock(),
  };
}

test("the owner's pinned versions, exactly", () => {
  assert.deepEqual(wantedVersions(), {
    pyright: '1.1.414',
    'typescript-language-server': '6.0.3',
    coderabbit: '0.9.2',
  });
});

test('nothing missing: the hook prints nothing', () => {
  assert.deepEqual(missingItems(ready()), []);
  assert.equal(checkMessage([]), null);
});

test('a fresh clone: the hook asks for make agent-setup once', () => {
  const missing = missingItems({
    present: new Set(),
    versions: null,
    gitConfig: {},
    attributes: '',
  });
  assert.ok(missing.includes('pyright 1.1.414'));
  assert.ok(missing.includes('coderabbit 0.9.2'));
  assert.ok(missing.includes('git config merge.stat'));
  assert.ok(missing.includes('generated-file diff attributes'));
  const line = checkMessage(missing)!;
  assert.match(line, /make agent-setup/);
  assert.equal(line.split('\n').length, 1);
});

test('an older pinned version, a deleted binary or a dangling typescript link counts as missing', () => {
  const state = ready();
  state.versions = { ...wantedVersions(), pyright: '1.1.400' };
  assert.deepEqual(missingItems(state), ['pyright 1.1.414']);
  const gone = ready();
  gone.present.delete('bin/coderabbit');
  gone.present.delete(TYPESCRIPT_LINK);
  assert.deepEqual(missingItems(gone), ['coderabbit', 'typescript link']);
});

test("git config: merge.stat off and the generated files' diff driver", () => {
  const state = ready();
  state.gitConfig = { ...state.gitConfig, 'merge.stat': 'true' };
  assert.deepEqual(missingItems(state), ['git config merge.stat']);
  assert.match(attributesBlock(), /^web\/lib\/api\/openapi\.json diff=agent-generated$/m);
  assert.match(attributesBlock(), /^web\/lib\/api\/schema\.d\.ts diff=agent-generated$/m);
});

test('the attributes block is added once and replaced, keeping other lines', () => {
  const once = withAttributesBlock('*.png binary');
  assert.equal(withAttributesBlock(once), once);
  assert.ok(once.startsWith('*.png binary\n'));
  const stale = once.replace('diff=agent-generated', 'diff=old');
  assert.equal(withAttributesBlock(stale), once);
});

test('#1653: SWARM_TASK_ID marks a SwarmCloud lane; blank or absent does not', () => {
  assert.equal(inSwarmLane({ SWARM_TASK_ID: 'task-example-1' }), true);
  assert.equal(inSwarmLane({ SWARM_TASK_ID: ' ' }), false);
  assert.equal(inSwarmLane({}), false);
});

test('#1653: the hook is silent in a lane and unchanged outside one', () => {
  const fresh: SetupState = { present: new Set(), versions: null, gitConfig: {}, attributes: '' };
  assert.equal(hookMessage(fresh, true), null);
  assert.equal(hookMessage(fresh, false), checkMessage(missingItems(fresh)));
  assert.match(hookMessage(fresh, false)!, /make agent-setup/);
  assert.equal(hookMessage(ready(), false), null);
});

test('#1653: the SessionStart hook command prints nothing in a lane', () => {
  const script = fileURLToPath(new URL('../scripts/agent-setup.ts', import.meta.url));
  const out = execFileSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--check'],
    { encoding: 'utf8', env: { ...process.env, SWARM_TASK_ID: 'task-example-1' } },
  );
  assert.equal(out, '');
});
