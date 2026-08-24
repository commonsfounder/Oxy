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

// The live database is not part of the image, so a deploy can happily ship code whose
// declared tables do not exist in production.  That is how account deletion ran broken
// for weeks with a green test suite.  Refuse to deploy until the schema actually matches.
if (process.env.OXY_SKIP_SCHEMA_CHECK === '1') {
  console.warn('WARNING: skipping the live schema check because OXY_SKIP_SCHEMA_CHECK=1.');
} else {
  try {
    execFileSync('node', [require('path').join(__dirname, 'check-live-schema.js')], { stdio: 'inherit' });
  } catch {
    throw new Error('Refusing to deploy: the live database does not match the user-data manifest (see above). Apply the missing migration, or set OXY_SKIP_SCHEMA_CHECK=1 to override deliberately.');
  }
}

const metadataArgs = [
  '--build-arg', `OXY_COMMIT_SHA=${commit}`,
  '--build-arg', `OXY_GIT_BRANCH=${branch}`,
  '--build-arg', `OXY_BUILD_TIME=${new Date().toISOString()}`
];

execFileSync('fly', ['deploy', ...metadataArgs, ...process.argv.slice(2)], {
  stdio: 'inherit'
});
