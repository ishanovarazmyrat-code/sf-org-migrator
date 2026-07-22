/**
 * Web UI for the migration tool. No external dependencies.
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
 * TWO MODES:
 *   Local (default)  - binds 127.0.0.1 only, no login. The UI can trigger real
 *                      migrations, so locally it must never be network-reachable.
 *   Hosted           - set UI_ACCESS_KEY to run it behind a URL (e.g. in a
 *                      container). It then binds 0.0.0.0 AND requires that key
 *                      on a login screen before any route works, so an exposed
 *                      instance is not an open migration trigger.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// UI_PORT for local use; PORT is what most hosts (Render/Railway/Heroku) inject.
const PORT = process.env.UI_PORT || process.env.PORT || 4599;
const CLI = path.join(__dirname, 'cli.js');
const CONFIG_PATH = path.join(process.cwd(), 'migration.config.json');

// Hosted mode: a non-empty UI_ACCESS_KEY turns on the login gate and lets the
// server bind to all interfaces. Without it, the old localhost-only behaviour.
const ACCESS_KEY = process.env.UI_ACCESS_KEY || '';
const HOSTED = ACCESS_KEY.length > 0;
const BIND_HOST = process.env.UI_HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');
const sessions = new Set(); // valid session ids (in-memory; cleared on restart)
const pendingLogins = {};   // prefix -> in-progress device-flow login state

// Only these commands can be triggered from the UI (no destructive/interactive ones).
const ALLOWED = new Set(['stats', 'records', 'run', 'verify']);

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* auth gate (hosted mode only)                                        */
/* ------------------------------------------------------------------ */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  if (!HOSTED) return true; // local mode: no gate
  const sid = parseCookies(req).sid;
  return !!sid && sessions.has(sid);
}

// Constant-time compare so the key can't be guessed by timing.
function keyMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Org Migration</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; display: grid; place-items: center;
    min-height: 100vh; margin: 0; background: #0f141b; color: #e2e8f0; }
  form { background: #161c26; border: 1px solid #2d3748; border-radius: 12px; padding: 28px; width: 320px; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { font-size: 13px; color: #94a3b8; margin: 0 0 18px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2d3748;
    background: #0d1117; color: #e2e8f0; font-size: 14px; }
  button { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 8px; background: #2b6cb0;
    color: #fff; font-size: 14px; cursor: pointer; }
  .err { color: #fc8181; font-size: 13px; margin-top: 10px; min-height: 16px; }
</style>
<form method="POST" action="/login">
  <h1>🔄 Org-to-Org Migration</h1>
  <p>Enter the access key to continue.</p>
  <input type="password" name="key" placeholder="Access key" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
  <div class="err">__ERR__</div>
</form>`;

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
  const apps = cfg.apps || {};
  sendJson(res, 200, {
    source,
    target,
    config: { sourceOrg: cfg.sourceOrg || null, targetOrg: cfg.targetOrg || null },
    // Saved Consumer Keys (not secrets) so the Connect form can prefill.
    apps: {
      SOURCE: { clientId: (apps.SOURCE && apps.SOURCE.clientId) || '' },
      TARGET: { clientId: (apps.TARGET && apps.TARGET.clientId) || '' },
    },
  });
}

/* ------------------------------------------------------------------ */
/* /api/login/start + /api/login/poll - browser OAuth device flow      */
/* ------------------------------------------------------------------ */
async function apiLoginStart(req, res) {
  const oauth = require('./lib/oauth');
  const body = await readBody(req);
  const which = String(body.which || '').toUpperCase();
  if (which !== 'SOURCE' && which !== 'TARGET') {
    return sendJson(res, 400, { error: 'which must be SOURCE or TARGET' });
  }
  const clientId = String(body.clientId || '').trim();
  const clientSecret = String(body.clientSecret || '').trim();
  if (!clientId) return sendJson(res, 400, { error: 'Consumer Key is required' });
  const host = body.sandbox ? 'test.salesforce.com' : 'login.salesforce.com';
  try {
    const start = await oauth.startDevice(clientId, clientSecret, host);
    pendingLogins[which] = { clientId, clientSecret, host, deviceCode: start.device_code };
    sendJson(res, 200, {
      verificationUri: start.verification_uri,
      userCode: start.user_code,
      interval: start.interval || 5,
    });
  } catch (e) {
    sendJson(res, 400, { error: String((e && e.message) || e) });
  }
}

async function apiLoginPoll(req, res) {
  const oauth = require('./lib/oauth');
  const body = await readBody(req);
  const which = String(body.which || '').toUpperCase();
  const p = pendingLogins[which];
  if (!p) return sendJson(res, 400, { status: 'error', error: 'no login in progress' });
  try {
    const r = await oauth.pollDevice(p.clientId, p.clientSecret, p.host, p.deviceCode);
    if (r.status === 'done') {
      const t = r.token;
      oauth.saveAuth(which, {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        refreshToken: t.refresh_token,
        instanceUrl: t.instance_url,
      });
      // Remember the Consumer Key so next time the form is prefilled.
      const cfg = readConfig();
      cfg.apps = cfg.apps || {};
      cfg.apps[which] = { clientId: p.clientId, clientSecret: p.clientSecret };
      writeConfig(cfg);
      delete pendingLogins[which];
      return sendJson(res, 200, { status: 'done', instanceUrl: t.instance_url });
    }
    if (r.status === 'error') delete pendingLogins[which];
    sendJson(res, 200, r);
  } catch (e) {
    sendJson(res, 200, { status: 'error', error: String((e && e.message) || e) });
  }
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
        required: plan.required || [], // required-on-target subset
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
    required: plan.required || [],
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
/* /login (hosted mode) - exchange the access key for a session cookie */
/* ------------------------------------------------------------------ */
function handleLogin(res, form) {
  if (keyMatches(form && form.key)) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.writeHead(302, {
      'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      Location: '/',
    });
    return res.end();
  }
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(LOGIN_PAGE.replace('__ERR__', 'Wrong access key.'));
}

// readBody handles JSON; the login form posts urlencoded, so parse that too.
function readFormOrJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(data || '{}')); } catch { return resolve({}); }
      }
      const out = {};
      new URLSearchParams(data).forEach((v, k) => (out[k] = v));
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // Hosted-mode login gate. /login is the only route reachable unauthenticated.
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const form = await readFormOrJson(req);
        return handleLogin(res, form);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_PAGE.replace('__ERR__', ''));
    }
    if (!isAuthed(req)) {
      if (url.pathname === '/' ) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_PAGE.replace('__ERR__', ''));
      }
      return sendJson(res, 401, { error: 'unauthorized' });
    }

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
    if (url.pathname === '/api/login/start' && req.method === 'POST') return await apiLoginStart(req, res);
    if (url.pathname === '/api/login/poll' && req.method === 'POST') return await apiLoginPoll(req, res);
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

server.listen(PORT, BIND_HOST, () => {
  if (HOSTED) {
    console.log(`\n  Migration UI (hosted) on  http://${BIND_HOST}:${PORT}  — login required (UI_ACCESS_KEY set)\n`);
  } else {
    console.log(`\n  Migration UI running at  http://localhost:${PORT}  (localhost only)\n`);
  }
});
