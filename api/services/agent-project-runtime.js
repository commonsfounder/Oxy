const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
// What we STORE is bounded (MAX_OUTPUT_BYTES); what we CAPTURE must not be, or the child's
// exit status becomes unreadable. A real `npm test` prints far more than 32KB — this repo's
// own suite emits ~72KB — and a `git diff` easily does too. Sizing the pipe to the stored
// bound made Node kill the child on overflow, which read back as "the check failed" and
// "could not inspect changes" for perfectly healthy projects.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_FILES = 100;
const MAX_PATH_LENGTH = 180;
const PROJECT_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9-]{1,120}$/;

const CHECKS = Object.freeze({
  test: { command: 'npm', args: ['test'] },
  release: { command: 'npm', args: ['run', 'release:check'] }
});

function cleanText(value, fallback = '', maxLength = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeProjectRef(value) {
  const ref = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!ref || !PROJECT_REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new Error('A configured project reference is required.');
  }
  return ref;
}

function normalizeTaskId(value) {
  const taskId = String(value || '').trim();
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) throw new Error('A durable task is required for project work.');
  return taskId;
}

function normalizeRelativePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.length > MAX_PATH_LENGTH || raw.startsWith('/') || raw.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid project path');
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('Project metadata is not writable');
  }
  return normalized.replace(/^\.\/+/, '');
}

function validateContent(content) {
  if (typeof content !== 'string') throw new Error('Project content must be text');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Project file is too large');
  return content;
}

function parseProjectCatalog() {
  const raw = String(process.env.OXY_AGENT_PROJECTS_JSON || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    throw new Error('OXY_AGENT_PROJECTS_JSON is not valid JSON');
  }
}

function configuredProject(projectRef) {
  const ref = normalizeProjectRef(projectRef);
  const catalog = parseProjectCatalog();
  const config = catalog[ref];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Project "${ref}" is not configured for Adam.`);
  }
  const source = String(config.source || '').trim();
  if (!source) throw new Error(`Project "${ref}" has no configured source.`);
  if (!path.isAbsolute(source) && !/^https:\/\//i.test(source)) {
    throw new Error(`Project "${ref}" has an invalid source.`);
  }
  return {
    ref,
    source,
    defaultBranch: cleanText(config.defaultBranch, 'main', 120),
    displayName: cleanText(config.displayName, ref, 180),
    publish: config.publish === true
  };
}

function runtimeDataRoot() {
  const configured = String(process.env.OXY_AGENT_PROJECT_DATA_ROOT || '').trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('The isolated project runtime is not configured.');
  }
  return path.resolve(configured);
}

function userDirectory(userId) {
  return crypto.createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 24);
}

function taskDirectory(taskId) {
  return crypto.createHash('sha256').update(normalizeTaskId(taskId)).digest('hex').slice(0, 24);
}

function projectDirectory(userId, taskId, projectRef) {
  const ref = normalizeProjectRef(projectRef);
  return path.join(runtimeDataRoot(), userDirectory(userId), taskDirectory(taskId), ref.replace(/\//g, '__'));
}

function childEnvironment() {
  const configuredHome = String(process.env.OXY_AGENT_RUNTIME_HOME || '').trim();
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: configuredHome && path.isAbsolute(configuredHome) ? configuredHome : path.join(os.tmpdir(), 'oxy-agent-home'),
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    NPM_CONFIG_USERCONFIG: path.join(os.tmpdir(), 'oxy-agent-user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(os.tmpdir(), 'oxy-agent-global.npmrc'),
    npm_config_cache: path.join(os.tmpdir(), 'oxy-agent-npm-cache')
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureNoSymlinkPath(root, relativePath, { createParents = false } = {}) {
  const parts = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!isInside(root, current)) throw new Error('Invalid project path');
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Project symlinks are not permitted for this action');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (createParents) {
        await fs.mkdir(current, { recursive: false });
      } else {
        break;
      }
    }
  }
}

function outputExceededCapture(error) {
  return String(error?.code || '') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

async function run(command, args, cwd, timeout = 30_000) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      shell: false,
      timeout,
      maxBuffer: MAX_CAPTURE_BYTES,
      env: childEnvironment()
    });
    return {
      code: 0,
      stdout: String(result.stdout || '').slice(0, MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(0, MAX_OUTPUT_BYTES)
    };
  } catch (error) {
    // Overflowing even the capture bound leaves the exit status genuinely unknown. Say so
    // rather than reporting a number we did not observe — a wrong "passed" is worse than
    // an honest "could not read the result".
    const exceeded = outputExceededCapture(error);
    return {
      code: exceeded ? null : (Number.isInteger(error.code) ? error.code : (error.killed ? 124 : 1)),
      stdout: String(error.stdout || '').slice(0, MAX_OUTPUT_BYTES),
      stderr: String(error.stderr || error.message || '').slice(0, MAX_OUTPUT_BYTES),
      timedOut: !exceeded && (error.killed === true || error.signal === 'SIGTERM'),
      outputExceeded: exceeded
    };
  }
}

async function cloneProject(config, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const result = await run('git', ['clone', '--depth=1', config.source, target], path.dirname(target), 120_000);
  if (result.code !== 0) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not prepare ${config.displayName}: ${cleanText(result.stderr, 'git clone failed')}`);
  }
  const branch = `oxy/task-${crypto.createHash('sha256').update(target).digest('hex').slice(0, 12)}`;
  const switched = await run('git', ['switch', '--create', branch], target, 30_000);
  if (switched.code !== 0) {
    throw new Error(`Could not isolate ${config.displayName}: ${cleanText(switched.stderr, 'git branch creation failed')}`);
  }
}

async function ensureProjectWorkspace(userId, taskId, projectRef) {
  if (!userId) throw new Error('Project work requires a user');
  const task = normalizeTaskId(taskId);
  const config = configuredProject(projectRef);
  const root = projectDirectory(userId, task, config.ref);
  const marker = path.join(root, '.git');
  try {
    const stat = await fs.stat(marker);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Project metadata is unavailable');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await cloneProject(config, root);
  }
  const resolvedRoot = await fs.realpath(root);
  const resolvedDataRoot = await fs.realpath(runtimeDataRoot()).catch(() => runtimeDataRoot());
  if (!isInside(resolvedDataRoot, resolvedRoot)) throw new Error('Project workspace escaped its isolated runtime root');
  return { ...config, taskId: task, root: resolvedRoot };
}

async function gitStatus(userId, taskId, projectRef) {
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  const result = await run('git', ['status', '--short', '--branch'], workspace.root);
  if (result.code !== 0) throw new Error(`Could not inspect ${workspace.displayName}: ${cleanText(result.stderr, 'git status failed')}`);
  const lines = result.stdout.split('\n').map(line => line.trimEnd()).filter(Boolean);
  const branchLine = lines.shift() || '';
  const files = lines.slice(0, MAX_STATUS_FILES).map(line => cleanText(line, '', 260));
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    branch: branchLine.replace(/^##\s*/, '').slice(0, 180),
    dirty: files.length > 0,
    files,
    truncated: lines.length > MAX_STATUS_FILES
  };
}

async function gitDiff(userId, taskId, projectRef) {
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  const result = await run('git', ['diff', '--no-ext-diff', '--unified=3'], workspace.root);
  if (result.code !== 0) throw new Error(`Could not inspect changes in ${workspace.displayName}: ${cleanText(result.stderr, 'git diff failed')}`);
  const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], workspace.root);
  if (untracked.code !== 0) throw new Error(`Could not inspect new files in ${workspace.displayName}: ${cleanText(untracked.stderr, 'git status failed')}`);
  let diff = result.stdout;
  for (const rawPath of untracked.stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, MAX_STATUS_FILES)) {
    let relativePath;
    try {
      relativePath = normalizeRelativePath(rawPath);
      await ensureNoSymlinkPath(workspace.root, relativePath);
      const content = await fs.readFile(path.resolve(workspace.root, relativePath), 'utf8');
      const bounded = content.slice(0, Math.max(0, MAX_OUTPUT_BYTES - diff.length));
      const lines = bounded.split('\n').map(line => `+${line}`).join('\n');
      const header = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n`;
      if (diff.length < MAX_OUTPUT_BYTES) diff += `${diff ? '\n' : ''}${header}${lines}`.slice(0, MAX_OUTPUT_BYTES - diff.length);
    } catch {
      // A file can disappear while a task is running. Git status remains the source of
      // truth; omit that transient file rather than turning the whole diff into an error.
    }
    if (diff.length >= MAX_OUTPUT_BYTES) break;
  }
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    diff,
    truncated: diff.length >= MAX_OUTPUT_BYTES
  };
}

async function writeProjectFile(userId, taskId, projectRef, filePath, content) {
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  const relativePath = normalizeRelativePath(filePath);
  const cleanContent = validateContent(content);
  const parent = path.dirname(relativePath);
  await ensureNoSymlinkPath(workspace.root, parent === '.' ? '' : parent, { createParents: true });
  const target = path.resolve(workspace.root, relativePath);
  if (!isInside(workspace.root, target)) throw new Error('Invalid project path');
  await ensureNoSymlinkPath(workspace.root, relativePath);
  await fs.writeFile(target, cleanContent, { encoding: 'utf8' });
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    path: relativePath,
    bytes: Buffer.byteLength(cleanContent, 'utf8')
  };
}

async function runProjectCheck(userId, taskId, projectRef, check = 'test') {
  if (process.env.OXY_AGENT_PROJECT_CHECKS_ENABLED !== '1') {
    throw new Error('Project checks are disabled for this runtime.');
  }
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  const selected = CHECKS[String(check || 'test').trim().toLowerCase()];
  if (!selected) throw new Error('Project check must be test or release');
  const result = await run(selected.command, selected.args, workspace.root, 180_000);
  if (result.outputExceeded) {
    throw new Error(`${workspace.displayName} produced too much output to read its result.`);
  }
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    check: String(check || 'test').trim().toLowerCase(),
    success: result.code === 0,
    exitCode: result.code,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, MAX_OUTPUT_BYTES),
    timedOut: result.timedOut === true
  };
}

function normalizeCommitMessage(value) {
  const message = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!message || message.length > 180) throw new Error('A concise changeset message is required.');
  return message;
}

async function currentBranch(root) {
  const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (result.code !== 0) throw new Error(`Could not identify the project branch: ${cleanText(result.stderr, 'git branch lookup failed')}`);
  const branch = result.stdout.trim();
  if (!branch || branch === 'HEAD' || branch === 'main' || branch === 'master') {
    throw new Error('Project synchronization is only allowed from an isolated task branch.');
  }
  return branch.slice(0, 180);
}

async function commitProjectChanges(userId, taskId, projectRef, message) {
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  const commitMessage = normalizeCommitMessage(message);
  const before = await run('git', ['status', '--porcelain'], workspace.root);
  if (before.code !== 0) throw new Error(`Could not inspect ${workspace.displayName}: ${cleanText(before.stderr, 'git status failed')}`);
  if (!before.stdout.trim()) throw new Error(`${workspace.displayName} has no changes to save.`);

  const staged = await run('git', ['add', '--all', '--', '.'], workspace.root);
  if (staged.code !== 0) throw new Error(`Could not stage ${workspace.displayName}: ${cleanText(staged.stderr, 'git add failed')}`);
  const committed = await run('git', [
    '-c', 'user.name=Adam',
    '-c', 'user.email=adam@oxy.local',
    '-c', 'core.hooksPath=/dev/null',
    'commit', '--message', commitMessage
  ], workspace.root, 60_000);
  if (committed.code !== 0) throw new Error(`Could not save the ${workspace.displayName} changeset: ${cleanText(committed.stderr || committed.stdout, 'git commit failed')}`);
  const hash = await run('git', ['rev-parse', 'HEAD'], workspace.root);
  if (hash.code !== 0) throw new Error('The changeset was saved but its identifier could not be read.');
  const branch = await currentBranch(workspace.root);
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    branch,
    commit: hash.stdout.trim().slice(0, 40),
    message: commitMessage,
    text: `Saved a changeset for ${workspace.displayName}: ${commitMessage}.`
  };
}

async function rollbackProjectChanges(userId, taskId, projectRef) {
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  await currentBranch(workspace.root);
  const reset = await run('git', ['reset', '--hard', 'HEAD'], workspace.root, 60_000);
  if (reset.code !== 0) throw new Error(`Could not roll back ${workspace.displayName}: ${cleanText(reset.stderr, 'git reset failed')}`);
  const clean = await run('git', ['clean', '-fd', '--', '.'], workspace.root, 60_000);
  if (clean.code !== 0) throw new Error(`Could not remove uncommitted files from ${workspace.displayName}: ${cleanText(clean.stderr, 'git clean failed')}`);
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    branch: await currentBranch(workspace.root),
    text: `Rolled back uncommitted changes in ${workspace.displayName}.`
  };
}

async function publishProjectBranch(userId, taskId, projectRef) {
  if (process.env.OXY_AGENT_PROJECT_PUBLISH_ENABLED !== '1') {
    throw new Error('Project synchronization is disabled for this runtime.');
  }
  const workspace = await ensureProjectWorkspace(userId, taskId, projectRef);
  if (!workspace.publish) throw new Error(`Project "${workspace.ref}" is not enabled for synchronization.`);
  const branch = await currentBranch(workspace.root);
  const clean = await run('git', ['status', '--porcelain'], workspace.root);
  if (clean.code !== 0) throw new Error(`Could not inspect ${workspace.displayName}: ${cleanText(clean.stderr, 'git status failed')}`);
  if (clean.stdout.trim()) throw new Error(`Save the ${workspace.displayName} changeset before synchronizing it.`);
  const pushed = await run('git', ['push', '--set-upstream', 'origin', branch], workspace.root, 120_000);
  if (pushed.code !== 0) throw new Error(`Could not synchronize ${workspace.displayName}: ${cleanText(pushed.stderr || pushed.stdout, 'git push failed')}`);
  return {
    projectRef: workspace.ref,
    projectName: workspace.displayName,
    branch,
    published: true,
    text: `Synchronized the ${workspace.displayName} branch ${branch}.`
  };
}

module.exports = {
  CHECKS,
  MAX_FILE_BYTES,
  MAX_OUTPUT_BYTES,
  normalizeProjectRef,
  normalizeRelativePath,
  configuredProject,
  projectDirectory,
  ensureProjectWorkspace,
  gitStatus,
  gitDiff,
  writeProjectFile,
  runProjectCheck,
  normalizeCommitMessage,
  commitProjectChanges,
  rollbackProjectChanges,
  publishProjectBranch
};
