/**
 * Local web UI for the migration tool. No external dependencies.
 *
 *   node server.js        then open http://localhost:4599
 *
 * Three panels:
 *   Setup           - live connection status for both orgs (JSON /api/status).
 *   Objects & Fields- describe both orgs and choose which objects/fields to
 *                     migrate; the choice is written to migration.config.json
 *                     so the CLI (records command) picks it up.
 *   Run             - the same CLI phases (stats / records / run / verify) as
 *                     child processes, streamed live with a progress bar + ETA.
 *
 * Everything binds to 127.0.0.1 only: the UI can trigger real migrations, so
 * it must never be reachable from the network.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.UI_PORT || 4599;
const CLI = path.join(__dirname, 'cli.js');
const CONFIG_PATH = path.join(process.cwd(), 'migration.config.json');

// Only these commands can be triggered from the UI (no destructive/interactive ones).
const ALLOWED = new Set(['stats', 'records', 'run', 'verify']);

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* config helpers                                                      */
/* ------------------------------------------------------------------ */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Base object definitions (name -> {externalId, parents}) from records.js. */
function baseObjectDefs() {
  const { DEFAULT_OBJECTS } = require('./lib/records');
  const map = {};
  for (const o of DEFAULT_OBJECTS) map[o.name] = o;
  return map;
}

const NAME_RE = /^[A-Za-z0-9_]+$/;
const safeName = (s) => (typeof s === 'string' && NAME_RE.test(s) ? s : null);

/** The external-Id field convention: Account -> Legacy_Account_Id__c,
 *  Invoice__c -> Legacy_Invoice_Id__c. */
function defaultExternalId(name) {
  return 'Legacy_' + name.replace(/__c$/i, '') + '_Id__c';
}

/** Stable topological sort so a parent object is listed before any child that
 *  remaps a lookup onto it (the migration processes objects in order). Sorts in
 *  place; ignores parents that aren't in the set, and tolerates cycles. */
function sortByDependency(entries) {
  const inSet = new Set(entries.map((e) => e.name));
  const deps = new Map(
    entries.map((e) => [e.name, new Set(Object.values(e.parents || {}).filter((p) => inSet.has(p) && p !== e.name))])
  );
  const byName = new Map(entries.map((e) => [e.name, e]));
  const out = [];
  const done = new Set();
  const visit = (name, stack) => {
    if (done.has(name) || stack.has(name)) return; // cycle guard
    stack.add(name);
    for (const p of deps.get(name) || []) visit(p, stack);
    stack.delete(name);
    done.add(name);
    out.push(byName.get(name));
  };
  for (const e of entries) visit(e.name, new Set());
  entries.length = 0;
  entries.push(...out);
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */
function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large')); // guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* /api/status - are both orgs reachable?                              */
/* ------------------------------------------------------------------ */
async function apiStatus(res) {
  const sf = require('./lib/sf');
  const probe = async (which) => {
    try {
      const conn = await sf.connect(which);
      return { ok: true, instanceUrl: conn.instanceUrl || null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  const [source, target] = await Promise.all([probe('SOURCE'), probe('TARGET')]);
  const cfg = readConfig();
  sendJson(res, 200, {
    source,
    target,
    config: { sourceOrg: cfg.sourceOrg || null, targetOrg: cfg.targetOrg || null },
  });
}

/* ------------------------------------------------------------------ */
/* /api/objects - describe both orgs, return selectable fields         */
/* ------------------------------------------------------------------ */
async function apiObjects(res) {
  const sf = require('./lib/sf');
  const records = require('./lib/records');
  const defs = baseObjectDefs();
  const cfg = readConfig();

  // What the user has already chosen (name -> saved entry), if anything.
  const saved = {};
  if (Array.isArray(cfg.objects)) for (const o of cfg.objects) saved[o.name] = o;

  const source = await sf.connect('SOURCE');
  const target = await sf.connect('TARGET');

  const out = [];
  for (const name of Object.keys(defs)) {
    const def = defs[name];
    try {
      // buildFieldPlan returns exactly the copyable intersection of both orgs.
      const plan = await records.buildFieldPlan(source, target, def, () => {});
      const savedEntry = saved[name];
      out.push({
        name,
        externalId: def.externalId,
        available: plan.fields, // copyable field names
        // "auto" (all copyable) unless the user saved an explicit list.
        selected:
          savedEntry && Array.isArray(savedEntry.fields) ? savedEntry.fields : 'auto',
        // enabled = present in saved config, or true when no config saved yet.
        enabled: Array.isArray(cfg.objects) ? !!savedEntry : true,
      });
    } catch (e) {
      out.push({ name, externalId: def.externalId, error: String((e && e.message) || e) });
    }
  }
  sendJson(res, 200, { objects: out });
}

/* ------------------------------------------------------------------ */
/* /api/all-objects - every migratable object in the source org        */
/* ------------------------------------------------------------------ */
async function apiAllObjects(res) {
  const sf = require('./lib/sf');
  const source = await sf.connect('SOURCE');
  const g = await source.describeGlobal();
  const skip = /(Share|History|Feed|ChangeEvent|Tag)$/;
  const list = (g.sobjects || [])
    .filter(
      (o) =>
        o.queryable && o.createable && o.keyPrefix && !o.deprecatedAndHidden &&
        !skip.test(o.name) && !/__(mdt|e|x|b)$/i.test(o.name)
    )
    .map((o) => ({ name: o.name, label: o.label, custom: !!o.custom }))
    .sort((a, b) => a.label.localeCompare(b.label));
  sendJson(res, 200, { objects: list });
}

/* ------------------------------------------------------------------ */
/* /api/object?name=X&known=A,B - one object's plan for the "Add" flow  */
/*   returns copyable fields, its external-Id (and whether it exists on */
/*   the target), and lookups that map to already-selected parents.     */
/* ------------------------------------------------------------------ */
async function apiObject(res, url) {
  const sf = require('./lib/sf');
  const records = require('./lib/records');
  const name = safeName(url.searchParams.get('name'));
  if (!name) return sendJson(res, 400, { error: 'invalid object name' });
  const known = new Set(
    (url.searchParams.get('known') || '').split(',').map(safeName).filter(Boolean)
  );

  const source = await sf.connect('SOURCE');
  const target = await sf.connect('TARGET');

  // Object must exist on the target too.
  let tgtDesc;
  try {
    tgtDesc = await target.sobject(name).describe();
  } catch (_) {
    return sendJson(res, 200, { name, error: `"${name}" does not exist in the target org.` });
  }
  const srcDesc = await source.sobject(name).describe();

  // Detect lookups that point at an already-selected object -> parent remap.
  const parents = {};
  for (const f of srcDesc.fields) {
    if (f.type === 'reference' && f.name !== 'RecordTypeId' && Array.isArray(f.referenceTo)) {
      const ref = f.referenceTo.find((r) => known.has(r));
      if (ref && !parents[f.name]) parents[f.name] = ref;
    }
  }

  const externalId = defaultExternalId(name);
  const externalIdOnTarget = tgtDesc.fields.some((f) => f.name === externalId);

  const objCfg = { name, externalId, parents, fields: 'auto' };
  const plan = await records.buildFieldPlan(source, target, objCfg, () => {});

  sendJson(res, 200, {
    name,
    label: srcDesc.label,
    externalId,
    externalIdOnTarget,
    parents,
    available: plan.fields,
    selected: 'auto',
    enabled: true,
    custom: !!srcDesc.custom,
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/config - persist the object/field selection               */
/* body: { objects: [ { name, fields: 'auto' | [..] } ] }              */
/* ------------------------------------------------------------------ */
async function apiSaveConfig(req, res) {
  const body = await readBody(req);
  const defs = baseObjectDefs();
  if (!Array.isArray(body.objects)) {
    return sendJson(res, 400, { error: 'objects must be an array' });
  }
  const entries = [];
  for (const sel of body.objects) {
    const name = safeName(sel.name);
    if (!name) continue;
    const def = defs[name];
    // Known default objects: trust our own externalId/parents. Custom objects
    // added via the UI: take (sanitized) externalId/parents from the client.
    let externalId, parents;
    if (def) {
      externalId = def.externalId;
      parents = def.parents;
    } else {
      externalId = safeName(sel.externalId) || defaultExternalId(name);
      parents = {};
      if (sel.parents && typeof sel.parents === 'object') {
        for (const [k, v] of Object.entries(sel.parents)) {
          const sk = safeName(k), sv = safeName(v);
          if (sk && sv) parents[sk] = sv;
        }
      }
    }
    const entry = { name, externalId, fields: 'auto' };
    if (parents && Object.keys(parents).length) entry.parents = parents;
    if (Array.isArray(sel.fields) && sel.fields.length) {
      entry.fields = sel.fields.map(safeName).filter(Boolean);
    }
    entries.push(entry);
  }
  // Order matters for the migration: a parent object must come before any
  // child that remaps a lookup to it. Topologically sort by parents.
  sortByDependency(entries);
  const cfg = readConfig();
  cfg.objects = entries;
  writeConfig(cfg);
  sendJson(res, 200, { ok: true, objects: entries });
}

/* ------------------------------------------------------------------ */
/* /run - stream a CLI command over Server-Sent Events                 */
/* ------------------------------------------------------------------ */
function runCommand(req, res, url) {
  const cmd = url.searchParams.get('cmd');
  if (!ALLOWED.has(cmd)) {
    res.writeHead(400);
    return res.end('bad command');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const args = [CLI, cmd];
  if (url.searchParams.get('allVersions') === '1' && cmd === 'run') args.push('--all-versions');
  // Run in the user's working directory so work/, .auth/, config resolve there.
  const child = spawn('node', args, { cwd: process.cwd() });
  child.stdout.on('data', (d) => d.toString().split('\n').forEach((l) => l && send('log', l)));
  child.stderr.on('data', (d) => d.toString().split('\n').forEach((l) => l && send('log', l)));
  child.on('close', (code) => {
    send('done', { code });
    res.end();
  });
  req.on('close', () => child.kill());
}

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (url.pathname === '/api/status') return await apiStatus(res);
    if (url.pathname === '/api/objects') return await apiObjects(res);
    if (url.pathname === '/api/all-objects') return await apiAllObjects(res);
    if (url.pathname === '/api/object') return await apiObject(res, url);
    if (url.pathname === '/api/config' && req.method === 'POST') {
      return await apiSaveConfig(req, res);
    }
    if (url.pathname === '/run') return runCommand(req, res, url);
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    // JSON endpoints report errors as JSON; anything else is already handled.
    if (url.pathname.startsWith('/api/')) return sendJson(res, 500, { error: String((e && e.message) || e) });
    res.writeHead(500);
    res.end('error');
  }
});

// Bind to localhost only — the UI can trigger migrations, so it must never
// be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Migration UI running at  http://localhost:${PORT}  (localhost only)\n`);
});
