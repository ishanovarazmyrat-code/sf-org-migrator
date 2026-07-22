# Salesforce Org-to-Org Migration

[![npm](https://img.shields.io/npm/v/sf-org-migrator)](https://www.npmjs.com/package/sf-org-migrator)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Migrates **records** and their **Files** from one Salesforce org to another.

## Install

```bash
npm install -g sf-org-migrator
```

Then run `sf-org-migrator <command>` from any folder (e.g. `sf-org-migrator login source`).
The commands below use `node cli.js` — with the global install, replace that with
`sf-org-migrator`.

Out of the box it handles **Account, Contact, Opportunity, and Case**; custom
objects are supported with a little config (see *Custom objects* below). Files
go up to **2 GB each**, and everything is resumable.

## Pick your path

- **Run it from your computer** → [`GUIDE_A_LOCAL_MACHINE.md`](GUIDE_A_LOCAL_MACHINE.md)
- **Run it on a cloud VM (unattended)** → [`GUIDE_B_VIRTUAL_MACHINE.md`](GUIDE_B_VIRTUAL_MACHINE.md)

Both use the same short flow:

**1. Install the Salesforce package in your TARGET org** (fields + classes +
custom setting + permission set) — **one click**:

> https://login.salesforce.com/packaging/installPackage.apexp?p0=04tJ6000000pGxfIAE

Log into the target org, choose **Install for All Users**, then assign access:

```bash
sf org assign permset --name Migration_Access --target-org targetOrg
```

*(Or deploy from source instead: `cd sfdx-package && sf project deploy start --source-dir force-app --target-org targetOrg`.)*

**2. Run the tool:**

```bash
cd bulk-file-migration
npm install
node cli.js login source   # authorize each org via OAuth (no CLI, no password)
node cli.js login target   #   — one-time External Client App per org, see docs/OAUTH_SETUP.md
node cli.js doctor         # preflight: what's ready, what's missing
node cli.js migrate        # records + files, end to end
```

**Auth:** `login` (OAuth device flow) is the recommended path — a one-time
External Client App **per org** (`docs/OAUTH_SETUP.md`), works on any machine or
VM, stores no passwords. Alternatives: `node cli.js init` (Salesforce CLI orgs)
or a username/password `.env` (`bulk-file-migration/.env.example`).

Prefer buttons? `npm run ui` → http://localhost:4599

## What's in here

| Folder / file | What it is |
|---------------|------------|
| `bulk-file-migration/` | The Node tool — records + files, CLI auth, `doctor`, web UI. |
| `sfdx-package/` | One-deploy Salesforce metadata: batch classes, schedulers, `Legacy_*_Id__c` fields, sync custom setting. |
| `GUIDE_A_LOCAL_MACHINE.md` | Full walkthrough — running on your computer. |
| `GUIDE_B_VIRTUAL_MACHINE.md` | Full walkthrough — running on an Azure VM. |
| `docs/APEX_AND_SYNC.md` | Advanced: the in-org Apex path + hourly sync schedulers (needs a Named Credential). |

## Custom objects

Out of the box the tool migrates Account, Contact, Opportunity, and Case. To
add a custom object (e.g. `Invoice__c`):

1. On the **target** org, add a `Legacy_Invoice_Id__c` field (Text(18),
   External Id, Unique) and grant access to it (add it to the
   `Migration_Access` permission set).
2. In `bulk-file-migration/migration.config.json`, add an `objects` array
   entry:
   ```json
   { "name": "Invoice__c", "externalId": "Legacy_Invoice_Id__c",
     "fields": ["Name", "Amount__c"], "parents": { "Account__c": "Account" } }
   ```
   List a master-detail/required parent's object **before** the child. Files
   linked to the custom object are picked up automatically.

For the in-org Apex path, a custom object also needs its own batch class
following the same pattern as the standard-object classes — see
`docs/APEX_AND_SYNC.md`.

## Before a real run

- **Target org File Storage ≥ your file volume** (Setup → Storage Usage). A
  Developer Edition org (~20 MB) is for testing only.
- Disk on the machine running the tool ≥ 2× the file volume.
- Files over 2 GB can't go through the API.
- Needs **Node.js 22+** and the **Salesforce CLI**.

## Security & license

Credential handling, data-at-rest guidance, and disclosure: see
[`SECURITY.md`](SECURITY.md). Licensed under the [MIT License](LICENSE).
