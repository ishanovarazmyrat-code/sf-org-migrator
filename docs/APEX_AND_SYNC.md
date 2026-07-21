# Apex Batch Path & Ongoing Sync (advanced)

The **Node tool** (`bulk-file-migration/`) is the main way to migrate — it
does records + files with no Connected App or Named Credential. Use the Apex
path here only if you specifically want migration to run **inside the org**
(server-side, no external machine) or you want the **hourly sync schedulers**.

The Apex classes are deployed by the `sfdx-package` (see `sfdx-package/README.md`).

## 1. Source org — create a Connected App (External Client App)

Setup → **External Client App Manager** → **New External Client App**:
- Enable **OAuth**; Callback URL `https://login.salesforce.com/services/oauth2/success`
- OAuth scope **Manage user data via APIs (api)**; check **Enable Client Credentials Flow**
- Save → **OAuth Policies** → set **Run As** to a user with access
- Copy the **Consumer Key** and **Consumer Secret**

## 2. Target org — create the Named Credential

Setup → **Named Credentials** → **External Credentials** → **New**:
- OAuth 2.0, **Client Credentials with Client Secret Flow**
- Identity Provider URL `https://<source-domain>.my.salesforce.com/services/oauth2/token`, Scope blank
- **Principals** → **New** → paste the Consumer Key + Secret

Then **Named Credentials** tab → **New**: Name `Source_Org`, URL
`https://<source-domain>.my.salesforce.com`, External Credential = the one above.

Finally, Setup → **Permission Sets** → new set → **External Credential
Principal Access** → add the credential → assign it to yourself.

## 3. Run the record + file migration

Target org → Developer Console → Execute Anonymous:

```apex
SourceOrgAccountFileMigrationBatch.run();
SourceOrgContactFileMigrationBatch.run();
SourceOrgOpportunityFileMigrationBatch.run();
SourceOrgCaseFileMigrationBatch.run();
```

Watch **Setup → Apex Jobs**. Re-running is safe (upsert on `Legacy_*_Id__c`).
Files over ~12 MB are skipped here — use the Node tool for those.

`runWhere('...')` migrates a subset, e.g.
`SourceOrgAccountFileMigrationBatch.runWhere('Industry = \'Technology\'');`

## 4. Ongoing hourly sync (optional)

The `Migration_Sync_State__c` custom setting and the scheduler classes are
installed by the package deploy. Start the schedules (target org, Execute
Anonymous):

```apex
System.schedule('Account Sync - Hourly',     '0 0 * * * ?',  new AccountSyncScheduler());
System.schedule('Opportunity Sync - Hourly', '0 15 * * * ?', new OpportunitySyncScheduler());
System.schedule('Contact Sync - Hourly',     '0 30 * * * ?', new ContactSyncScheduler());
System.schedule('Case Sync - Hourly',        '0 45 * * * ?', new CaseSyncScheduler());
```

Each run migrates only records changed since the last run (per-object
watermark in the custom setting). Check **Setup → Scheduled Jobs**; stop a job
there with **Del**.

## Custom objects

For a custom object (e.g. `Invoice__c`): add a `Legacy_<Object>_Id__c` field
(Text(18), External Id, Unique) on the target, add a `<Object>_Last_Sync__c`
field on the custom setting, and add a batch class + scheduler following the
same pattern as the standard-object classes. For a master-detail child,
migrate its parent first and set the required parent field by resolving the
parent's `Legacy_*_Id__c`.
