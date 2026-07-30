/**
 * Source Org File Migration - Batch
 * ------------------------------------
 * Runs in the TARGET org. Pulls Accounts (Id + Name) and their Files from
 * the source org via a Named Credential (OAuth 2.0 Client Credentials
 * Flow) and migrates them - no external script needed.
 *
 * Setup: see SETUP_GUIDE_ORG_TO_ORG.md
 *
 * Usage (Execute Anonymous, target org):
 *   SourceOrgAccountFileMigrationBatch.run();          // default scope size (5)
 *   SourceOrgAccountFileMigrationBatch.run(10);         // custom scope size
 *
 * Notes:
 *   - Processes Accounts in small chunks (Batch Apex) to stay within Apex
 *     callout limits.
 *   - Files above 12MB are skipped (Apex callout size limit) and logged -
 *     use migrate.js for those.
 *   - Monitor progress in Setup -> Apex Jobs.
 */
public with sharing class SourceOrgAccountFileMigrationBatch implements Database.Batchable<String>, Database.AllowsCallouts, Database.Stateful {

    private static final String NAMED_CREDENTIAL = 'callout:Source_Org';
    private static final String API_VERSION = 'v64.0';
    private static final String EXTERNAL_ID_FIELD = 'Legacy_Account_Id__c';

    // Aggregate counters across all chunks (Database.Stateful keeps these alive).
    public Integer totalAccountsProcessed = 0;
    public Integer totalFilesMigrated = 0;
    public Integer totalFilesSkipped = 0;
    public Integer totalErrors = 0;
    /** Records the target org refused (FLS, validation, duplicate rules). */
    public Integer failedUpserts = 0;
    public List<String> errorLog = new List<String>();

    public class MigrationException extends Exception {}

    // Optional: restrict the run to a specific set of source Account Ids,
    // OR a custom SOQL WHERE clause. Both null/empty means "migrate every
    // Account in the source org".
    private List<String> restrictToAccountIds;
    // A SOQL filter for the query sent to the SOURCE org over the Named
    // Credential — not a query against this org. It is supplied by whoever
    // schedules the batch (Apex execute rights), and it can only reach data
    // the Named Credential is already authenticated for. Escaping it would
    // defeat its purpose: being a filter expression is the point.
    private String customWhereClause;

    public SourceOrgAccountFileMigrationBatch() {
        this.restrictToAccountIds = null;
        this.customWhereClause = null;
    }

    public SourceOrgAccountFileMigrationBatch(List<String> sourceAccountIds) {
        this.restrictToAccountIds = sourceAccountIds;
        this.customWhereClause = null;
    }

    private SourceOrgAccountFileMigrationBatch(String whereClause, Boolean isWhereClause) {
        this.restrictToAccountIds = null;
        this.customWhereClause = whereClause;
    }

    /** Kick off the batch job with the default scope size (5 Accounts per chunk). */
    public static Id run() {
        return run(5);
    }

    /** Kick off the batch job with a custom scope size (Accounts processed per chunk). */
    public static Id run(Integer scopeSize) {
        return Database.executeBatch(new SourceOrgAccountFileMigrationBatch(), scopeSize);
    }

    /**
     * Kick off the batch job for a specific list of source Account Ids only
     * (e.g. migrate 29 out of 79 Accounts), using the default scope size.
     */
    public static Id run(List<String> sourceAccountIds) {
        return run(sourceAccountIds, 5);
    }

    /** Same as above, with a custom scope size. */
    public static Id run(List<String> sourceAccountIds, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgAccountFileMigrationBatch(sourceAccountIds), scopeSize);
    }

    /**
     * Kick off the batch job using ANY custom SOQL WHERE clause on Account
     * in the SOURCE org - full flexibility to filter however needed, e.g.:
     *   SourceOrgAccountFileMigrationBatch.runWhere('Industry = \'Technology\'');
     *   SourceOrgAccountFileMigrationBatch.runWhere('CreatedDate = LAST_N_DAYS:30');
     *   SourceOrgAccountFileMigrationBatch.runWhere('Name LIKE \'Acme%\'');
     * Do not include the word "WHERE" itself - just the condition.
     */
    public static Id runWhere(String whereClause) {
        return runWhere(whereClause, 5);
    }

    /** Same as above, with a custom scope size. */
    public static Id runWhere(String whereClause, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgAccountFileMigrationBatch(whereClause, true), scopeSize);
    }

    /**
     * start(): fetches every source Account Id via callout (paginated if
     * needed), and hands them to execute() in chunks of the configured
     * scope size.
     */
    /**
     * The Named Credential is created by the admin, not shipped by the package
     * — its endpoint is a different source org for every customer. When it is
     * missing, the callout below fails inside execute(), where the chunk
     * handler catches it and the run still reports "complete". Checking here,
     * once, turns that into a message that says what to do.
     */
    private void assertNamedCredentialExists() {
        // Tests supply an HttpCalloutMock, so no Named Credential is involved
        // and there is no DML that could create one from Apex.
        if (Test.isRunningTest()) {
            return;
        }
        String devName = NAMED_CREDENTIAL.substringAfter('callout:');
        if ([SELECT COUNT() FROM NamedCredential WHERE DeveloperName = :devName] == 0) {
            throw new MigrationException(
                'Named Credential "' + devName + '" does not exist in this org. Create it under ' +
                'Setup -> Named Credentials, pointing at the source org, before running the migration.'
            );
        }
    }

    public Iterable<String> start(Database.BatchableContext bc) {
        assertNamedCredentialExists();
        String soql = 'SELECT Id FROM Account';
        if (customWhereClause != null && customWhereClause.trim() != '') {
            soql += ' WHERE ' + customWhereClause;
        } else if (restrictToAccountIds != null && !restrictToAccountIds.isEmpty()) {
            soql += ' WHERE Id IN (\'' + String.join(restrictToAccountIds, '\',\'') + '\')';
        }
        List<Object> sourceAccounts = queryRecords(soql);
        List<String> ids = new List<String>();
        for (Object o : sourceAccounts) {
            Map<String, Object> rec = (Map<String, Object>) o;
            ids.add((String) rec.get('Id'));
        }
        System.debug('Batch start: ' + ids.size() + ' source Account Id(s) to process.');
        return ids;
    }

    /** execute(): migrates one chunk of Accounts (and their Files) per transaction. */
    public void execute(Database.BatchableContext bc, List<String> scope) {
        try {
            // ================================================================
            // PHASE 1 - ALL CALLOUTS FIRST. Apex does not allow a callout
            // after a DML statement in the same transaction ("uncommitted
            // work pending" error), so every HTTP callout to the source org
            // must happen before any local DML (Account upsert, ContentVersion
            // insert) below.
            // ================================================================
            List<Object> sourceAccounts = queryRecords(
                'SELECT Id, Name FROM Account WHERE Id IN (\'' +
                String.join(scope, '\',\'') + '\')'
            );

            List<String> sourceAccountIds = new List<String>();
            for (Object o : sourceAccounts) {
                sourceAccountIds.add((String) ((Map<String, Object>) o).get('Id'));
            }

            List<Object> links = new List<Object>();
            if (!sourceAccountIds.isEmpty()) {
                String idList = '\'' + String.join(sourceAccountIds, '\',\'') + '\'';
                links = queryRecords(
                    'SELECT ContentDocumentId, LinkedEntityId, ContentDocument.Title ' +
                    'FROM ContentDocumentLink WHERE LinkedEntityId IN (' + idList + ')'
                );
            }

            // For each link: figure out (via local SOQL - not a callout, safe
            // anytime) how many versions are already migrated, then fetch via
            // callout only the versions that are actually missing.
            Map<String, List<Object>> contentDocToNewVersions = new Map<String, List<Object>>();
            Map<String, Id> contentDocToExistingTargetDocId = new Map<String, Id>();
            Map<String, String> contentDocToTitle = new Map<String, String>();
            Map<String, String> contentDocToSourceAccountId = new Map<String, String>();
            Map<String, Blob> versionIdToBlob = new Map<String, Blob>();

            for (Object o : links) {
                Map<String, Object> link = (Map<String, Object>) o;
                String contentDocumentId = (String) link.get('ContentDocumentId');
                String sourceAccountId = (String) link.get('LinkedEntityId');
                Map<String, Object> doc = (Map<String, Object>) link.get('ContentDocument');
                String title = (String) doc.get('Title');

                contentDocToTitle.put(contentDocumentId, title);
                contentDocToSourceAccountId.put(contentDocumentId, sourceAccountId);

                // Local SOQL - not a callout, safe to run at any point.
                Id existingTargetDocId = null;
                Integer existingVersionCount = 0;
                // NOTE: at this point we don't yet know the target Account Id
                // (Accounts haven't been upserted yet), so we match purely by
                // Title across the whole target org. This mirrors the
                // matching approach used elsewhere in this class.
                for (ContentVersion cv : [
                    SELECT ContentDocumentId
                    FROM ContentVersion
                    WHERE Title = :title WITH USER_MODE
                    LIMIT 1
                ]) {
                    existingTargetDocId = cv.ContentDocumentId;
                }
                if (existingTargetDocId != null) {
                    existingVersionCount = [
                        SELECT COUNT()
                        FROM ContentVersion
                        WHERE ContentDocumentId = :existingTargetDocId WITH USER_MODE
        ];
                    contentDocToExistingTargetDocId.put(contentDocumentId, existingTargetDocId);
                }

                List<Object> versions = queryRecords(
                    'SELECT Id, Title, PathOnClient, FileExtension, VersionNumber, ContentSize ' +
                    'FROM ContentVersion WHERE ContentDocumentId = \'' + contentDocumentId + '\' ' +
                    'ORDER BY VersionNumber ASC'
                );

                if (versions.isEmpty() || existingVersionCount >= versions.size()) {
                    continue; // nothing new to migrate for this file
                }

                List<Object> newVersions = new List<Object>();
                for (Integer i = existingVersionCount; i < versions.size(); i++) {
                    Map<String, Object> v = (Map<String, Object>) versions[i];
                    Long contentSize = v.get('ContentSize') != null
                        ? Long.valueOf(String.valueOf(v.get('ContentSize')))
                        : 0;

                    if (contentSize > 12 * 1024 * 1024) {
                        errorLog.add(
                            'SKIPPED (too large for Apex callout, use migrate.js): "' +
                            title + '" (' + contentSize + ' bytes)'
                        );
                        totalFilesSkipped++;
                        continue;
                    }

                    String versionId = (String) v.get('Id');
                    versionIdToBlob.put(versionId, fetchVersionData(versionId)); // callout
                    newVersions.add(v);
                }

                if (!newVersions.isEmpty()) {
                    contentDocToNewVersions.put(contentDocumentId, newVersions);
                }
            }

            // ================================================================
            // PHASE 2 - ALL DML AFTER THIS POINT. No more callouts below.
            // ================================================================
            Map<String, Id> sourceIdToTargetId = migrateAccounts(sourceAccounts);

            for (String contentDocumentId : contentDocToNewVersions.keySet()) {
                String sourceAccountId = contentDocToSourceAccountId.get(contentDocumentId);
                Id targetAccountId = sourceIdToTargetId.get(sourceAccountId);
                String title = contentDocToTitle.get(contentDocumentId);

                if (targetAccountId == null) {
                    totalFilesSkipped++;
                    continue;
                }

                Id targetContentDocumentId = contentDocToExistingTargetDocId.get(contentDocumentId);
                List<Object> newVersions = contentDocToNewVersions.get(contentDocumentId);
                Integer migratedCount = 0;

                for (Object o : newVersions) {
                    Map<String, Object> v = (Map<String, Object>) o;
                    String versionId = (String) v.get('Id');
                    String versionTitle = (String) v.get('Title');
                    String pathOnClient = (String) v.get('PathOnClient');

                    ContentVersion cv = new ContentVersion();
                    cv.Title = versionTitle;
                    cv.PathOnClient = pathOnClient;
                    cv.VersionData = versionIdToBlob.get(versionId);

                    if (targetContentDocumentId != null) {
                        cv.ContentDocumentId = targetContentDocumentId;
                    } else {
                        cv.FirstPublishLocationId = targetAccountId;
                    }

                    insert as user cv; // DML - fine here, no callouts follow

                    migratedCount++;

                    if (targetContentDocumentId == null) {
                        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id WITH USER_MODE];
                        targetContentDocumentId = cv.ContentDocumentId;
                    }
                }

                if (migratedCount > 0) {
                    totalFilesMigrated++;
                    System.debug('OK: "' + title + '" -> ' + migratedCount + ' new version(s)');
                } else {
                    totalFilesSkipped++;
                }
            }

            totalAccountsProcessed += sourceIdToTargetId.size();
        } catch (Exception e) {
            totalErrors++;
            errorLog.add('Chunk failed: ' + e.getMessage());
            System.debug(LoggingLevel.ERROR, 'Batch chunk failed: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }
    }

    /** finish(): logs a final summary once every chunk has completed. */
    public void finish(Database.BatchableContext bc) {
        System.debug('=== MIGRATION BATCH COMPLETE ===');
        System.debug('Accounts processed: ' + totalAccountsProcessed);
        System.debug('Files migrated: ' + totalFilesMigrated);
        System.debug('Files skipped (already up to date): ' + totalFilesSkipped);
        System.debug('Chunk errors: ' + totalErrors);
        if (failedUpserts > 0) {
            System.debug(LoggingLevel.ERROR, 'Records rejected by the target org: ' + failedUpserts + ' (see the ERROR lines above for each reason)');
        }
        if (!errorLog.isEmpty()) {
            System.debug('Error details: ' + String.join(errorLog, ' | '));
        }
        // Optional: send a summary email here (Messaging.SingleEmailMessage)
        // to notify the team when a full run completes, since large orgs
        // will take many chunks and finish asynchronously.
    }

    // ------------------------------------------------------------------
    // Core migration logic (same behavior as the PoC-level class, reused
    // here per-chunk instead of for the whole org at once).
    // ------------------------------------------------------------------

    private Map<String, Id> migrateAccounts(List<Object> sourceAccounts) {
        List<Account> toUpsert = new List<Account>();
        for (Object o : sourceAccounts) {
            Map<String, Object> rec = (Map<String, Object>) o;
            Account a = new Account();
            a.Name = (String) rec.get('Name');
            a.put(EXTERNAL_ID_FIELD, (String) rec.get('Id'));
            toUpsert.add(a);
        }

        if (toUpsert.isEmpty()) {
            return new Map<String, Id>();
        }

        Schema.SObjectField extIdField = Account.getSObjectType()
            .getDescribe().fields.getMap().get(EXTERNAL_ID_FIELD.toLowerCase());
        // A field the running user cannot see is absent from this map entirely,
        // so the token comes back null and the upsert below would throw an NPE
        // that the chunk handler swallows — a run that migrates nothing and
        // still reports success. Say what is actually wrong instead.
        if (extIdField == null) {
            throw new MigrationException(
                EXTERNAL_ID_FIELD + ' is not visible to ' + UserInfo.getUsername() +
                '. Assign the Migration_Access permission set to whoever runs the migration.'
            );
        }
        // allOrNone=false lets the good records through, but the results are the
        // only record of what did not make it — dropping them would swallow
        // failures silently, which is exactly what this tool promises not to do.
        for (Database.UpsertResult ur : Database.upsert(toUpsert, extIdField, false, AccessLevel.USER_MODE)) {
            if (!ur.isSuccess()) {
                failedUpserts++;
                for (Database.Error e : ur.getErrors()) {
                    System.debug(LoggingLevel.ERROR,
                        'Upsert failed: ' + e.getStatusCode() + ' - ' + e.getMessage() +
                        ' [fields: ' + String.join(e.getFields(), ', ') + ']');
                }
            }
        }

        Map<String, Id> accountIdMap = new Map<String, Id>();
        List<String> sourceIds = new List<String>();
        for (Object o : sourceAccounts) {
            sourceIds.add((String) ((Map<String, Object>) o).get('Id'));
        }
        for (Account a : [
            SELECT Id, Legacy_Account_Id__c
            FROM Account
            WHERE Legacy_Account_Id__c IN :sourceIds WITH USER_MODE
        ]) {
            accountIdMap.put(a.Legacy_Account_Id__c, a.Id);
        }
        return accountIdMap;
    }

    private Blob fetchVersionData(String versionId) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(
            NAMED_CREDENTIAL + '/services/data/' + API_VERSION +
            '/sobjects/ContentVersion/' + versionId + '/VersionData'
        );
        req.setMethod('GET');
        req.setTimeout(120000);

        Http http = new Http();
        HttpResponse res = http.send(req);

        if (res.getStatusCode() != 200) {
            throw new MigrationException(
                'Failed to fetch VersionData for ' + versionId + ': ' + res.getBody()
            );
        }
        return res.getBodyAsBlob();
    }

    private List<Object> queryRecords(String soql) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(
            NAMED_CREDENTIAL + '/services/data/' + API_VERSION +
            '/query?q=' + EncodingUtil.urlEncode(soql, 'UTF-8')
        );
        req.setMethod('GET');
        req.setTimeout(120000);

        Http http = new Http();
        HttpResponse res = http.send(req);

        if (res.getStatusCode() != 200) {
            throw new MigrationException('Query failed: ' + res.getBody());
        }

        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        List<Object> allRecords = new List<Object>((List<Object>) result.get('records'));

        Boolean done = (Boolean) result.get('done');
        String nextUrl = (String) result.get('nextRecordsUrl');

        while (done == false && nextUrl != null) {
            HttpRequest req2 = new HttpRequest();
            req2.setEndpoint(NAMED_CREDENTIAL + nextUrl);
            req2.setMethod('GET');
            req2.setTimeout(120000);

            HttpResponse res2 = http.send(req2);
            if (res2.getStatusCode() != 200) {
                throw new MigrationException('Paginated query failed: ' + res2.getBody());
            }

            Map<String, Object> result2 = (Map<String, Object>) JSON.deserializeUntyped(res2.getBody());
            allRecords.addAll((List<Object>) result2.get('records'));
            done = (Boolean) result2.get('done');
            nextUrl = (String) result2.get('nextRecordsUrl');
        }

        return allRecords;
    }
}
