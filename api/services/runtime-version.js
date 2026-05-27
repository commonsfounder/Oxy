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

const gitCommit =
  process.env.K_REVISION ||
  process.env.OXY_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  safeExec('git rev-parse --short=12 HEAD') ||
  'unknown';

const gitBranch =
  process.env.OXY_GIT_BRANCH ||
  process.env.GITHUB_REF_NAME ||
  safeExec('git rev-parse --abbrev-ref HEAD') ||
  'unknown';

const buildTime = process.env.OXY_BUILD_TIME || new Date().toISOString();

function getRuntimeVersion() {
  return {
    app: 'oxy',
    packageVersion: pkg.version || '0.0.0',
    gitCommit,
    gitBranch,
    buildTime,
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    region: process.env.K_REGION || process.env.GOOGLE_CLOUD_REGION || ''
  };
}

module.exports = { getRuntimeVersion };
