#!/usr/bin/env node

// The Docker build intentionally excludes .git, so Fly cannot discover the
// source revision itself. Always deploy through this command to bake release
// provenance into the image that serves customers.
const { execFileSync } = require('child_process');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const commit = git(['rev-parse', '--verify', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch === 'HEAD') {
  throw new Error('Refusing to deploy from a detached HEAD: check out the release branch first.');
}

const metadataArgs = [
  '--build-arg', `OXY_COMMIT_SHA=${commit}`,
  '--build-arg', `OXY_GIT_BRANCH=${branch}`,
  '--build-arg', `OXY_BUILD_TIME=${new Date().toISOString()}`
];

execFileSync('fly', ['deploy', ...metadataArgs, ...process.argv.slice(2)], {
  stdio: 'inherit'
});
