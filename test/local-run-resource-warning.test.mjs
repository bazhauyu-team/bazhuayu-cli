import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalRunResourceWarning } from '../dist/commands/run.js';

test('local run resource warning starts at the fourth projected local run', () => {
  assert.equal(buildLocalRunResourceWarning(2, 1), undefined);

  const warning = buildLocalRunResourceWarning(3, 1);
  assert.equal(warning.code, 'LOCAL_RUN_RESOURCE_WARNING');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.activeLocalRuns, 3);
  assert.equal(warning.requestedLocalRuns, 1);
  assert.equal(warning.projectedLocalRuns, 4);
  assert.match(warning.message, /independent Chrome process/);
  assert.match(warning.message, /memory and CPU/);
});

test('local run resource warning becomes strong at the sixth projected local run', () => {
  const warning = buildLocalRunResourceWarning(5, 1);
  assert.equal(warning.severity, 'strong_warning');
  assert.equal(warning.projectedLocalRuns, 6);
});
