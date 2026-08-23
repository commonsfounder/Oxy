const childProcess = require('child_process');
const pkg = require('../../package.json');

function safeExec(command) {
  try {
    return childProcess.execSync(command, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).toString().trim();
  } catch {
    return '';
  }
}

// Kept stable for the life of the process when a local/dev run has no explicit
// build timestamp. Production releases must set OXY_BUILD_TIME at image build.
const processStartedAt = new Date().toISOString();

function getRuntimeVersion(env = process.env) {
  const flyApp = env.FLY_APP_NAME || '';
  const gitCommit =
    env.OXY_COMMIT_SHA ||
    env.GITHUB_SHA ||
    safeExec('git rev-parse --short=12 HEAD') ||
    'unknown';
  const gitBranch =
    env.OXY_GIT_BRANCH ||
    env.GITHUB_REF_NAME ||
    safeExec('git rev-parse --abbrev-ref HEAD') ||
    'unknown';
  const buildTime = env.OXY_BUILD_TIME || processStartedAt;

  return {
    app: 'oxy',
    packageVersion: pkg.version || '0.0.0',
    gitCommit,
    gitBranch,
    deployId: gitCommit,
    buildTime,
    nodeVersion: process.version,
    environment: env.NODE_ENV || 'development',
    platform: flyApp ? 'fly' : 'local',
    flyApp,
    region: env.FLY_REGION || ''
  };
}

module.exports = { getRuntimeVersion };
