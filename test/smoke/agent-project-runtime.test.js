const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const runtime = require('../../api/services/agent-project-runtime');

async function git(args, cwd) {
  return execFileAsync('git', args, { cwd });
}

test('project runtime provisions a task-isolated clone and exposes bounded project work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oxy-project-runtime-'));
  const source = path.join(root, 'source');
  const dataRoot = path.join(root, 'data');
  const previous = {
    projects: process.env.OXY_AGENT_PROJECTS_JSON,
    dataRoot: process.env.OXY_AGENT_PROJECT_DATA_ROOT,
    checks: process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED,
    publish: process.env.OXY_AGENT_PROJECT_PUBLISH_ENABLED
  };

  try {
    await fs.mkdir(source, { recursive: true });
    await git(['init', '-q'], source);
    await git(['config', 'user.email', 'test@oxy.local'], source);
    await git(['config', 'user.name', 'Oxy Test'], source);
    await fs.writeFile(path.join(source, 'README.md'), '# Milgrain\n', 'utf8');
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'runtime-test-project',
      scripts: { test: 'node -e "process.stdout.write(\'ok\')"' }
    }), 'utf8');
    await git(['add', '.'], source);
    await git(['commit', '-qm', 'initial'], source);

    process.env.OXY_AGENT_PROJECTS_JSON = JSON.stringify({
      milgrain: { source, displayName: 'Milgrain' }
    });
    process.env.OXY_AGENT_PROJECT_DATA_ROOT = dataRoot;
    process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED = '1';
    delete process.env.OXY_AGENT_PROJECT_PUBLISH_ENABLED;

    const status = await runtime.gitStatus('user-1', 'task-123', 'milgrain');
    assert.equal(status.projectName, 'Milgrain');
    assert.match(status.branch, /^oxy\/task-/);
    assert.equal(status.dirty, false);

    const file = await runtime.writeProjectFile(
      'user-1',
      'task-123',
      'milgrain',
      'notes/decision.md',
      'Use account credit for referral rewards.\n'
    );
    assert.equal(file.path, 'notes/decision.md');
    assert.equal(file.projectRef, 'milgrain');

    const diff = await runtime.gitDiff('user-1', 'task-123', 'milgrain');
    assert.match(diff.diff, /notes\/decision\.md/);
    assert.match(diff.diff, /account credit/);

    const check = await runtime.runProjectCheck('user-1', 'task-123', 'milgrain', 'test');
    assert.equal(check.success, true);
    assert.match(check.output, /ok/);

    const commit = await runtime.commitProjectChanges(
      'user-1',
      'task-123',
      'milgrain',
      'Add referral credit decision'
    );
    assert.match(commit.commit, /^[0-9a-f]{40}$/);
    assert.match(commit.branch, /^oxy\/task-/);
    assert.equal((await runtime.gitDiff('user-1', 'task-123', 'milgrain')).diff, '');

    await runtime.writeProjectFile('user-1', 'task-123', 'milgrain', 'notes/temporary.md', 'discard me');
    const rollback = await runtime.rollbackProjectChanges('user-1', 'task-123', 'milgrain');
    assert.match(rollback.text, /Rolled back/);
    assert.equal((await runtime.gitDiff('user-1', 'task-123', 'milgrain')).diff, '');

    await assert.rejects(
      runtime.writeProjectFile('user-1', 'task-123', 'milgrain', '../outside.md', 'nope'),
      /Invalid project path/
    );
    await assert.rejects(
      runtime.gitStatus('user-1', 'task-123', 'unknown'),
      /not configured/
    );
    await assert.rejects(
      runtime.publishProjectBranch('user-1', 'task-123', 'milgrain'),
      /synchronization is disabled/
    );
  } finally {
    if (previous.projects === undefined) delete process.env.OXY_AGENT_PROJECTS_JSON;
    else process.env.OXY_AGENT_PROJECTS_JSON = previous.projects;
    if (previous.dataRoot === undefined) delete process.env.OXY_AGENT_PROJECT_DATA_ROOT;
    else process.env.OXY_AGENT_PROJECT_DATA_ROOT = previous.dataRoot;
    if (previous.checks === undefined) delete process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED;
    else process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED = previous.checks;
    if (previous.publish === undefined) delete process.env.OXY_AGENT_PROJECT_PUBLISH_ENABLED;
    else process.env.OXY_AGENT_PROJECT_PUBLISH_ENABLED = previous.publish;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A real suite prints far more than the bounded output we store — this repo's own `npm test`
// emits ~72KB. Reading the child's exit status through a 32KB buffer turned every verbose but
// PASSING check into a reported failure, which is the one answer a person must be able to trust.
test('a passing project check stays successful when its output exceeds the stored bound', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oxy-project-runtime-verbose-'));
  const source = path.join(root, 'source');
  const dataRoot = path.join(root, 'data');
  const previous = {
    projects: process.env.OXY_AGENT_PROJECTS_JSON,
    dataRoot: process.env.OXY_AGENT_PROJECT_DATA_ROOT,
    checks: process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED
  };

  try {
    await fs.mkdir(source, { recursive: true });
    await git(['init', '-q'], source);
    await git(['config', 'user.email', 'test@oxy.local'], source);
    await git(['config', 'user.name', 'Oxy Test'], source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'verbose-test-project',
      scripts: {
        // Passes, but prints ~200KB — well past the 32KB stored-output bound.
        test: 'node -e "process.stdout.write(\'verbose-line\\n\'.repeat(15000)); process.stdout.write(\'ALL PASSED\')"'
      }
    }), 'utf8');
    await git(['add', '.'], source);
    await git(['commit', '-qm', 'initial'], source);

    process.env.OXY_AGENT_PROJECTS_JSON = JSON.stringify({
      verbose: { source, displayName: 'Verbose' }
    });
    process.env.OXY_AGENT_PROJECT_DATA_ROOT = dataRoot;
    process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED = '1';

    const check = await runtime.runProjectCheck('user-1', 'task-verbose', 'verbose', 'test');
    assert.equal(check.success, true, 'a passing suite must not be reported as failed');
    assert.equal(check.exitCode, 0);
    assert.equal(check.timedOut, false, 'output volume is not a timeout');
    assert.ok(
      check.output.length <= runtime.MAX_OUTPUT_BYTES,
      'stored output stays bounded'
    );

    // A genuinely failing check must still read as a failure.
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'verbose-test-project',
      scripts: { test: 'node -e "process.stdout.write(\'nope\'.repeat(20000)); process.exit(3)"' }
    }), 'utf8');
    await git(['add', '.'], source);
    await git(['commit', '-qm', 'fail'], source);

    const failing = await runtime.runProjectCheck('user-2', 'task-verbose-fail', 'verbose', 'test');
    assert.equal(failing.success, false);
    assert.equal(failing.exitCode, 3);
  } finally {
    if (previous.projects === undefined) delete process.env.OXY_AGENT_PROJECTS_JSON;
    else process.env.OXY_AGENT_PROJECTS_JSON = previous.projects;
    if (previous.dataRoot === undefined) delete process.env.OXY_AGENT_PROJECT_DATA_ROOT;
    else process.env.OXY_AGENT_PROJECT_DATA_ROOT = previous.dataRoot;
    if (previous.checks === undefined) delete process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED;
    else process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED = previous.checks;
    await fs.rm(root, { recursive: true, force: true });
  }
});
