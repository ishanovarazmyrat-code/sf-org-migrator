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
    const def = defs[sel.name];
    if (!def) continue; // ignore unknown objects
    const entry = { name: def.name, externalId: def.externalId, fields: 'auto' };
    if (def.parents) entry.parents = def.parents;
    if (Array.isArray(sel.fields) && sel.fields.length) entry.fields = sel.fields;
    entries.push(entry);
  }
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
