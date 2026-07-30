/**
 * Salesforce connection + low-level transfer helpers.
 *
 * Everything here is stream-based on purpose: at 10GB total volume (and
 * individual files potentially in the hundreds of MB), buffering whole
 * files in memory - like the original PoC did - is not an option.
 */
const jsforce = require('jsforce');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const API_VERSION = '64.0';

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Decides which Salesforce CLI org alias to use for a prefix (SOURCE/TARGET).
 * Order: env var (e.g. SOURCE_ORG) -> migration.config.json -> null (which
 * means fall back to username/password from .env).
 */
function resolveAlias(prefix) {
  if (process.env[`${prefix}_ORG`]) return process.env[`${prefix}_ORG`];
  for (const p of [
    path.join(process.cwd(), 'migration.config.json'),
    path.join(__dirname, '..', 'migration.config.json'),
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const key = prefix === 'SOURCE' ? cfg.sourceOrg : cfg.targetOrg;
      if (key) return key;
    } catch (_) {
      /* no config file, or unreadable - ignore */
    }
  }
  return null;
}

/** Exchanges an sfdxAuthUrl (force://id:secret:refreshToken@domain) for a
 *  fresh access token. Needed because recent CLIs mask the access token in
 *  `sf org display`, so we refresh our own from the stored refresh token. */
async function tokenFromAuthUrl(authUrl) {
  const m = authUrl.match(/^force:\/\/([^:]+):([^:]*):([^@]+)@(.+)$/);
  if (!m) throw new Error('Unrecognized sfdxAuthUrl format.');
  const [, clientId, clientSecret, refreshToken, domain] = m;
  const loginUrl = domain.startsWith('http') ? domain : 'https://' + domain;
  const oauth2 = new jsforce.OAuth2({ loginUrl, clientId, clientSecret });
  const res = await oauth2.refreshToken(refreshToken);
  return { instanceUrl: res.instance_url, accessToken: res.access_token };
}

/** Reads a usable instanceUrl + accessToken for an org alias from the CLI.
 *  Uses the CLI's access token directly when it's a real one; otherwise
 *  (newer CLIs mask it) refreshes a fresh token from the sfdxAuthUrl. */
async function cliOrgInfo(alias) {
  let out;
  try {
    out = execFileSync('sf', ['org', 'display', '--target-org', alias, '--verbose', '--json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    const detail = (e.stdout && e.stdout.toString()) || (e.message || '');
    throw new Error(
      `Salesforce CLI could not read org "${alias}". ` +
        `Log in first:  sf org login web --alias ${alias}\n  ${detail.slice(0, 300)}`
    );
  }
  const r = (JSON.parse(out) || {}).result || {};
  // A real Salesforce session token is long (~110+). Short = masked by the CLI.
  if (r.accessToken && r.accessToken.length > 80 && r.instanceUrl) {
    return { instanceUrl: r.instanceUrl, accessToken: r.accessToken };
  }
  if (r.sfdxAuthUrl) {
    return await tokenFromAuthUrl(r.sfdxAuthUrl);
  }
  throw new Error(
    `Could not get a usable access token for org "${alias}". Re-authenticate:  sf org login web --alias ${alias}`
  );
}

/**
 * Connects to an org. Prefers Salesforce CLI auth (no passwords stored) when
 * an org alias is configured; otherwise falls back to username/password from
 * .env. Either way, conn.$reauth refreshes the session on expiry.
 */
async function connect(prefix) {
  let conn;

  // 0. The tool's own OAuth (device flow) — the robust path. No CLI, no
  //    password, works on any machine including a headless VM.
  const oauth = require('./oauth');
  const stored = oauth.loadAuth(prefix);
  if (stored && stored.refreshToken) {
    const info = await oauth.refresh(prefix);
    conn = new jsforce.Connection({
      instanceUrl: info.instanceUrl,
      accessToken: info.accessToken,
      version: API_VERSION,
    });
    conn.$reauth = async () => {
      const fresh = await oauth.refresh(prefix);
      conn.instanceUrl = fresh.instanceUrl;
      conn.accessToken = fresh.accessToken;
    };
    console.log(`[${prefix}] Connected via OAuth (${info.instanceUrl})`);
    conn.$prefix = prefix;
    return conn;
  }

  // 1. An explicit sfdxAuthUrl (force://...) via env var. Works even on newer
  //    CLIs that mask the token in `sf org display`.
  const authUrl = process.env[`${prefix}_AUTH_URL`];
  if (authUrl && authUrl.startsWith('force://')) {
    const info = await tokenFromAuthUrl(authUrl);
    conn = new jsforce.Connection({
      instanceUrl: info.instanceUrl,
      accessToken: info.accessToken,
      version: API_VERSION,
    });
    conn.$reauth = async () => {
      const fresh = await tokenFromAuthUrl(authUrl);
      conn.instanceUrl = fresh.instanceUrl;
      conn.accessToken = fresh.accessToken;
    };
    console.log(`[${prefix}] Connected via auth URL (${info.instanceUrl})`);
    conn.$prefix = prefix;
    return conn;
  }

  const alias = resolveAlias(prefix);

  if (alias) {
    const info = await cliOrgInfo(alias);
    conn = new jsforce.Connection({
      instanceUrl: info.instanceUrl,
      accessToken: info.accessToken,
      version: API_VERSION,
    });
    conn.$reauth = async () => {
      const fresh = await cliOrgInfo(alias); // refreshes a new token
      conn.instanceUrl = fresh.instanceUrl;
      conn.accessToken = fresh.accessToken;
    };
    console.log(`[${prefix}] Connected via CLI org "${alias}" (${info.instanceUrl})`);
  } else {
    conn = new jsforce.Connection({
      loginUrl: must(`${prefix}_LOGIN_URL`),
      version: API_VERSION, // SOAP login() is only available on API v64.0 and earlier
    });
    conn.$reauth = async () => {
      await conn.login(
        must(`${prefix}_USERNAME`),
        must(`${prefix}_PASSWORD`) + (process.env[`${prefix}_TOKEN`] || '')
      );
    };
    await conn.$reauth();
    console.log(`[${prefix}] Connected as ${conn.userInfo.id}`);
  }

  conn.$prefix = prefix;
  return conn;
}

function isSessionError(err) {
  const msg = String((err && err.message) || err);
  return (
    (err && err.statusCode === 401) ||
    (err && err.errorCode === 'INVALID_SESSION_ID') ||
    msg.includes('INVALID_SESSION_ID')
  );
}

// Salesforce error codes that are DETERMINISTIC — the same request will fail
// the same way every time (bad field, malformed SOQL, validation rule, missing
// permission...). Retrying these just wastes minutes of backoff at scale, so we
// fail fast instead. Anything NOT listed here is treated as possibly transient
// and still retried, so we never lose resilience against unknown errors.
const DETERMINISTIC_CODES = new Set([
  'INVALID_FIELD', 'INVALID_TYPE', 'MALFORMED_QUERY', 'INVALID_FIELD_FOR_INSERT_UPDATE',
  'REQUIRED_FIELD_MISSING', 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'FIELD_INTEGRITY_EXCEPTION',
  'STRING_TOO_LONG', 'INVALID_EMAIL_ADDRESS', 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  'DUPLICATE_VALUE', 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', 'INSUFFICIENT_ACCESS',
  'INVALID_CROSS_REFERENCE_KEY', 'ENTITY_IS_DELETED', 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'NOT_FOUND', 'METHOD_NOT_ALLOWED',
]);

/** True when the error is worth retrying (network blip, server 5xx, rate
 *  limit, row lock, session expiry). Unknown errors default to retryable. */
function isTransient(err) {
  if (!err) return false;
  if (isSessionError(err)) return true;
  const code = err.errorCode || err.code;
  if (code && DETERMINISTIC_CODES.has(code)) return false;
  // Node network errors (transient by nature).
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  const status = err.statusCode;
  if (typeof status === 'number') {
    if (status === 429 || status >= 500) return true; // rate limited / server error
    if (status >= 400 && status < 500) return false; // other client errors are deterministic
  }
  const msg = String((err && err.message) || err);
  if (/REQUEST_LIMIT_EXCEEDED|UNABLE_TO_LOCK_ROW|QUERY_TIMEOUT|Server (Unavailable|busy)|Too Many Requests|socket hang up|network|timeout/i.test(msg)) return true;
  return true; // unknown -> assume transient, keep retrying (conservative)
}

/**
 * Runs fn with retry + exponential backoff. A 10GB run takes hours, so the
 * session WILL eventually expire mid-run - on session errors we re-login
 * against the same org and retry. Deterministic errors (bad field, validation,
 * permissions) fail fast instead of burning the full backoff budget.
 */
async function withRetry(conn, fn, { tries = 4, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isSessionError(err)) {
        console.warn(`  [${conn.$prefix}] Session expired - refreshing...`);
        await conn.$reauth();
      } else if (!isTransient(err)) {
        // No point retrying — the same request will fail the same way.
        break;
      }
      if (attempt === tries) break;
      const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
      console.warn(`  retry ${attempt}/${tries - 1}${label ? ` (${label})` : ''}: ${(err && err.message) || err} - waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Runs a SOQL query and follows nextRecordsUrl until all records are in. */
async function queryAllRecords(conn, soql) {
  const out = [];
  let res = await withRetry(conn, () => conn.query(soql), { label: 'query' });
  out.push(...res.records);
  while (!res.done) {
    const nextUrl = res.nextRecordsUrl;
    res = await withRetry(conn, () => conn.queryMore(nextUrl), { label: 'queryMore' });
    out.push(...res.records);
  }
  return out;
}

function httpsGetToFile(url, headers, destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode === 401) {
        res.resume();
        return reject(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
      }
      if (res.statusCode >= 300) {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`)));
        return;
      }
      const out = fs.createWriteStream(destPath);
      let bytes = 0;
      res.on('data', (c) => (bytes += c.length));
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve(bytes));
      res.pipe(out);
    });
    req.on('error', reject);
  });
}

function versionDataUrl(conn, versionId) {
  return `${conn.instanceUrl}/services/data/v${conn.version}/sobjects/ContentVersion/${versionId}/VersionData`;
}

/** Streams a ContentVersion binary straight to disk. Returns bytes written. */
async function downloadVersionToFile(conn, versionId, destPath) {
  return withRetry(
    conn,
    () =>
      httpsGetToFile(versionDataUrl(conn, versionId), { Authorization: `Bearer ${conn.accessToken}` }, destPath),
    { label: `download ${versionId}` }
  );
}

/**
 * Opens a ContentVersion's binary as a readable stream instead of writing it
 * to disk. Resolves with the response object, which the caller must consume
 * or destroy — an abandoned response holds the socket open.
 */
function openVersionStream(conn, versionId) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      versionDataUrl(conn, versionId),
      { headers: { Authorization: `Bearer ${conn.accessToken}` } },
      (res) => {
        if (res.statusCode === 401) {
          res.resume();
          return reject(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
        }
        if (res.statusCode >= 300) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`)));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
  });
}

function headerSafe(name) {
  return String(name).replace(/["\r\n]/g, '_');
}

/**
 * `openBody` returns the Readable carrying the binary. Taking a factory rather
 * than a stream matters for retries: a consumed stream cannot be replayed, so
 * each attempt asks for a fresh one (a new file handle, or a new GET against
 * the source org).
 */
function multipartPost(conn, metadata, openBody, fileSize) {
  return new Promise((resolve, reject) => {
    const boundary = `sfb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    // entity_content's Content-Type must be its own header line, not a
    // parameter on Content-Disposition - otherwise Salesforce rejects the
    // request with INVALID_MULTIPART_REQUEST.
    const metaPart = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="entity_content"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n`,
      'utf8'
    );
    const filePartHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `Content-Disposition: form-data; name="VersionData"; filename="${headerSafe(metadata.PathOnClient)}"\r\n\r\n`,
      'utf8'
    );
    const closing = Buffer.from(`\r\n--${boundary}--`, 'utf8');

    const url = new URL(`${conn.instanceUrl}/services/data/v${conn.version}/sobjects/ContentVersion/`);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': metaPart.length + filePartHeader.length + fileSize + closing.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 401) {
            return reject(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
          }
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) {
            /* non-JSON error body - handled below */
          }
          if (res.statusCode >= 300 || !json || json.success === false) {
            return reject(new Error(`Upload failed (HTTP ${res.statusCode}): ${body.slice(0, 500)}`));
          }
          resolve(json); // { id, success, errors }
        });
      }
    );
    req.on('error', reject);
    req.write(metaPart);
    req.write(filePartHeader);

    Promise.resolve()
      .then(openBody)
      .then((stream) => {
        // Content-Length was already sent, so a body of the wrong length would
        // hang or corrupt the request. Counting lets us fail with a clear
        // message instead.
        let sent = 0;
        stream.on('data', (c) => (sent += c.length));
        stream.on('error', (err) => {
          req.destroy();
          reject(err);
        });
        stream.on('end', () => {
          if (sent !== fileSize) {
            req.destroy();
            return reject(new Error(`size mismatch: expected ${fileSize} bytes, streamed ${sent}`));
          }
          req.write(closing);
          req.end();
        });
        stream.pipe(req, { end: false });
      })
      .catch((err) => {
        req.destroy();
        reject(err);
      });
  });
}

/**
 * Inserts a ContentVersion via multipart POST, streaming the binary from
 * disk. One code path for every size - multipart works from 1 byte up to
 * the 2GB REST ceiling, so there is no separate base64 branch to maintain.
 */
async function uploadVersionMultipart(conn, metadata, filePath, fileSize) {
  return withRetry(conn, () => multipartPost(conn, metadata, () => fs.createReadStream(filePath), fileSize), {
    label: `upload ${metadata.PathOnClient}`,
  });
}

/**
 * Copies one ContentVersion straight from the source org into the target org,
 * never touching local disk. Trades the download phase's resumability for not
 * needing disk equal to the data volume: a dropped connection restarts this
 * file rather than resuming it, so the disk path stays the default.
 *
 * Both orgs can expire mid-transfer, and each retry re-opens the source.
 */
async function streamVersionBetweenOrgs(source, target, versionId, metadata, size) {
  return withRetry(
    target,
    async () => {
      try {
        return await multipartPost(target, metadata, () => openVersionStream(source, versionId), size);
      } catch (err) {
        // A 401 here may belong to either org; withRetry only knows about the
        // target, so refresh the source ourselves before it retries.
        if (isSessionError(err) && source.$reauth) await source.$reauth();
        throw err;
      }
    },
    { label: `stream ${metadata.PathOnClient}` }
  );
}

/** Simple concurrency limiter - no extra dependency needed. */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

module.exports = {
  connect,
  withRetry,
  isTransient,
  queryAllRecords,
  downloadVersionToFile,
  openVersionStream,
  uploadVersionMultipart,
  streamVersionBetweenOrgs,
  createLimiter,
};
