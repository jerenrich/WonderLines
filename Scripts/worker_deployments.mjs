import {execFileSync} from 'node:child_process';
import {appendFileSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, posix, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// This order also preserves monitoring-before-producers and API-before-labs.
export const workers = {
  monitoring: 'monitoring',
  api: 'coloring-sheets-api',
  moderation: 'moderation-lab',
  comparison: 'generation-lab',
  log_retention: 'log-retention',
};

const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const deploymentConfig = /^(?:wrangler\.(?:jsonc?|toml)|package(?:-lock)?\.json)$/;

export function deploymentInputs(root) {
  const inputs = {};
  const visit = (file, files) => {
    if (files.has(file)) return;
    files.add(file);
    if (!/\.[cm]?[jt]s$/.test(file)) return;
    const source = readFileSync(join(root, file), 'utf8');
    // Follow static imports, re-exports and literal dynamic imports, including
    // JSON imports. Bare package imports are covered by package/lockfile inputs.
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file), match[1]));
      if (dependency.startsWith('../')) throw new Error(`Import outside repository: ${file}`);
      visit(dependency, files);
    }
  };
  const walk = (directory, files) => {
    for (const entry of readdirSync(join(root, directory), {withFileTypes: true})) {
      const file = posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, files);
      else visit(file, files);
    }
  };
  for (const [key, directory] of Object.entries(workers)) {
    const base = `workers/${directory}`;
    const files = inputs[key] = new Set();
    for (const entry of readdirSync(join(root, base), {withFileTypes: true})) {
      if (entry.isDirectory() && ['src', 'public'].includes(entry.name)) walk(`${base}/${entry.name}`, files);
      else if (deploymentConfig.test(entry.name)) files.add(`${base}/${entry.name}`);
    }
  }
  return inputs;
}

export function planDeployments({root, base, event = 'push', target = 'all', retentionReady = false}) {
  if (event === 'workflow_dispatch' && target !== 'all' && !Object.hasOwn(workers, target)) {
    throw new Error(`Unknown Worker selection: ${target}`);
  }
  let changedFiles = [], reason = 'Pull requests run checks only.';
  let selected = [];
  if (event === 'workflow_dispatch') {
    selected = target === 'all' ? Object.keys(workers) : [target];
    reason = `Manual deployment: ${target}.`;
  } else if (event === 'push') {
    // A successful run may have checked out a newer main than its event SHA.
    // Using its event SHA is conservative: it can repeat a deployment, but cannot
    // miss changes covered by failed runs or replaced pending runs.
    if (!base || !/^[a-f0-9]{40}$/.test(base) || (() => {
      try { git(root, 'merge-base', '--is-ancestor', base, 'HEAD'); return false; }
      catch { return true; }
    })()) {
      selected = Object.keys(workers);
      reason = 'No usable successful-push baseline; deploy all Workers.';
    } else {
      // Include reverted changes too: an intervening failed run might already
      // have deployed one Worker before failing on the next one.
      changedFiles = [...new Set(git(root, 'log', '--first-parent', '--diff-merges=first-parent',
        '--format=', '--name-only', '--no-renames', '-z', `${base}..HEAD`).split('\0').filter(Boolean))];
      const inputs = deploymentInputs(root);
      selected = Object.keys(workers).filter(key => changedFiles.some(file => {
        const directory = `workers/${workers[key]}/`;
        const ownFile = file.startsWith(directory) ? file.slice(directory.length) : '';
        return inputs[key].has(file) || ownFile.startsWith('src/') || ownFile.startsWith('public/') || deploymentConfig.test(ownFile);
      }));
      reason = `Changes since successful production push ${base}.`;
    }
  }
  const retentionSkipped = selected.includes('log_retention') && !retentionReady;
  if (retentionSkipped) selected = selected.filter(key => key !== 'log_retention');
  return {selected, changedFiles, reason, retentionSkipped};
}

export function writePlan(plan, {output, summary}) {
  if (output) appendFileSync(output, Object.keys(workers).map(key => `${key}=${plan.selected.includes(key)}`).join('\n') + `\nany=${plan.selected.length > 0}\n`);
  const message = [
    '### Worker deployment selection',
    plan.reason,
    plan.selected.length ? `Selected: ${plan.selected.map(key => workers[key]).join(', ')}.` : 'No Workers selected for deployment.',
    ...(plan.retentionSkipped ? ['Log retention skipped: LOG_RETENTION_WORKER_READY is not true.'] : []),
  ].join('\n\n') + '\n';
  if (summary) appendFileSync(summary, message);
  return message;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = planDeployments({root, base: process.env.DEPLOYMENT_BASE,
    event: process.env.GITHUB_EVENT_NAME, target: process.env.DEPLOYMENT_TARGET || 'all',
    retentionReady: process.env.LOG_RETENTION_WORKER_READY === 'true'});
  console.log(writePlan(plan, {output: process.env.GITHUB_OUTPUT, summary: process.env.GITHUB_STEP_SUMMARY}));
}
