# Guide A — Migration Using Your Local Machine

Run the whole migration from your own computer. This is the simplest path and
a good first test. (For large volumes or long unattended runs, use
**Guide B — Virtual Machine**.)

## What you'll do

Two orgs: **SOURCE** (migrate from) and **TARGET** (migrate to). You log in to
both with the Salesforce CLI, deploy one package to the target, then run the
tool. No Connected App, no Named Credential, no passwords in files.

---

## Step 1 — Install the tools (one time)

1. **Node.js 22 or newer** — https://nodejs.org
2. **Salesforce CLI** — https://developer.salesforce.com/tools/salesforcecli

Check:
```bash
node -v      # v22.x or higher
sf --version
```

## Step 2 — Log in to both orgs

> **Recommended:** use the tool's own OAuth login instead — `node cli.js login`
> (one-time Connected App, no CLI needed). See `docs/OAUTH_SETUP.md`. The
> Salesforce-CLI method below also works.

```bash
sf org login web --alias sourceOrg
sf org login web --alias targetOrg
```
A browser opens for each; log in. Nothing is stored by the tool — the CLI
holds the sessions.

## Step 3 — Install the target-org package (one deploy)

This creates the batch classes, the schedulers, the `Legacy_*_Id__c` external
Id fields, and the sync custom setting — so you don't create any of them by
hand:

```bash
cd sfdx-package
sf project deploy start --source-dir force-app --target-org targetOrg
sf org assign permset --name Migration_Access --target-org targetOrg
cd ..
```

The `Migration_Access` permission set grants you access to the new
`Legacy_*_Id__c` fields — without it, a freshly deployed field stays invisible
(field-level security), and `doctor` will flag it.

> Custom objects (e.g. `Invoice__c`) need their own
> `Legacy_<Object>_Id__c` field added manually (Text(18), External Id,
> Unique), since the object is specific to your org.

## Step 4 — Set up the tool

```bash
cd bulk-file-migration
npm install
node cli.js init      # pick sourceOrg and targetOrg from the list
```

## Step 5 — Check everything is ready

```bash
node cli.js doctor
```
This verifies Node, the CLI, both connections, the external Id fields, your
file volume, and free disk. Fix anything marked **FAIL** before continuing.

## Step 6 — Migrate

```bash
node cli.js migrate      # records + files, end to end
```
Or step by step: `node cli.js records`, then `node cli.js run` (files), then
`node cli.js verify`.

Every step is **resumable** — if it stops, run the same command again and it
continues where it left off. Runs are logged to `work/logs/`.

### Prefer buttons over the terminal?

```bash
npm run ui            # then open http://localhost:4599
```
A simple page with **Check / Migrate records / Migrate files / Verify**
buttons and live output.

## Step 7 — Keep your machine awake

The tool downloads files to your disk, then uploads them. Your computer must
stay **on and online** for the whole run, with free disk ≥ 2× the file volume.

---

## Checklist before a real run
- **Target org File Storage ≥ your file volume** (Setup → Storage Usage). A
  Developer Edition org (~20 MB) is testing only; gigabytes need a Production
  org or a large sandbox.
- Free disk on your machine ≥ 2× the file volume.
- Files over 2 GB can't go through the API.
- Records are migrated before files (the tool's `migrate` does this order for you).
