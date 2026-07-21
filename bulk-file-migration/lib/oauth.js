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
 * Runs the OAuth 2.0 device flow. Prints a URL + code for the user to approve
 * in any browser, then polls until authorized. Returns the token response
 * (access_token, refresh_token, instance_url, ...).
 */
async function deviceLogin(clientId, clientSecret, loginHost, label) {
  const startParams = {
    response_type: 'device_code',
    client_id: clientId,
    scope: 'api refresh_token',
  };
  if (clientSecret) startParams.client_secret = clientSecret;
  const start = await formPost(loginHost, '/services/oauth2/token', startParams);
  if (!start.json.device_code) {
    throw new Error(`Could not start login for ${label}: ${JSON.stringify(start.json)}`);
  }

  console.log(`\n  [${label}] Open this URL and enter the code:`);
  console.log(`    ${start.json.verification_uri}`);
  console.log(`    code: ${start.json.user_code}`);
  console.log('  Waiting for you to authorize...');

  const interval = (start.json.interval || 5) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    const pollParams = {
      grant_type: 'device',
      client_id: clientId,
      code: start.json.device_code,
    };
    if (clientSecret) pollParams.client_secret = clientSecret;
    const poll = await formPost(loginHost, '/services/oauth2/token', pollParams);
    if (poll.json.access_token) return poll.json;
    const err = poll.json.error;
    if (err && err !== 'authorization_pending' && err !== 'slow_down') {
      throw new Error(`Login failed for ${label}: ${poll.json.error_description || err}`);
    }
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

/**
 * Uses the stored refresh token for `prefix` to get a fresh access token.
 * Handles refresh-token rotation: if Salesforce issues a new refresh token
 * (External Client Apps rotate by default), we save it so the next call works.
 */
async function refresh(prefix) {
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

module.exports = { deviceLogin, saveAuth, loadAuth, refresh, AUTH_DIR };
