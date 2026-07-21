# Bulk File & Record Migration (org → org)

Migrates **records and files** between two Salesforce orgs. Files stream to
disk and upload via multipart (up to **2 GB/file**), well past the Apex 12 MB
and SFDMU 37 MB ceilings. Records upsert on a `Legacy_*_Id__c` external Id
with lookup/master-detail remapping. Everything is resumable.

Authentication uses the **Salesforce CLI** — no passwords stored. (A
username/password `.env` still works as a fallback.)

## Quick start

```bash
npm install
node cli.js init        # pick source + target CLI orgs (writes migration.config.json)
node cli.js doctor      # preflight: what's ready, what's missing
node cli.js migrate     # records + files, end to end
```

Prefer buttons? `npm run ui` → http://localhost:4599

## Commands

| Command | What it does |
|---------|--------------|
| `init` | Interactive setup — pick your two CLI orgs. |
| `doctor` | Preflight checks: Node, CLI, connections, external Id fields, storage, disk. |
| `records` | Migrate records (Account/Contact/Opportunity/Case by default). |
| `run` | Migrate files: manifest → download → upload → link → verify. |
| `migrate` | `records` then `run`, end to end. |
| `stats` | Read-only: source file count + total size. |
| `verify` | Show current state and any failures. |
| `manifest` / `download` / `upload` / `link` | Individual file phases (for control / retries). |

Options: `--limit N`, `--where "SOQL"`, `--all-versions`, `--concurrency N`, `--force`.

## Configuration

`node cli.js init` writes `migration.config.json`:
```json
{ "sourceOrg": "sourceOrg", "targetOrg": "targetOrg" }
```
**Field mapping is automatic:** for each object the tool describes both orgs
and copies the intersection of writable fields — formulas, auto-numbers,
system fields, and unmapped lookups are excluded automatically; record types
are matched by DeveloperName; State/Country picklists are sent as ISO codes.
To override, set an explicit `fields` array per object.

To customize which objects the `records` command migrates, add an `objects`
array (see `lib/records.js` `DEFAULT_OBJECTS` for the shape). Custom objects
need a `Legacy_<Object>_Id__c` external Id field on the target and, for
master-detail children, their parent listed first.

## Where it runs

- **Local machine:** see `../GUIDE_A_LOCAL_MACHINE.md`
- **Cloud VM (unattended):** see `../GUIDE_B_VIRTUAL_MACHINE.md` and
  `CLOUD_DEPLOY_AZURE.md`. `vm-setup.sh` installs everything on a fresh Ubuntu VM.

## Auth options

- **OAuth device flow (recommended):** `node cli.js login`. One-time Connected
  App, then authorize both orgs in a browser (works on a VM too — enter a code
  on your own browser). No CLI, no passwords; refresh tokens stored in `.auth/`
  (gitignored). Setup: `../docs/OAUTH_SETUP.md`.
- **CLI aliases:** `node cli.js init` picks two Salesforce CLI orgs. Simplest on
  your own machine, but recent CLI versions mask the token (see next option).
- **Auth URL (headless / newer CLI):** set `SOURCE_AUTH_URL` / `TARGET_AUTH_URL`
  to each org's `sfdxAuthUrl` (`force://…`).
- **Username/password (`.env`):** the original fallback (`cp .env.example .env`).

The tool tries them in this order: `.auth/` (OAuth) → `*_AUTH_URL` → CLI alias
→ `.env`.

## Notes

- Needs **Node.js 22+** (older versions crash on a jsforce dependency).
- Runs are logged to `work/logs/`. `work/` is the resumable state — delete it
  for a clean restart.
- **Target org File Storage must be ≥ your file volume** (Setup → Storage
  Usage). Files over 2 GB can't go through the API.
- `.env`, `work/`, and `migration.config.json` are gitignored.
