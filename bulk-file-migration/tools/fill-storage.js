/**
 * Test helper: fills an org's File Storage with large ContentVersions, so the
 * migration pipeline has a realistic volume to chew on.
 *
 * Uploads the same local file repeatedly under different titles — each upload
 * is its own ContentDocument, so storage grows by the file size every time.
 *
 *   node tools/fill-storage.js <file> [--target-gb 10] [--prefix SOURCE]
 */
const fs = require('fs');
const path = require('path');
const sf = require('../lib/sf');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

// A 1GB upload can outlive the access token, so this must retry+reauth like
// every other call — otherwise the post-upload check throws and a successful
// upload gets reported as a failure.
async function fileStorage(conn) {
  const l = await sf.withRetry(conn, () => conn.request(`/services/data/v${conn.version}/limits`), {
    label: 'limits',
  });
  const f = l.FileStorageMB;
  return { max: f.Max, used: f.Max - f.Remaining, remaining: f.Remaining };
}

(async () => {
  const filePath = process.argv[2];
  if (!filePath || filePath.startsWith('--')) {
    throw new Error('Usage: node tools/fill-storage.js <file> [--target-gb 10] [--prefix SOURCE]');
  }
  const targetGb = Number(arg('target-gb', 10));
  const prefix = arg('prefix', 'SOURCE');

  const size = fs.statSync(filePath).size;
  const sizeMb = size / 1048576;
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');

  const conn = await sf.connect(prefix);

  const acc = (await conn.query('SELECT Id, Name FROM Account ORDER BY Name LIMIT 1')).records[0];
  if (acc) console.log(`Linking uploads to Account "${acc.Name}" (${acc.Id})`);
  else console.log('No Account found — uploading unlinked (files still count against storage).');

  let st = await fileStorage(conn);
  const targetMb = targetGb * 1024;
  console.log(
    `File Storage: ${st.used}MB used / ${st.max}MB max. Filling to ~${targetMb}MB with ${sizeMb.toFixed(0)}MB uploads.\n`
  );

  let n = 0;
  const stamp = Date.now().toString(36);
  // Salesforce's storage figures lag behind uploads by minutes, so driving the
  // loop off st.used alone overshoots the target. Track what we uploaded here
  // and trust whichever number is higher.
  const startUsed = st.used;
  const uploaded = () => Math.max(st.used, startUsed + n * sizeMb);
  while (uploaded() < targetMb) {
    if (st.remaining < sizeMb) {
      console.log(`Stopping: only ${st.remaining}MB free, need ${sizeMb.toFixed(0)}MB.`);
      break;
    }
    n++;
    const name = `${base}-${stamp}-${String(n).padStart(3, '0')}.bin`;
    const meta = { Title: name.replace(/\.bin$/, ''), PathOnClient: name };
    if (acc) meta.FirstPublishLocationId = acc.Id;

    const t0 = Date.now();
    let res;
    try {
      res = await sf.uploadVersionMultipart(conn, meta, filePath, size);
    } catch (e) {
      console.error(`[${n}] FAILED ${name}: ${(e.message || e).slice(0, 300)}`);
      if (/STORAGE_LIMIT_EXCEEDED|LIMIT_EXCEEDED/i.test(e.message || '')) break;
      st = await fileStorage(conn);
      continue;
    }
    const secs = (Date.now() - t0) / 1000;
    st = await fileStorage(conn);
    console.log(
      `[${n}] ${name} -> ${res.id}  ${secs.toFixed(0)}s ` +
        `(${(sizeMb / secs).toFixed(1)}MB/s)  storage ${st.used}/${st.max}MB`
    );
  }

  console.log(
    `\nDone. ${n} uploads attempted (~${(n * sizeMb).toFixed(0)}MB sent). ` +
      `File Storage reports ${st.used}MB / ${st.max}MB (figures lag by a few minutes).`
  );
})().catch((e) => {
  console.error('Fill failed:', e.message || e);
  process.exit(1);
});
