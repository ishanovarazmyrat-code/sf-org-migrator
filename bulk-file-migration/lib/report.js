/**
 * Failure reports. At scale, "3 failed" scrolling past in the console is
 * useless — you need the list. Each phase that can partially fail writes its
 * failures to work/errors/<phase>-<timestamp>.csv so they can be reviewed and,
 * once the cause is fixed, retried (records upsert is idempotent; files resume
 * from the manifest).
 */
const fs = require('fs');
const path = require('path');

const COLUMNS = ['phase', 'object', 'sourceId', 'targetId', 'reason'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Writes rows to work/errors/<phase>-<ts>.csv and returns the file path — or
 * null when the run was clean, so callers can stay quiet.
 *
 * A clean run still writes a header-only file. Readers take the newest report
 * per phase as the current state, so skipping the write entirely would leave
 * yesterday's failures looking current after you fixed them and re-ran.
 *
 * `rows` are plain objects keyed by any of COLUMNS; missing keys are blank.
 */
function writeReport(workDir, phase, rows) {
  const dir = path.join(workDir, 'errors');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${phase}-${ts}.csv`);
  const lines = [COLUMNS.join(',')];
  for (const r of rows || []) lines.push(COLUMNS.map((c) => csvCell(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return rows && rows.length ? file : null;
}

module.exports = { writeReport, COLUMNS };
