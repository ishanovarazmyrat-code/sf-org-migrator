# Deployable Package (one deploy installs everything)

Instead of hand-creating fields and the custom setting, this SFDX package
installs it all into the target org in **one command**:

- 5 batch classes + 4 sync schedulers
- External Id fields on **Account, Contact, Opportunity, Case**
  (`Legacy_*_Id__c`, Text(18), External Id, Unique)
- The `Migration_Sync_State__c` custom setting with its per-object fields
- The **`Migration_Access` permission set** (field access for the above)

## Install

**Easiest — one-click unlocked package** (installs into any org, incl. production):

> https://login.salesforce.com/packaging/installPackage.apexp?p0=04tJ6000000pGxVIAU

Log into the target org, choose **Install for All Users**, then assign the
permission set:

```bash
sf org assign permset --name Migration_Access --target-org targetOrg
```

**Or deploy from source:**

```bash
sf org login web --alias targetOrg
cd sfdx-package
sf project deploy start --source-dir force-app --target-org targetOrg
sf org assign permset --name Migration_Access --target-org targetOrg
```

Either way — no manual field creation, no manual custom setting.

> **Why the permission set:** a field deployed via metadata has no
> field-level security by default, so it stays invisible (SOQL says "No such
> column") until a profile or permission set grants access. `Migration_Access`
> does that — assign it to whoever runs the migration.

## Still one manual step: the Named Credential (Apex batch path only)

The Apex batches reach the source org through a Named Credential, which needs
a Connected App in the source org. Set that up once — see
`../docs/APEX_AND_SYNC.md` (sections 1–2).

> The large-file **Node tool does NOT need this** — it connects to both orgs
> directly via the Salesforce CLI (`node cli.js init`).

## Custom objects (e.g. `Invoice__c`)

Custom objects are org-specific, so they aren't shipped here. To migrate one:

1. Add a `Legacy_<Object>_Id__c` field (Text(18), External Id, Unique) on the
   custom object in the target org, and add it to the `Migration_Access`
   permission set.
2. For the in-org Apex path, add a batch class (and, for sync, a scheduler +
   a `<Object>_Last_Sync__c` field on the custom setting) following the same
   pattern as the standard-object classes.
3. For a master-detail child, migrate its parent first and set the required
   parent field by resolving the parent's `Legacy_*_Id__c`.

(The Node tool migrates custom objects with config only — see the main README.)
