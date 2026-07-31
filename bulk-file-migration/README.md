# Bulk File & Record Migration (org → org)

Migrates **records and files** between two Salesforce orgs. Files stream to
disk and upload via multipart (up to **2 GB/file**). Records upsert on a
`Legacy_*_Id__c` external Id with lookup/master-detail remapping. Everything
is resumable.

Authentication is the tool's own **OAuth device flow** — no passwords, and no
Salesforce CLI needed, so it works on a headless VM. CLI aliases, an auth URL,
and a username/password `.env` remain as fallbacks.

## Quick start

```bash
npm install -g sf-org-migrator
```

State (`work/`, `.auth/`, config) lives in the directory you run from, like
git — so make one for each migration:

```bash
mkdir my-migration && cd my-migration
sf-org-migrator login source   # prints a URL + code to approve in a browser
sf-org-migrator login target
sf-org-migrator doctor         # preflight: what's ready, what's missing
sf-org-migrator migrate        # records + files, end to end
```

Prefer buttons? `sf-org-migrator ui` → http://localhost:4599

Working from a clone instead? Run `npm install` in `bulk-file-migration/` and
use `node cli.js …` in place of `sf-org-migrator …`.

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
| `failures` | Group the failure reports by cause and say which are worth retrying. |
| `manifest` / `download` / `upload` / `link` | Individual file phases (for control / retries). |

Options: `--limit N`, `--where "SOQL"`, `--all-versions`, `--concurrency N`, `--force`,
`--stream`. Also `--version` and `--help`.

### `--stream`: skip the local disk

By default every binary is downloaded to `work/data/` and then uploaded, so a
run needs free disk equal to the data volume — and an interrupted run resumes
from what is already on disk. `--stream` sends each file straight from the
source org to the target in one hop:

```bash
sf-org-migrator run --stream
```

The trade is resumability. There is no half-finished file on disk to resume
from, so an interrupted transfer restarts that file from the beginning. Use it
when disk is the constraint; leave it off for long runs over shaky links.

It also saves a hop. Measured org-to-org on a 1GB file, from a VM in the same
region as the orgs: **136s streaming vs 329s from a laptop two countries away**
— the machine you run on, and how it reaches the orgs, matters more than
anything the tool does.

The web UI has the same option as a checkbox on the Files card.

## Configuration

`sf-org-migrator init` writes `migration.config.json`:
```json
{ "sourceOrg": "sourceOrg", "targetOrg": "targetOrg" }
```
**Field mapping is automatic:** for each object the tool describes both orgs
and copies the intersection of writable fields — formulas, auto-numbers,
system fields, and unmapped lookups are excluded automatically; record types
are matched by DeveloperName; State/Country picklists are sent as ISO codes.
To override, set an explicit `fields` array per object.

To customize which objects the `records` command migrates, add an `objects`
array (see `lib/records.js` `DEFAULT_OBJECTS` for the shape).

### Adding a custom object

Three steps, and the second one is the one people miss. Validated end to end
on a `Shipment__c` with a lookup, a picklist and a validation rule.

**1. Create the external Id field on the target.** `Legacy_<Object>_Id__c`,
Text(18), External Id, Unique. The packaged fields only cover the standard
objects, so a custom object needs its own.

**2. Grant yourself field-level access to it.** A newly created custom field
is invisible to every profile until something grants it — and "invisible"
here is literal: it does not appear in the object's describe at all, so the
tool cannot see it either. Put it in a permission set (alongside the object's
other fields) and assign that to whoever runs the migration. Skip this and the
migration stops with a message naming the field.

**3. Map its lookups in `parents`.** A lookup holds a record Id from the
*source* org, which means nothing in the target. Listing it under `parents`
tells the tool which object to re-point it at; leave it out and the field is
dropped, silently but by design.

```json
{
  "name": "Shipment__c",
  "externalId": "Legacy_Shipment_Id__c",
  "fields": "auto",
  "parents": { "Account__c": "Account" }
}
```

List parents before children in the `objects` array — the migration processes
them in order, and a child whose parent has not been migrated yet is skipped
and reported rather than pointed at nothing.

**Duplicate rules are bypassed by default.** A migration replicates records
that already exist in the source, so duplicate alerts would fail the insert
with `DUPLICATES_DETECTED`; the tool sends `Sforce-Duplicate-Rule-Header` on
its own requests instead of asking you to deactivate rules in Setup. Rules
whose action is **Block** still block. Set `"allowDuplicates": false` in
`migration.config.json` to enforce the target's rules.

## Where it runs

- **Local machine:** see `../GUIDE_A_LOCAL_MACHINE.md`
- **Cloud VM (unattended):** see `../GUIDE_B_VIRTUAL_MACHINE.md` and
  `CLOUD_DEPLOY_AZURE.md`. `vm-setup.sh` installs everything on a fresh Ubuntu VM.

## Auth options

- **OAuth device flow (recommended):** `sf-org-migrator login source` /
  `login target`. One-time External Client App per org, then authorize both orgs in a browser (works on a VM too — enter a code
  on your own browser). No CLI, no passwords; refresh tokens stored in `.auth/`
  (gitignored). Setup: `../docs/OAUTH_SETUP.md`.
- **CLI aliases:** `sf-org-migrator init` picks two Salesforce CLI orgs. Simplest on
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
- **Partial failures are reported, not just counted.** Records, files, or links
  that fail (or are skipped because a parent isn't there yet) are written to a
  CSV under `work/errors/` with the source Id and reason. Fix the cause and
  re-run — records upsert is idempotent, files resume from the manifest.
- **`failures` turns those reports into a decision.** A 400-row CSV usually has
  two or three distinct causes; the command groups them and marks each one
  *worth retrying* (transient, or a parent that just needs migrating first) or
  *needs a fix first* (validation, permissions, a Block duplicate rule), then
  prints the phases to re-run in the right order. The web UI shows the same
  thing with a one-click retry.
- Deterministic errors (bad field, validation, permissions) fail fast; only
  transient errors (network, rate limit, server 5xx, session expiry) are retried.
- **Target org File Storage must be ≥ your file volume** (Setup → Storage
  Usage). Files over 2 GB can't go through the API.
- `.env`, `work/`, and `migration.config.json` are gitignored.

## Development

`npm test` runs the unit test suite (`node --test`, no extra dependency) —
retry/backoff classification, the manifest's atomic save/load and byte
accounting, automatic field-mapping decisions, and OAuth token storage. CI
runs this on every push and PR alongside a syntax check.
