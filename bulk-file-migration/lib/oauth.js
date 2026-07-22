/**
 * The tool's own OAuth (device flow) — the robust auth path.
 *
 * No Salesforce CLI, no passwords: the user authorizes once in a browser
 * (works on a headless VM too — they just enter a code), and we keep a
 * refresh token to mint fresh access tokens forever after. Independent of any
 * CLI version or token masking.
 *
 * Requires a Connected App (created once, its Consumer Key put in
 * migration.config.json as "clientId"). See docs/OAUTH_SETUP.md.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const jsforce = require('jsforce');
const { URLSearchParams } = require('url');

// Stored in the current working directory (like git), so a global install
// keeps each project's tokens where you run the CLI.
const AUTH_DIR = path.join(process.cwd(), '.auth');

function formPost(host, urlPath, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request(
      {
        hostname: host,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(data);
          } catch (_) {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Starts the OAuth 2.0 device flow. Returns the start response
 * (device_code, user_code, verification_uri, interval) — the caller shows the
 * URL + code and then polls with pollDevice until authorized.
 */
async function startDevice(clientId, clientSecret, loginHost) {
  const params = { response_type: 'device_code', client_id: clientId, scope: 'api refresh_token' };
  if (clientSecret) params.client_secret = clientSecret;
  const start = await formPost(loginHost, '/services/oauth2/token', params);
  if (!start.json.device_code) {
    throw new Error(`Could not start device login: ${JSON.stringify(start.json)}`);
  }
  return start.json;
}

/**
 * Polls the device-flow token endpoint once. Returns
 * { status: 'done', token } | { status: 'pending' } | { status: 'error', error }.
 */
async function pollDevice(clientId, clientSecret, loginHost, deviceCode) {
  const params = { grant_type: 'device', client_id: clientId, code: deviceCode };
  if (clientSecret) params.client_secret = clientSecret;
  const poll = await formPost(loginHost, '/services/oauth2/token', params);
  if (poll.json.access_token) return { status: 'done', token: poll.json };
  const err = poll.json.error;
  if (err === 'authorization_pending' || err === 'slow_down') return { status: 'pending' };
  return { status: 'error', error: poll.json.error_description || err || 'unknown error' };
}

/**
 * Runs the full device flow for the CLI: prints a URL + code, then polls until
 * authorized. Returns the token response (access_token, refresh_token, ...).
 */
async function deviceLogin(clientId, clientSecret, loginHost, label) {
  const start = await startDevice(clientId, clientSecret, loginHost);

  console.log(`\n  [${label}] Open this URL and enter the code:`);
  console.log(`    ${start.verification_uri}`);
  console.log(`    code: ${start.user_code}`);
  console.log('  Waiting for you to authorize...');

  const interval = (start.interval || 5) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    const r = await pollDevice(clientId, clientSecret, loginHost, start.device_code);
    if (r.status === 'done') return r.token;
    if (r.status === 'error') throw new Error(`Login failed for ${label}: ${r.error}`);
  }
}

function saveAuth(prefix, data) {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(AUTH_DIR, `${prefix}.json`), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

function loadAuth(prefix) {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUTH_DIR, `${prefix}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

// One in-flight refresh per prefix. External Client Apps ROTATE the refresh
// token on use, so two concurrent refreshes that both read the same stored
// token race: the first rotates it, invalidating the token the second is still
// using ("expired access/refresh token"). Sharing a single promise per prefix
// makes concurrent callers (e.g. two UI requests, or SOURCE+TARGET at once)
// await the same refresh instead of racing.
const inFlight = {};

async function doRefresh(prefix) {
  const auth = loadAuth(prefix);
  if (!auth || !auth.refreshToken) {
    throw new Error(`No stored OAuth for ${prefix}. Run:  node cli.js login`);
  }
  const oauth2 = new jsforce.OAuth2({
    loginUrl: auth.instanceUrl || 'https://login.salesforce.com',
    clientId: auth.clientId,
    clientSecret: auth.clientSecret || '',
  });
  const res = await oauth2.refreshToken(auth.refreshToken);
  if (res.refresh_token && res.refresh_token !== auth.refreshToken) {
    auth.refreshToken = res.refresh_token; // rotation — keep the new one
    saveAuth(prefix, auth);
  }
  return { instanceUrl: res.instance_url, accessToken: res.access_token };
}

/**
 * Uses the stored refresh token for `prefix` to get a fresh access token.
 * Handles refresh-token rotation and de-duplicates concurrent refreshes so
 * rotation never invalidates an in-flight sibling call.
 */
function refresh(prefix) {
  if (inFlight[prefix]) return inFlight[prefix];
  const p = doRefresh(prefix).finally(() => {
    delete inFlight[prefix];
  });
  inFlight[prefix] = p;
  return p;
}

module.exports = { deviceLogin, startDevice, pollDevice, saveAuth, loadAuth, refresh, AUTH_DIR };
