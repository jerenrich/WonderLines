import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deploymentInputs, planDeployments, workers, writePlan} from './worker_deployments.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = deploymentInputs(repository);
const affected = file => Object.keys(workers).filter(key => inputs[key].has(file));
// Exercise the actual application import graph, including transitive JSON and
// shared-code imports. Editing one lab must not restart the app's API.
assert.deepEqual(affected('workers/generation-lab/public/style.css'), ['comparison']);
assert.deepEqual(affected('workers/moderation-lab/public/app.js'), ['moderation']);
assert.deepEqual(affected('workers/monitoring/src/policy.mjs'), ['monitoring']);
assert.deepEqual(affected('workers/coloring-sheets-api/src/account-safety.mjs'), ['api']);
assert.deepEqual(affected('workers/coloring-sheets-api/model-registry.initial.json'), ['api', 'comparison']);
assert.deepEqual(affected('workers/coloring-sheets-api/src/moderation-profiles.mjs'), ['api', 'moderation']);
assert.deepEqual(affected('workers/coloring-sheets-api/src/provider-diagnostics.mjs'), ['api', 'comparison']);
assert.deepEqual(affected('workers/shared/request-body.mjs'), ['api', 'moderation', 'comparison']);
assert.deepEqual(affected('workers/shared/admin-identity.mjs'), ['api', 'comparison']);
for (const file of ['ColoringSheets/ContentView.swift', 'Scripts/test_worker.mjs',
  '.github/workflows/worker.yml', 'Scripts/worker_deployments.mjs',
  'workers/generation-lab/README.md', 'workers/generation-lab/tests/worker.mjs']) {
  assert.deepEqual(affected(file), [], file);
}
assert.deepEqual(affected('workers/generation-lab/package-lock.json'), ['comparison']);
assert.deepEqual(affected('workers/coloring-sheets-api/wrangler.jsonc'), ['api']);

const root = mkdtempSync(join(tmpdir(), 'wonderlines-deployments-'));
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const write = (file, value = '// fixture\n') => {
  mkdirSync(dirname(join(root, file)), {recursive: true});
  writeFileSync(join(root, file), value);
};
const commit = () => { git('add', '.'); git('-c', 'user.name=Deployment test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
const plan = (base, extra = {}) => planDeployments({root, base, retentionReady: true, ...extra});
try {
  git('init', '-q');
  for (const directory of Object.values(workers)) {
    write(`workers/${directory}/src/index.mjs`);
    write(`workers/${directory}/wrangler.jsonc`, '{}');
  }
  write('workers/generation-lab/public/style.css', 'body {}');
  const base = commit();
  assert.deepEqual(plan(base).selected, []);

  for (const file of ['ColoringSheets/ContentView.swift', 'workers/README.md',
    'workers/generation-lab/tests/worker.mjs', 'Scripts/test_worker.mjs', '.github/workflows/worker.yml']) write(file);
  const checksOnly = commit();
  assert.deepEqual(plan(base).selected, [], 'App, documentation, tests and workflow edits do not deploy');

  write('workers/generation-lab/public/style.css', 'body {color: red}');
  const queued = commit();
  assert.deepEqual(plan(checksOnly).selected, ['comparison']);
  write('workers/monitoring/src/index.mjs', '// monitoring change\n');
  commit();
  assert.deepEqual(plan(checksOnly).selected, ['monitoring', 'comparison'], 'A failed or replaced queued run remains in the deployment range');
  assert.deepEqual(plan(queued).selected, ['monitoring'], 'Previously successful changes need not deploy again');

  const beforeRevert = git('rev-parse', 'HEAD');
  write('workers/coloring-sheets-api/src/index.mjs', '// partially deployed change\n');
  commit();
  write('workers/coloring-sheets-api/src/index.mjs');
  commit();
  assert.deepEqual(plan(beforeRevert).selected, ['api'], 'Reverting a partially deployed change still restores the Worker');

  // Renames and removals must invalidate a Worker's asset bundle too.
  const beforeRename = git('rev-parse', 'HEAD');
  renameSync(join(root, 'workers/generation-lab/public/style.css'), join(root, 'workers/generation-lab/public/theme.css'));
  commit();
  assert.deepEqual(plan(beforeRename).selected, ['comparison']);
  const beforeDelete = git('rev-parse', 'HEAD');
  rmSync(join(root, 'workers/generation-lab/public/theme.css'));
  commit();
  assert.deepEqual(plan(beforeDelete).selected, ['comparison']);

  const beforeMerge = git('rev-parse', 'HEAD'), mainBranch = git('branch', '--show-current');
  git('checkout', '-qb', 'worker-side');
  write('workers/coloring-sheets-api/src/index.mjs', '// side change\n');
  commit();
  git('checkout', '-q', mainBranch);
  write('workers/coloring-sheets-api/src/index.mjs', '// main change\n');
  commit();
  assert.throws(() => git('-c', 'user.name=Deployment test', '-c', 'user.email=test@example.invalid', 'merge', '--no-ff', '--no-commit', 'worker-side'));
  write('workers/coloring-sheets-api/src/index.mjs', '// resolved change\n');
  write('workers/moderation-lab/public/merge.css', 'body {}');
  commit();
  assert.deepEqual(plan(beforeMerge).selected, ['api', 'moderation'], 'Changes introduced during merge conflict resolution must deploy too');

  const beforeConfigDelete = git('rev-parse', 'HEAD');
  rmSync(join(root, 'workers/monitoring/wrangler.jsonc'));
  commit();
  assert.deepEqual(plan(beforeConfigDelete).selected, ['monitoring'], 'Deleted configuration must not silently skip deployment');

  assert.deepEqual(plan('', {event: 'pull_request'}).selected, [], 'PRs never deploy, even without history');
  assert.deepEqual(plan('').selected, Object.keys(workers));
  assert.deepEqual(plan('0'.repeat(40)).selected, Object.keys(workers), 'Missing commits conservatively deploy all');
  git('checkout', '-q', '--orphan', 'rewritten-main');
  git('rm', '-qrf', '.');
  write('unrelated.txt');
  commit();
  assert.deepEqual(plan(base).selected, Object.keys(workers), 'Non-ancestor baselines conservatively deploy all');

  assert.deepEqual(plan('', {event: 'workflow_dispatch', target: 'comparison'}).selected, ['comparison']);
  assert.deepEqual(plan('', {event: 'workflow_dispatch', target: 'all'}).selected, Object.keys(workers));
  const gated = plan('', {event: 'workflow_dispatch', target: 'log_retention', retentionReady: false});
  assert.deepEqual(gated.selected, []);
  assert.equal(gated.retentionSkipped, true);
  assert.throws(() => plan('', {event: 'workflow_dispatch', target: 'unknown'}), /Unknown Worker/);

  const output = join(root, 'outputs'), summary = join(root, 'summary');
  writePlan(gated, {output, summary});
  assert.match(readFileSync(output, 'utf8'), /log_retention=false\nany=false\n/);
  assert.match(readFileSync(summary, 'utf8'), /Log retention skipped/);
} finally {
  rmSync(root, {recursive: true, force: true});
}
console.log('PASS: Worker selection follows real shared imports; app/docs/tests skip deployment; cumulative changes, asset removal/renames, PR isolation, history fallback, manual selection and retention bootstrap gate are covered.');
