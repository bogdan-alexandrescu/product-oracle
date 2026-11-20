// #1560: npm run test:unit (Vitest, #1583).
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { adjudicate, exitCodeFor } from './coderabbitCliReview.ts';

const files = ['web/lib/example.ts', 'api/oracle/example.py'];
const finding = (file: string) =>
  JSON.stringify({ type: 'finding', file, severity: 'minor', comment: 'Example.' });
const done = JSON.stringify({ type: 'complete', status: 'completed' });

test('reviewed: findings and a finished review', () => {
  const v = adjudicate({
    exitCode: 0,
    stdout: [finding(files[0]), done].join('\n'),
    stderr: '',
    diffFiles: files,
  });
  assert.equal(v.state, 'reviewed');
  assert.equal(v.findings, 1);
  assert.equal(exitCodeFor(v.state), 0);
});

test('reviewed: --gate exits 2 on a finished review with findings', () => {
  const v = adjudicate({
    exitCode: 2,
    stdout: [finding(files[0]), done].join('\n'),
    stderr: '',
    diffFiles: files,
  });
  assert.equal(v.state, 'reviewed');
});

test('reviewed-nothing-applicable: finished with no findings', () => {
  const v = adjudicate({ exitCode: 0, stdout: done, stderr: '', diffFiles: files });
  assert.equal(v.state, 'reviewed-nothing-applicable');
  assert.equal(exitCodeFor(v.state), 0);
});

test('did-not-review: an error line with exit 0', () => {
  const error = JSON.stringify({
    type: 'error',
    phase: 'auth',
    status: 'environment_unsupported',
    message: 'Sign in first.',
  });
  const v = adjudicate({ exitCode: 0, stdout: error, stderr: '', diffFiles: files });
  assert.equal(v.state, 'did-not-review');
  assert.equal(exitCodeFor(v.state), 1);
  assert.ok(v.reasons.some((r) => r.includes('environment_unsupported')));
});

test('did-not-review: a plain-text error on stderr with exit 0 and nothing else', () => {
  const v = adjudicate({
    exitCode: 0,
    stdout: '',
    stderr: 'Error: review service unavailable',
    diffFiles: files,
  });
  assert.equal(v.state, 'did-not-review');
});

test('did-not-review: exit 0 with no output at all', () => {
  assert.equal(
    adjudicate({ exitCode: 0, stdout: '', stderr: '', diffFiles: files }).state,
    'did-not-review',
  );
});

test('did-not-review: a non-zero exit with no findings, even if it says done', () => {
  assert.equal(
    adjudicate({ exitCode: 1, stdout: done, stderr: '', diffFiles: files }).state,
    'did-not-review',
  );
});

test('did-not-review: an empty diff', () => {
  assert.equal(
    adjudicate({ exitCode: 0, stdout: done, stderr: '', diffFiles: [] }).state,
    'did-not-review',
  );
});

test('reviewed-incompletely: an error after findings, exit 0', () => {
  const error = JSON.stringify({ type: 'error', phase: 'review', message: 'Stream closed.' });
  const v = adjudicate({
    exitCode: 0,
    stdout: [finding(files[0]), error].join('\n'),
    stderr: '',
    diffFiles: files,
  });
  assert.equal(v.state, 'reviewed-incompletely');
  assert.equal(exitCodeFor(v.state), 1);
});

test('reviewed-incompletely: findings but no finished event', () => {
  const v = adjudicate({ exitCode: 0, stdout: finding(files[0]), stderr: '', diffFiles: files });
  assert.equal(v.state, 'reviewed-incompletely');
});

test('reviewed-incompletely: the finished event lists only part of the diff', () => {
  const partial = JSON.stringify({ type: 'complete', files: [files[0]] });
  const v = adjudicate({ exitCode: 0, stdout: partial, stderr: '', diffFiles: files });
  assert.equal(v.state, 'reviewed-incompletely');
  assert.deepEqual(v.unreviewed, [files[1]]);
});

test('reviewed-incompletely: a file reported as skipped', () => {
  const skip = JSON.stringify({ type: 'skipped', file: files[1], reason: 'too large' });
  const v = adjudicate({
    exitCode: 0,
    stdout: [skip, done].join('\n'),
    stderr: '',
    diffFiles: files,
  });
  assert.equal(v.state, 'reviewed-incompletely');
  assert.deepEqual(v.unreviewed, [files[1]]);
});
