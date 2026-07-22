# Security

## How the tool handles credentials and data

- **OAuth (recommended path):** `node cli.js login` uses the OAuth 2.0 device
  flow. The tool never sees your password — you approve in your own browser.
  Only **refresh tokens** are stored, in `.auth/` with file mode `600`
  (directory `700`), gitignored. Delete `.auth/` to revoke local access; you
  can also revoke the app's tokens in Salesforce (Setup → Connected Apps OAuth
  Usage).
- **Salesforce CLI path:** the tool reads a short-lived access token from your
  existing CLI login. Nothing is stored by the tool.
- **`.env` fallback:** username/password + security token, stored in plain
  text in `.env` (gitignored, `chmod 600` recommended). This is the least
  secure option — prefer OAuth.
- All traffic to Salesforce is **HTTPS**. Tokens are sent only to your orgs'
  `*.salesforce.com` endpoints, never anywhere else. No telemetry, no third
  parties.

## Migrated data at rest

- Files are downloaded to the local `work/data/` directory before upload, and
  `work/manifest.json` + `work/logs/` contain record Ids, file names, and run
  logs. Treat `work/` as sensitive: it is gitignored, and you should **delete
  it after the migration is verified** (`rm -rf work`). On a VM, delete the VM.
- Logs never include tokens or passwords.

## The web UI

- `npm run ui` binds to **127.0.0.1 only** — it is not reachable from the
  network. It can only run a fixed allowlist of commands
  (`stats`, `records`, `run`, `verify`); no arbitrary input reaches a shell.
- **Hosted mode** (set `UI_ACCESS_KEY`) is opt-in for running the UI behind a
  URL. It then binds all interfaces but **requires that key on a login screen**
  before any route works (session cookie is HttpOnly + SameSite=Strict; the key
  is compared in constant time). Use a long random key and always serve over
  HTTPS. It stays single-tenant — one instance, one pair of orgs. See
  [HOSTING.md](HOSTING.md).

## Recommendations for running a real migration

- Run under a dedicated integration user whose profile limits it to the
  objects being migrated (plus the `Migration_Access` permission set).
- On a VM: SSH key auth only, restrict inbound SSH to your IP, and delete the
  VM when done (this destroys `.auth/`, `work/`, and any `.env` with it).
- Rotate/revoke the External Client App tokens after the migration if the
  app is no longer needed.

## Reporting a vulnerability

Open an issue marked "security" (or contact the maintainer privately). Please
include reproduction steps. Do not include real org credentials or customer
data in reports.
