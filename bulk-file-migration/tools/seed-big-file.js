/**
 * Test helper: uploads a local file into the SOURCE org as a ContentVersion
 * linked to the first Account, so the migration pipeline has a big file to
 * chew on. Usage (from the bulk-file-migration dir, so .env is picked up):
 *
 *   node tools/seed-big-file.js /path/to/file.bin
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sf = require('../lib/sf');

(async () => {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Usage: node tools/seed-big-file.js <file>');
  const size = fs.statSync(filePath).size;
  const name = path.basename(filePath);

  const conn = await sf.connect('SOURCE');
  const acc = (await conn.query('SELECT Id, Name FROM Account ORDER BY Name LIMIT 1')).records[0];
  if (!acc) throw new Error('No Account found in source org.');

  console.log(`Uploading ${name} (${(size / 1048576).toFixed(1)}MB) to source org, linked to "${acc.Name}" (${acc.Id})...`);
  const started = Date.now();
  const res = await sf.uploadVersionMultipart(
    conn,
    { Title: name.replace(/\.[^.]+$/, ''), PathOnClient: name, FirstPublishLocationId: acc.Id },
    filePath,
    size
  );
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Done in ${secs}s -> ContentVersion ${res.id}`);
})().catch((e) => {
  console.error('Seed failed:', e.message || e);
  process.exit(1);
});
