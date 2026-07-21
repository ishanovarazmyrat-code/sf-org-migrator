/**
 * Manifest = the single source of truth for the whole run, kept on disk.
 * Every phase reads it, does work, and updates per-item state, so any
 * phase can be killed and re-run without losing progress or duplicating
 * uploads.
 */
const fs = require('fs');
const path = require('path');

function manifestPath(workDir) {
  return path.join(workDir, 'manifest.json');
}

function dataDir(workDir) {
  return path.join(workDir, 'data');
}

function load(workDir) {
  const file = manifestPath(workDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Atomic save: write to a temp file, then rename over the real one. */
function save(workDir, manifest) {
  fs.mkdirSync(workDir, { recursive: true });
  const file = manifestPath(workDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1));
  fs.renameSync(tmp, file);
}

function summarize(manifest) {
  const s = {
    docs: 0,
    versions: { pending: 0, downloaded: 0, uploaded: 0, failed: 0 },
    links: { pending: 0, linked: 0, unmapped: 0, failed: 0 },
    bytesTotal: 0,
    bytesDownloaded: 0,
    bytesUploaded: 0,
  };
  for (const doc of Object.values(manifest.docs)) {
    s.docs++;
    for (const v of doc.versions) {
      s.versions[v.state] = (s.versions[v.state] || 0) + 1;
      s.bytesTotal += v.size || 0;
      if (v.state === 'downloaded' || v.state === 'uploaded') s.bytesDownloaded += v.size || 0;
      if (v.state === 'uploaded') s.bytesUploaded += v.size || 0;
    }
    for (const l of doc.links) {
      s.links[l.state] = (s.links[l.state] || 0) + 1;
    }
  }
  return s;
}

function fmtBytes(n) {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

module.exports = { load, save, summarize, fmtBytes, manifestPath, dataDir };
