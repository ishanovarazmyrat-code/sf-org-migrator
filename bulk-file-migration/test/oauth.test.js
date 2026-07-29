const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// oauth.js resolves its AUTH_DIR from process.cwd() at require time (like
// git's .git/), so we chdir into a throwaway directory *before* requiring
// it. node --test runs each test file in its own process, so this chdir
// doesn't leak into other test files.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-org-migrator-oauth-test-'));
const originalCwd = process.cwd();
process.chdir(workDir);
const oauth = require('../lib/oauth');
process.chdir(originalCwd);

test('loadAuth() returns null when nothing has been saved for a prefix', () => {
  assert.equal(oauth.loadAuth('NOPE'), null);
});

test('saveAuth() then loadAuth() round-trips', () => {
  const data = { instanceUrl: 'https://example.my.salesforce.com', clientId: 'abc', refreshToken: 'rt-123' };
  oauth.saveAuth('SOURCE', data);
  assert.deepEqual(oauth.loadAuth('SOURCE'), data);
});

test('saveAuth() writes the token file with mode 600 (owner read/write only)', () => {
  oauth.saveAuth('TARGET', { refreshToken: 'rt-456' });
  const stat = fs.statSync(path.join(oauth.AUTH_DIR, 'TARGET.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('saveAuth() creates the .auth directory with mode 700', () => {
  const stat = fs.statSync(oauth.AUTH_DIR);
  assert.equal(stat.mode & 0o777, 0o700);
});

test('refresh() rejects with a clear error when no OAuth has been stored for the prefix', async () => {
  await assert.rejects(() => oauth.refresh('NEVER_LOGGED_IN'), /No stored OAuth for NEVER_LOGGED_IN/);
});

test('refresh() de-duplicates concurrent calls for the same prefix into one in-flight attempt', async () => {
  // Two concurrent calls before the first settles must share the exact same
  // promise, so a mid-flight refresh-token rotation can never be raced by a
  // second caller reading the stale token (the real bug fixed in 1.3.0).
  const a = oauth.refresh('NEVER_LOGGED_IN_2');
  const b = oauth.refresh('NEVER_LOGGED_IN_2');
  assert.equal(a, b);
  await assert.rejects(() => a);
});
