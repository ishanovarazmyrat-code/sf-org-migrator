#!/usr/bin/env node
/**
 * Org-to-Org Bulk Files Migration (10GB-scale)
 * ---------------------------------------------
 * Phased, resumable migration of Salesforce Files (ContentVersion binaries
 * + ContentDocumentLink relationships) from a source org to a target org.
 *
 * Phases (each is a separate command, all resumable via work/manifest.json):
 *   stats     Read-only sizing queries against the source org - run first,
 *             this decides the strategy (see README).
 *   manifest  Query source ContentVersions + their links, write the manifest.
 *   download  Stream every binary from the source org to work/data/ (no
 *             memory buffering - safe for files up to 2GB).
 *   upload    Multipart-POST every binary into the target org (up to
 *             2GB/file), preserving version order per document.
 *   link      Rebuild ContentDocumentLinks in the target org, resolving
 *             source record Ids -> target record Ids via the Legacy_*_Id__c
 *             external Id fields created by the earlier record migration.
 *   verify    Print progress/state summary from the manifest.
 *   run       manifest (if missing) + download + upload + link.
 *
 * Usage:
 *   node cli.js stats
 *   node cli.js manifest [--limit 10] [--all-versions] [--where "CreatedDate = LAST_N_DAYS:30"]
 *   node cli.js download [--concurrency 3]
 *   node cli.js upload   [--concurrency 3]
 *   node cli.js link
 *   node cli.js verify
 *   node cli.js run      [--limit 10] [...]
 *
 * Environment (.env): SOURCE_LOGIN_URL/USERNAME/PASSWORD/TOKEN and TARGET_*
 * (same variables as the original PoC), plus optional WORK_DIR (default ./work).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sf = require('./lib/sf');
const mf = require('./lib/manifest');

// State lives in the CURRENT working directory (so a globally-installed CLI
// keeps each project's work/, .auth/, config where you run it — like git).
const WORK_DIR = process.env.WORK_DIR || path.join(process.cwd(), 'work');

// Parent-record types whose files we relink, and the external Id field on
// the target org that maps source record Id -> target record Id. Key
// prefixes are resolved at runtime (buildPrefixMap) rather than hardcoded,
// because custom-object key prefixes can differ between orgs.
const LINK_OBJECTS = [
  { object: 'Account', externalIdField: 'Legacy_Account_Id__c' },
  { object: 'Contact', externalIdField: 'Legacy_Contact_Id__c' },
  { object: 'Opportunity', externalIdField: 'Legacy_Opportunity_Id__c' },
  { object: 'Case', externalIdField: 'Legacy_Case_Id__c' },
  // Add custom objects here, e.g.:
  //   { object: 'Invoice__c', externalIdField: 'Legacy_Invoice_Id__c' },
];

/**
 * Builds a { keyPrefix: {object, externalIdField} } map by describing each
 * LINK_OBJECTS entry on the given connection. Uses the SOURCE org because
 * ContentDocumentLink.LinkedEntityId values (and thus their prefixes) come
 * from the source org. Objects absent from the org are skipped with a note.
 */
async function buildPrefixMap(conn) {
  const map = {};
  for (const entry of LINK_OBJECTS) {
    try {
      const meta = await conn.sobject(entry.object).describe();
      if (meta.keyPrefix) map[meta.keyPrefix] = entry;
    } catch (e) {
      console.warn(`  (skipping ${entry.object}: ${(e && e.message) || e})`);
    }
  }
  return map;
}

const MB = 1024 * 1024;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10);
    else if (a === '--where') opts.where = argv[++i];
    else if (a === '--all-versions') opts.allVersions = true;
    else if (a === '--force') opts.force = true;
    else opts._.push(a);
  }
  return opts;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* stats                                                              */
/* ------------------------------------------------------------------ */
async function cmdStats() {
  const conn = await sf.connect('SOURCE');
  const q = (soql) => sf.queryAllRecords(conn, soql);

  const [latest, all, over37, over2g] = await Promise.all([
    q('SELECT COUNT(Id) c, SUM(ContentSize) s, MAX(ContentSize) m FROM ContentVersion WHERE IsLatest = true'),
    q('SELECT COUNT(Id) c, SUM(ContentSize) s FROM ContentVersion'),
    q(`SELECT COUNT(Id) c FROM ContentVersion WHERE IsLatest = true AND ContentSize > ${37 * MB}`),
    // 2GB is 2147483648, but SOQL integer literals cap at 2147483647 - close enough.
    q('SELECT COUNT(Id) c FROM ContentVersion WHERE IsLatest = true AND ContentSize > 2147483647'),
  ]);

  const L = latest[0] || {};
  const A = all[0] || {};
  console.log('\n=== SOURCE ORG FILE STATS ===');
  console.log(`  Latest versions only : ${L.c || 0} files, ${mf.fmtBytes(L.s || 0)}`);
  console.log(`  All versions         : ${A.c || 0} versions, ${mf.fmtBytes(A.s || 0)}`);
  console.log(`  Largest single file  : ${mf.fmtBytes(L.m || 0)}`);
  console.log(`  Files > 37MB (SFDMU ceiling) : ${(over37[0] || {}).c || 0}`);
  console.log(`  Files > 2GB (REST ceiling)   : ${(over2g[0] || {}).c || 0}`);

  const nOver37 = (over37[0] || {}).c || 0;
  const nOver2g = (over2g[0] || {}).c || 0;
  console.log('\n=== WHAT THIS MEANS ===');
  if (nOver2g > 0) {
    console.log(`  ${nOver2g} file(s) exceed the 2GB REST API ceiling - these cannot be`);
    console.log('  migrated via API at all and need manual download/upload through the UI.');
  }
  if (nOver37 === 0) {
    console.log('  Every file is under 37MB - SFDMU (core:ExportFiles) is also viable.');
    console.log('  This script still works and gives you resume/retry control.');
  } else {
    console.log(`  ${nOver37} file(s) are over SFDMU's 37MB ceiling - use this script`);
    console.log('  (multipart upload handles files up to 2GB).');
  }
  console.log('\n  Version-history overhead: ' +
    `${(A.c || 0) - (L.c || 0)} extra version(s), ` +
    `${mf.fmtBytes((A.s || 0) - (L.s || 0))}. ` +
    'Default is latest-only; add --all-versions to manifest if history matters.');
}

/* ------------------------------------------------------------------ */
/* manifest                                                           */
/* ------------------------------------------------------------------ */
async function cmdManifest(opts) {
  const existing = mf.load(WORK_DIR);
  if (existing && !opts.force) {
    throw new Error(
      `Manifest already exists at ${mf.manifestPath(WORK_DIR)} - it holds migration state. ` +
        'Re-running would discard that state. Use --force to overwrite anyway.'
    );
  }

  const conn = await sf.connect('SOURCE');

  console.log('\n=== MANIFEST: querying source ContentVersions ===');
  let soql =
    'SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension, VersionNumber, ContentSize ' +
    'FROM ContentVersion WHERE IsLatest = true';
  if (opts.where) soql += ` AND (${opts.where})`;
  soql += ' ORDER BY ContentDocumentId';
  if (opts.limit) soql += ` LIMIT ${opts.limit}`;

  const latestVersions = await sf.queryAllRecords(conn, soql);
  console.log(`  Found ${latestVersions.length} document(s).`);

  const docs = {};
  for (const v of latestVersions) {
    docs[v.ContentDocumentId] = {
      title: v.Title,
      targetDocId: null,
      links: [],
      versions: [
        {
          id: v.Id,
          versionNumber: v.VersionNumber,
          pathOnClient: v.PathOnClient || `${v.Title}.${v.FileExtension || 'dat'}`,
          size: v.ContentSize || 0,
          state: 'pending',
          targetId: null,
        },
      ],
    };
  }
  const docIds = Object.keys(docs);

  if (opts.allVersions && docIds.length > 0) {
    console.log('  --all-versions: fetching full version history...');
    for (const ids of chunk(docIds, 200)) {
      const versions = await sf.queryAllRecords(
        conn,
        'SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension, VersionNumber, ContentSize ' +
          `FROM ContentVersion WHERE ContentDocumentId IN ('${ids.join("','")}') ` +
          'ORDER BY ContentDocumentId, VersionNumber ASC'
      );
      const byDoc = {};
      for (const v of versions) {
        (byDoc[v.ContentDocumentId] = byDoc[v.ContentDocumentId] || []).push({
          id: v.Id,
          versionNumber: v.VersionNumber,
          pathOnClient: v.PathOnClient || `${v.Title}.${v.FileExtension || 'dat'}`,
          size: v.ContentSize || 0,
          state: 'pending',
          targetId: null,
        });
      }
      for (const [docId, vs] of Object.entries(byDoc)) docs[docId].versions = vs;
    }
  }

  console.log('  Querying ContentDocumentLinks...');
  const prefixMap = await buildPrefixMap(conn);
  let droppedDocs = 0;
  const supportedPrefixes = Object.keys(prefixMap);
  for (const ids of chunk(docIds, 200)) {
    const links = await sf.queryAllRecords(
      conn,
      'SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink ' +
        `WHERE ContentDocumentId IN ('${ids.join("','")}')`
    );
    for (const l of links) {
      const prefix = String(l.LinkedEntityId).slice(0, 3);
      if (!supportedPrefixes.includes(prefix)) continue; // e.g. User (005) links
      docs[l.ContentDocumentId].links.push({ src: l.LinkedEntityId, target: null, state: 'pending' });
    }
  }
  // Drop documents with no link to a migrated record type - uploading them
  // would just create orphaned files owned by the API user in the target org.
  for (const docId of docIds) {
    if (docs[docId].links.length === 0) {
      delete docs[docId];
      droppedDocs++;
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    options: { allVersions: !!opts.allVersions, where: opts.where || null, limit: opts.limit || null },
    linkMap: prefixMap,
    docs,
  };
  mf.save(WORK_DIR, manifest);

  const s = mf.summarize(manifest);
  console.log(`\n  Manifest written: ${mf.manifestPath(WORK_DIR)}`);
  console.log(`  ${s.docs} document(s), ${Object.values(s.versions).reduce((a, b) => a + b, 0)} version(s), ${mf.fmtBytes(s.bytesTotal)} total.`);
  if (droppedDocs > 0) {
    console.log(`  Skipped ${droppedDocs} document(s) with no link to Account/Contact/Opportunity/Case.`);
  }
}

/* ------------------------------------------------------------------ */
/* download                                                           */
/* ------------------------------------------------------------------ */
async function cmdDownload(opts) {
  const manifest = mf.load(WORK_DIR);
  if (!manifest) throw new Error('No manifest - run "node cli.js manifest" first.');

  const conn = await sf.connect('SOURCE');
  const dir = mf.dataDir(WORK_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const pending = [];
  for (const doc of Object.values(manifest.docs)) {
    for (const v of doc.versions) {
      if (v.state === 'pending' || v.state === 'failed') pending.push(v);
    }
  }
  console.log(`\n=== DOWNLOAD: ${pending.length} version(s) pending ===`);

  const limit = sf.createLimiter(opts.concurrency || 3);
  let done = 0;
  let failed = 0;
  let sinceSave = 0;

  await Promise.all(
    pending.map((v) =>
      limit(async () => {
        const dest = path.join(dir, `${v.id}.bin`);
        try {
          const bytes = await sf.downloadVersionToFile(conn, v.id, dest);
          if (v.size && bytes !== v.size) {
            throw new Error(`size mismatch: expected ${v.size}, got ${bytes}`);
          }
          v.state = 'downloaded';
          done++;
          console.log(`  OK (${done}/${pending.length}) ${v.pathOnClient} (${mf.fmtBytes(bytes)})`);
        } catch (err) {
          v.state = 'failed';
          v.error = String((err && err.message) || err);
          failed++;
          console.error(`  FAILED ${v.pathOnClient}: ${v.error}`);
        }
        if (++sinceSave >= 10) {
          sinceSave = 0;
          mf.save(WORK_DIR, manifest);
        }
      })
    )
  );

  mf.save(WORK_DIR, manifest);
  console.log(`\n  Downloaded: ${done}, failed: ${failed}. Re-run this command to retry failures.`);
}

/* ------------------------------------------------------------------ */
/* upload                                                             */
/* ------------------------------------------------------------------ */
async function cmdUpload(opts) {
  const manifest = mf.load(WORK_DIR);
  if (!manifest) throw new Error('No manifest - run "node cli.js manifest" first.');

  const conn = await sf.connect('TARGET');
  const dir = mf.dataDir(WORK_DIR);

  const docsToUpload = Object.entries(manifest.docs).filter(([, doc]) =>
    doc.versions.some((v) => v.state === 'downloaded')
  );
  console.log(`\n=== UPLOAD: ${docsToUpload.length} document(s) with pending version(s) ===`);

  const limit = sf.createLimiter(opts.concurrency || 3);
  let uploaded = 0;
  let failed = 0;
  let sinceSave = 0;

  await Promise.all(
    docsToUpload.map(([docId, doc]) =>
      limit(async () => {
        // Versions must go in order: the first insert creates the target
        // ContentDocument, later ones append to it.
        for (const v of doc.versions) {
          if (v.state === 'uploaded') continue;
          if (v.state !== 'downloaded') {
            console.warn(`  SKIP ${v.pathOnClient} - state is "${v.state}" (download it first).`);
            break; // keep version order intact - don't upload v3 before v2
          }
          const filePath = path.join(dir, `${v.id}.bin`);
          try {
            const metadata = { Title: doc.title, PathOnClient: v.pathOnClient };
            if (doc.targetDocId) metadata.ContentDocumentId = doc.targetDocId;
            const result = await sf.uploadVersionMultipart(conn, metadata, filePath, v.size);
            v.targetId = result.id;
            v.state = 'uploaded';
            delete v.error;
            if (!doc.targetDocId) {
              const created = await sf.withRetry(
                conn,
                () => conn.sobject('ContentVersion').retrieve(result.id),
                { label: 'retrieve ContentDocumentId' }
              );
              doc.targetDocId = created.ContentDocumentId;
            }
            uploaded++;
            console.log(`  OK ${v.pathOnClient} (${mf.fmtBytes(v.size)}) -> ${v.targetId}`);
          } catch (err) {
            v.error = String((err && err.message) || err);
            failed++;
            console.error(`  FAILED ${v.pathOnClient}: ${v.error}`);
            break; // don't upload later versions of this doc out of order
          }
          if (++sinceSave >= 10) {
            sinceSave = 0;
            mf.save(WORK_DIR, manifest);
          }
        }
      })
    )
  );

  mf.save(WORK_DIR, manifest);
  console.log(`\n  Uploaded: ${uploaded}, failed: ${failed}. Re-run this command to retry failures.`);
}

/* ------------------------------------------------------------------ */
/* link                                                               */
/* ------------------------------------------------------------------ */
async function cmdLink() {
  const manifest = mf.load(WORK_DIR);
  if (!manifest) throw new Error('No manifest - run "node cli.js manifest" first.');

  const conn = await sf.connect('TARGET');

  // 1. Collect the source record Ids we need to resolve, grouped by prefix.
  const needed = {};
  for (const doc of Object.values(manifest.docs)) {
    if (!doc.targetDocId) continue;
    for (const l of doc.links) {
      if (l.state === 'linked') continue;
      const prefix = l.src.slice(0, 3);
      (needed[prefix] = needed[prefix] || new Set()).add(l.src);
    }
  }

  // 2. Resolve source Id -> target Id via the Legacy_*_Id__c external Ids.
  const linkMap = manifest.linkMap || {};
  const idMap = new Map();
  for (const [prefix, srcIds] of Object.entries(needed)) {
    const cfg = linkMap[prefix];
    if (!cfg) {
      console.warn(`  (no mapping for prefix ${prefix} - skipping ${srcIds.size} link(s))`);
      continue;
    }
    const { object, externalIdField } = cfg;
    for (const ids of chunk([...srcIds], 200)) {
      const rows = await sf.queryAllRecords(
        conn,
        `SELECT Id, ${externalIdField} FROM ${object} WHERE ${externalIdField} IN ('${ids.join("','")}')`
      );
      for (const r of rows) idMap.set(r[externalIdField], r.Id);
    }
    console.log(`  ${object}: resolved ${idMap.size} mapping(s) so far.`);
  }

  // 3. Build and insert the ContentDocumentLink records.
  const toInsert = [];
  let unmapped = 0;
  for (const doc of Object.values(manifest.docs)) {
    if (!doc.targetDocId) continue;
    for (const l of doc.links) {
      if (l.state === 'linked') continue;
      const target = idMap.get(l.src);
      if (!target) {
        l.state = 'unmapped';
        unmapped++;
        continue;
      }
      l.target = target;
      toInsert.push({
        record: { ContentDocumentId: doc.targetDocId, LinkedEntityId: target, ShareType: 'V' },
        link: l,
      });
    }
  }
  console.log(`\n=== LINK: inserting ${toInsert.length} link(s) (${unmapped} unmapped) ===`);

  let linked = 0;
  let failed = 0;
  for (const batch of chunk(toInsert, 200)) {
    const results = await sf.withRetry(
      conn,
      () => conn.sobject('ContentDocumentLink').create(batch.map((b) => b.record), { allOrNone: false }),
      { label: 'insert links' }
    );
    results.forEach((res, i) => {
      const l = batch[i].link;
      if (res.success) {
        l.state = 'linked';
        linked++;
      } else {
        const msg = JSON.stringify(res.errors);
        // A previous partial run may have already created this link.
        if (/already|DUPLICATE/i.test(msg)) {
          l.state = 'linked';
          linked++;
        } else {
          l.state = 'failed';
          l.error = msg;
          failed++;
          console.error(`  FAILED link ${l.src} -> ${l.target}: ${msg}`);
        }
      }
    });
    mf.save(WORK_DIR, manifest);
  }

  mf.save(WORK_DIR, manifest);
  console.log(`\n  Linked: ${linked}, unmapped: ${unmapped}, failed: ${failed}.`);
  if (unmapped > 0) {
    console.log('  "Unmapped" = the parent record was not found in the target org via its');
    console.log('  Legacy_*_Id__c field - migrate those records first, then re-run link.');
  }
}

/* ------------------------------------------------------------------ */
/* verify                                                             */
/* ------------------------------------------------------------------ */
function cmdVerify() {
  const manifest = mf.load(WORK_DIR);
  if (!manifest) throw new Error('No manifest - run "node cli.js manifest" first.');
  const s = mf.summarize(manifest);
  console.log('\n=== MIGRATION STATE ===');
  console.log(`  Documents : ${s.docs}`);
  console.log(`  Versions  : pending ${s.versions.pending || 0}, downloaded ${s.versions.downloaded || 0}, uploaded ${s.versions.uploaded || 0}, failed ${s.versions.failed || 0}`);
  console.log(`  Links     : pending ${s.links.pending || 0}, linked ${s.links.linked || 0}, unmapped ${s.links.unmapped || 0}, failed ${s.links.failed || 0}`);
  console.log(`  Bytes     : total ${mf.fmtBytes(s.bytesTotal)}, downloaded ${mf.fmtBytes(s.bytesDownloaded)}, uploaded ${mf.fmtBytes(s.bytesUploaded)}`);

  const failures = [];
  for (const [docId, doc] of Object.entries(manifest.docs)) {
    for (const v of doc.versions) {
      if (v.state === 'failed' || v.error) failures.push(`  version ${v.id} (${v.pathOnClient}): ${v.error}`);
    }
    for (const l of doc.links) {
      if (l.state === 'failed') failures.push(`  link ${l.src} on doc ${docId}: ${l.error}`);
    }
  }
  if (failures.length > 0) {
    console.log(`\n=== FAILURES (${failures.length}) ===`);
    failures.slice(0, 50).forEach((f) => console.log(f));
    if (failures.length > 50) console.log(`  ...and ${failures.length - 50} more.`);
  }
}

/* ------------------------------------------------------------------ */
/* login - the tool's own OAuth (device flow), no CLI/password        */
/* ------------------------------------------------------------------ */
async function cmdLogin(opts) {
  const oauth = require('./lib/oauth');
  const readline = require('readline');
  const cfgPath = path.join(process.cwd(), 'migration.config.json');

  // Optional: "login source" or "login target" to (re)authorize just one org.
  const which = (opts && opts._ || []).map((s) => s.toUpperCase());
  const prefixes = which.length ? ['SOURCE', 'TARGET'].filter((p) => which.includes(p)) : ['SOURCE', 'TARGET'];

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    /* no config yet */
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  const sandbox = (await ask('Are these sandboxes? (y/N): ')).trim().toLowerCase().startsWith('y');
  const host = sandbox ? 'test.salesforce.com' : 'login.salesforce.com';

  // Each org needs its own device-flow app (a Local app only works in the org
  // it was created in), so ask per org. Press Enter to reuse the saved value.
  cfg.apps = cfg.apps || {};
  for (const prefix of prefixes) {
    const saved = cfg.apps[prefix] || {};
    const cidPrompt = saved.clientId ? `Consumer Key for ${prefix} [Enter = saved]: ` : `Consumer Key for ${prefix}: `;
    const clientId = ((await ask(cidPrompt)).trim() || saved.clientId || '').trim();
    const csecPrompt = `Consumer Secret for ${prefix} [Enter if none/saved]: `;
    const clientSecret = ((await ask(csecPrompt)).trim() || saved.clientSecret || '').trim();

    const tok = await oauth.deviceLogin(clientId, clientSecret, host, prefix);
    oauth.saveAuth(prefix, {
      clientId,
      clientSecret,
      refreshToken: tok.refresh_token,
      instanceUrl: tok.instance_url,
    });
    cfg.apps[prefix] = { clientId, clientSecret };
    console.log(`  [${prefix}] authorized -> ${tok.instance_url}`);
  }
  rl.close();

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log('\nAuthorized. Tokens saved in .auth/ (gitignored, no passwords).');
  console.log('Next:  node cli.js doctor');
}

/* ------------------------------------------------------------------ */
/* doctor - preflight checks: tell the user what's missing            */
/* ------------------------------------------------------------------ */
async function cmdDoctor() {
  const results = [];
  const ok = (m) => results.push(['OK  ', m]);
  const warn = (m) => results.push(['WARN', m]);
  const bad = (m) => results.push(['FAIL', m]);

  // Node version (undici in jsforce needs Node 22+)
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node} — needs 22+ (older versions crash on undici). Upgrade Node.`);

  // Salesforce CLI (needed for init / CLI auth)
  try {
    const { execFileSync } = require('child_process');
    const v = execFileSync('sf', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
    ok(`Salesforce CLI: ${v}`);
  } catch (_) {
    warn('Salesforce CLI not found — required for "init"/CLI auth (fine if you use the .env method).');
  }

  // Connections
  let source = null;
  let target = null;
  try { source = await sf.connect('SOURCE'); ok('Connected to SOURCE'); }
  catch (e) { bad(`SOURCE connection failed: ${(e && e.message) || e}`); }
  try { target = await sf.connect('TARGET'); ok('Connected to TARGET'); }
  catch (e) { bad(`TARGET connection failed: ${(e && e.message) || e}`); }

  // External Id fields present on the target?
  if (target) {
    const records = require('./lib/records');
    let objects = records.DEFAULT_OBJECTS;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'migration.config.json'), 'utf8'));
      if (Array.isArray(cfg.objects) && cfg.objects.length) objects = cfg.objects;
    } catch (_) { /* defaults */ }
    for (const o of objects) {
      try {
        const d = await target.sobject(o.name).describe();
        if (d.fields.some((f) => f.name === o.externalId)) ok(`Target ${o.name}.${o.externalId} visible`);
        else bad(`Target ${o.name}.${o.externalId} not visible — deploy sfdx-package AND assign the "Migration Access" permission set (a deployed field needs field-level security).`);
      } catch (e) {
        warn(`Could not check ${o.name}: ${(e && e.message) || e}`);
      }
    }
  }

  // File volume hint (target must have at least this much File Storage)
  if (source) {
    try {
      const r = await sf.queryAllRecords(
        source,
        'SELECT SUM(ContentSize) s, COUNT(Id) c FROM ContentVersion WHERE IsLatest = true'
      );
      const bytes = (r[0] && r[0].s) || 0;
      ok(`Source files: ${(r[0] && r[0].c) || 0}, ${mf.fmtBytes(bytes)} — target needs at least this much free File Storage (Setup → Storage Usage).`);
    } catch (_) { /* ignore */ }
  }

  // Free disk on the machine running the tool
  try {
    const st = fs.statfsSync(__dirname);
    ok(`Free disk here: ${mf.fmtBytes(st.bavail * st.bsize)} (need ≥ 2× your file volume)`);
  } catch (_) { /* statfs unavailable */ }

  console.log('\n=== DOCTOR ===');
  for (const [tag, m] of results) console.log(`  [${tag}] ${m}`);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(fails ? `\n${fails} problem(s) to fix before migrating.` : '\nAll good — ready to migrate.');
}

/* ------------------------------------------------------------------ */
/* records - migrate records (no Named Credential; CLI auth)          */
/* ------------------------------------------------------------------ */
async function cmdRecords() {
  const records = require('./lib/records');

  let objects = records.DEFAULT_OBJECTS;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'migration.config.json'), 'utf8'));
    if (Array.isArray(cfg.objects) && cfg.objects.length) objects = cfg.objects;
  } catch (_) {
    /* no config objects - use defaults */
  }

  const source = await sf.connect('SOURCE');
  const target = await sf.connect('TARGET');
  console.log(`\n=== RECORDS: ${objects.map((o) => o.name).join(', ')} ===`);
  const summary = await records.migrateRecords(source, target, objects);

  console.log('\n=== RECORDS DONE ===');
  for (const s of summary) {
    console.log(`  ${s.name}: ${s.upserted} upserted, ${s.skipped} skipped (parent missing), ${s.failed} failed`);
  }
  console.log('\nNext: node cli.js run   (to migrate the files)');
}

/* ------------------------------------------------------------------ */
/* init - interactive setup wizard (no manual .env editing)           */
/* ------------------------------------------------------------------ */
async function cmdInit() {
  const { execFileSync } = require('child_process');
  const readline = require('readline');

  let orgs = [];
  try {
    const out = execFileSync('sf', ['org', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const res = JSON.parse(out).result || {};
    orgs = [...(res.nonScratchOrgs || []), ...(res.scratchOrgs || []), ...(res.other || [])];
  } catch (e) {
    throw new Error(
      'Could not run "sf org list". Install the Salesforce CLI and log in to your orgs first:\n' +
        '  sf org login web --alias sourceOrg\n  sf org login web --alias targetOrg'
    );
  }

  const list = [...new Set(orgs.map((o) => o.alias || o.username).filter(Boolean))];
  if (list.length === 0) {
    throw new Error('No orgs found. Log in first:  sf org login web --alias <name>');
  }

  console.log('\nAvailable orgs (from Salesforce CLI):');
  list.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const pick = async (role) => {
    const ans = (await ask(`\nWhich org is the ${role}? (number or alias): `)).trim();
    const n = parseInt(ans, 10);
    if (!isNaN(n) && list[n - 1]) return list[n - 1];
    if (list.includes(ans)) return ans;
    throw new Error(`Not a valid choice: "${ans}"`);
  };

  try {
    const sourceOrg = await pick('SOURCE (migrate FROM)');
    const targetOrg = await pick('TARGET (migrate TO)');
    const cfgPath = path.join(process.cwd(), 'migration.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ sourceOrg, targetOrg }, null, 2));
    console.log(`\nSaved ${cfgPath}`);
    console.log(`  source: ${sourceOrg}\n  target: ${targetOrg}`);
    console.log('\nNo passwords stored - connections use the Salesforce CLI.');
    console.log('Next:  node cli.js stats');
  } finally {
    rl.close();
  }
}

/**
 * Tees console output to a timestamped file under work/logs, so long
 * unattended runs (especially on a VM) leave an audit trail.
 */
function setupFileLog(cmd) {
  try {
    const dir = path.join(WORK_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${ts}-${cmd}.log`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const write = (a) => { try { stream.write(a.map(String).join(' ') + '\n'); } catch (_) {} };
    console.log = (...a) => { write(a); origLog(...a); };
    console.error = (...a) => { write(a); origErr(...a); };
    origLog(`  (logging to ${file})`);
  } catch (_) {
    /* logging is best-effort */
  }
}

/* ------------------------------------------------------------------ */
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const opts = parseArgs(rest);

  if (['records', 'migrate', 'run', 'download', 'upload', 'link'].includes(cmd)) {
    setupFileLog(cmd);
  }

  switch (cmd) {
    case 'ui':
      require('./server'); // starts the local web UI (keeps running)
      return;
    case 'init':
      return cmdInit();
    case 'login':
      return cmdLogin(opts);
    case 'doctor':
      return cmdDoctor();
    case 'records':
      return cmdRecords();
    case 'migrate':
      await cmdRecords();
      if (!mf.load(WORK_DIR)) await cmdManifest(opts);
      await cmdDownload(opts);
      await cmdUpload(opts);
      await cmdLink();
      return cmdVerify();
    case 'stats':
      return cmdStats();
    case 'manifest':
      return cmdManifest(opts);
    case 'download':
      return cmdDownload(opts);
    case 'upload':
      return cmdUpload(opts);
    case 'link':
      return cmdLink();
    case 'verify':
      return cmdVerify();
    case 'run':
      if (!mf.load(WORK_DIR)) await cmdManifest(opts);
      await cmdDownload(opts);
      await cmdUpload(opts);
      await cmdLink();
      return cmdVerify();
    default:
      console.log('Usage: node cli.js <login|init|doctor|records|migrate|stats|manifest|download|upload|link|verify|run> [options]');
      console.log('  login     authorize both orgs via OAuth device flow (no CLI, no password)');
      console.log('  init      alternative: pick two Salesforce CLI orgs');
      console.log('  ui        open the local web UI (buttons instead of the terminal)');
      console.log('  doctor    preflight checks - what is missing before you migrate');
      console.log('  records   migrate records (no Named Credential needed)');
      console.log('  migrate   records + files, end to end');
      console.log('  run       files only (manifest -> download -> upload -> link -> verify)');
      console.log('Options: --limit N, --where "SOQL condition", --all-versions, --concurrency N, --force');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\nFailed:', (err && err.message) || err);
  process.exit(1);
});
