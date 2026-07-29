const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('../lib/manifest');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-org-migrator-test-'));
}

test('load() returns null when no manifest exists yet', () => {
  const dir = tmpDir();
  assert.equal(manifest.load(dir), null);
});

test('save() then load() round-trips, including a fresh workDir that does not exist yet', () => {
  const dir = path.join(tmpDir(), 'nested', 'work');
  const data = { docs: { doc1: { versions: [], links: [] } } };
  manifest.save(dir, data);
  assert.deepEqual(manifest.load(dir), data);
});

test('save() is atomic — no .tmp file left behind after a save', () => {
  const dir = tmpDir();
  manifest.save(dir, { docs: {} });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['manifest.json']);
});

test('summarize() counts docs, per-state version/link tallies, and byte totals', () => {
  const data = {
    docs: {
      d1: {
        versions: [
          { state: 'uploaded', size: 100 },
          { state: 'downloaded', size: 50 },
        ],
        links: [{ state: 'linked' }],
      },
      d2: {
        versions: [{ state: 'failed', size: 30 }],
        links: [{ state: 'pending' }, { state: 'unmapped' }],
      },
    },
  };
  const s = manifest.summarize(data);
  assert.equal(s.docs, 2);
  assert.equal(s.versions.uploaded, 1);
  assert.equal(s.versions.downloaded, 1);
  assert.equal(s.versions.failed, 1);
  assert.equal(s.links.linked, 1);
  assert.equal(s.links.pending, 1);
  assert.equal(s.links.unmapped, 1);
  // bytesTotal counts every version regardless of state.
  assert.equal(s.bytesTotal, 180);
  // bytesDownloaded counts downloaded + uploaded (uploaded implies it was downloaded first).
  assert.equal(s.bytesDownloaded, 150);
  // bytesUploaded only counts uploaded.
  assert.equal(s.bytesUploaded, 100);
});

test('summarize() tolerates a version/doc with no size (treats as 0 bytes)', () => {
  const data = { docs: { d1: { versions: [{ state: 'pending' }], links: [] } } };
  const s = manifest.summarize(data);
  assert.equal(s.bytesTotal, 0);
});

test('fmtBytes() picks the right unit and rounds to 1 decimal above bytes', () => {
  assert.equal(manifest.fmtBytes(0), '0B');
  assert.equal(manifest.fmtBytes(512), '512B');
  assert.equal(manifest.fmtBytes(1024), '1.0KB');
  assert.equal(manifest.fmtBytes(1536), '1.5KB');
  assert.equal(manifest.fmtBytes(1024 * 1024), '1.0MB');
  assert.equal(manifest.fmtBytes(10 * 1024 * 1024 * 1024), '10.0GB');
  assert.equal(manifest.fmtBytes(null), '-');
  assert.equal(manifest.fmtBytes(undefined), '-');
});
