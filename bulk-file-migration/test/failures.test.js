const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarize, classify, parseCsv, retryCommands, readableReason } = require('../lib/failures');

function workDirWith(reports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failures-'));
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  for (const [name, body] of Object.entries(reports)) {
    fs.writeFileSync(path.join(dir, 'errors', name), body);
  }
  return dir;
}

const HEADER = 'phase,object,sourceId,targetId,reason\n';
const dml = (code, message) =>
  `"[{""statusCode"":""${code}"",""message"":""${message}"",""fields"":[]}]"`;

test('parseCsv handles the quoted JSON blobs writeReport puts in the reason column', () => {
  const rows = parseCsv(HEADER + `records,Contact,003x,,${dml('DUPLICATES_DETECTED', 'You are creating a duplicate record.')}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].object, 'Contact');
  assert.match(rows[0].reason, /DUPLICATES_DETECTED/);
  assert.match(rows[0].reason, /duplicate record/);
});

test('readableReason pulls the code and sentence out of a DML error blob', () => {
  assert.equal(
    readableReason(JSON.stringify([{ statusCode: 'STRING_TOO_LONG', message: 'Name: data too large', fields: ['Name'] }])),
    'STRING_TOO_LONG (Name): Name: data too large'
  );
});

test('readableReason leaves our own plain-prose reasons alone', () => {
  assert.equal(readableReason('parent not migrated: AccountId -> Account 001x'), 'parent not migrated: AccountId -> Account 001x');
});

test('summarize collapses many rows of one cause into a single group', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `records,Opportunity,006x${i},,parent not migrated: AccountId -> Account 001abcdefghijklmno\n`);
  const dir = workDirWith({ 'records-2026-07-30T10-00-00-000Z.csv': HEADER + rows.join('') });

  const groups = summarize(dir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 50);
  assert.equal(groups[0].samples.length, 3, 'a few examples, not fifty');
  assert.match(groups[0].reason, /<id>/, 'record ids are collapsed so the rows group');
});

test('summarize reads only the newest report per phase — an older run is already fixed', () => {
  const dir = workDirWith({
    'records-2026-07-30T10-00-00-000Z.csv': HEADER + `records,Account,001old,,${dml('DUPLICATES_DETECTED', 'old problem')}\n`,
    'records-2026-07-30T11-00-00-000Z.csv': HEADER + `records,Account,001new,,${dml('STRING_TOO_LONG', 'new problem')}\n`,
  });

  const groups = summarize(dir);
  assert.equal(groups.length, 1);
  assert.match(groups[0].reason, /new problem/);
});

test('summarize separates what a re-run can fix from what needs the user first', () => {
  const dir = workDirWith({
    'records-2026-07-30T10-00-00-000Z.csv':
      HEADER +
      `records,Case,500x,,parent not migrated: ContactId -> Contact 003abcdefghijklmno\n` +
      `records,Contact,003x,,${dml('DUPLICATES_DETECTED', 'blocked by a Block rule')}\n`,
  });

  const groups = summarize(dir);
  const byObject = Object.fromEntries(groups.map((g) => [g.object, g]));
  assert.equal(byObject.Case.retryable, true, 'a missing parent resolves by running records first');
  assert.equal(byObject.Contact.retryable, false, 'a Block duplicate rule rejects it every time');
});

test('an empty or missing work dir reports nothing rather than throwing', () => {
  assert.deepEqual(summarize(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), []);
});

test('retryCommands orders phases so records exist before links point at them', () => {
  const cmds = retryCommands([{ phase: 'link' }, { phase: 'records' }, { phase: 'upload' }]);
  assert.deepEqual(cmds, ['records', 'upload', 'link']);
});

test('classify treats a network wobble as worth retrying', () => {
  assert.equal(classify('socket hang up').retryable, true);
});

test('a clean re-run supersedes the previous failure report instead of leaving it current', () => {
  const { writeReport } = require('../lib/report');
  const dir = workDirWith({});

  // First run fails...
  writeReport(dir, 'records', [{ phase: 'records', object: 'Contact', sourceId: '003x', reason: 'boom' }]);
  assert.equal(summarize(dir).length, 1);

  // ...the cause is fixed and the phase re-runs clean. Nothing to report, but
  // the report still has to say so, or the old failures look current forever.
  writeReport(dir, 'records', []);
  assert.deepEqual(summarize(dir), []);
});

test('writeReport returns a path only when there was something to report', () => {
  const { writeReport } = require('../lib/report');
  const dir = workDirWith({});
  assert.equal(writeReport(dir, 'link', []), null, 'a clean run stays quiet in the console');
  assert.match(writeReport(dir, 'link', [{ reason: 'x' }]), /link-.*\.csv$/);
});
