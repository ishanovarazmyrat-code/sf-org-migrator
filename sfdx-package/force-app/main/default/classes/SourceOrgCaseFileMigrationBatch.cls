/**
 * Source Org Case + File + Email Migration - Batch
 * -----------------------------------------------------
 * Same pattern as the other migration batches, for Case. Also migrates
 * the EmailMessages linked to each Case (ParentId = Case Id), since email
 * threads are usually important context for a Case.
 *
 * Migrates:
 *   - Case: Subject, Status, Description, Origin
 *   - Files attached to the Case (ContentVersion + full version history)
 *   - EmailMessages related to the Case (Subject, TextBody, HtmlBody,
 *     FromAddress, ToAddress, Incoming), linked to the new Case
 *
 * Setup required:
 *   1. Named Credential "Source_Org" (already set up).
 *   2. Legacy_Case_Id__c field on Case in the target org
 *      (Text(18), External Id, Unique).
 *
 * Usage:
 *   SourceOrgCaseFileMigrationBatch.run();
 *   SourceOrgCaseFileMigrationBatch.run(listOfCaseIds);
 *   SourceOrgCaseFileMigrationBatch.runWhere('Status = \'Closed\'');
 */
public with sharing class SourceOrgCaseFileMigrationBatch implements Database.Batchable<String>, Database.AllowsCallouts, Database.Stateful {

    private static final String NAMED_CREDENTIAL = 'callout:Source_Org';
    private static final String API_VERSION = 'v64.0';
    private static final String EXTERNAL_ID_FIELD = 'Legacy_Case_Id__c';

    public Integer totalCasesProcessed = 0;
    public Integer totalFilesMigrated = 0;
    public Integer totalFilesSkipped = 0;
    public Integer totalEmailsMigrated = 0;
    public Integer totalErrors = 0;
    /** Records the target org refused (FLS, validation, duplicate rules). */
    public Integer failedUpserts = 0;
    public List<String> errorLog = new List<String>();

    public class MigrationException extends Exception {}

    private List<String> restrictToIds;
    // A SOQL filter for the query sent to the SOURCE org over the Named
    // Credential — not a query against this org. It is supplied by whoever
    // schedules the batch (Apex execute rights), and it can only reach data
    // the Named Credential is already authenticated for. Escaping it would
    // defeat its purpose: being a filter expression is the point.
    private String customWhereClause;

    public SourceOrgCaseFileMigrationBatch() {}
    public SourceOrgCaseFileMigrationBatch(List<String> sourceIds) { this.restrictToIds = sourceIds; }
    private SourceOrgCaseFileMigrationBatch(String whereClause, Boolean isWhereClause) { this.customWhereClause = whereClause; }

    public static Id run() { return run(5); }
    public static Id run(Integer scopeSize) {
        return Database.executeBatch(new SourceOrgCaseFileMigrationBatch(), scopeSize);
    }
    public static Id run(List<String> sourceIds) { return run(sourceIds, 5); }
    public static Id run(List<String> sourceIds, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgCaseFileMigrationBatch(sourceIds), scopeSize);
    }
    public static Id runWhere(String whereClause) { return runWhere(whereClause, 5); }
    public static Id runWhere(String whereClause, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgCaseFileMigrationBatch(whereClause, true), scopeSize);
    }

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
        String soql = 'SELECT Id FROM Case';
        if (customWhereClause != null && customWhereClause.trim() != '') {
            soql += ' WHERE ' + customWhereClause;
        } else if (restrictToIds != null && !restrictToIds.isEmpty()) {
            soql += ' WHERE Id IN (\'' + String.join(restrictToIds, '\',\'') + '\')';
        }
        List<Object> records = queryRecords(soql);
        List<String> ids = new List<String>();
        for (Object o : records) ids.add((String) ((Map<String, Object>) o).get('Id'));
        System.debug('Batch start: ' + ids.size() + ' source Case Id(s) to process.');
        return ids;
    }

    public void execute(Database.BatchableContext bc, List<String> scope) {
        try {
            // ============== PHASE 1 - ALL CALLOUTS ==============
            List<Object> sourceCases = queryRecords(
                'SELECT Id, Subject, Status, Description, Origin ' +
                'FROM Case WHERE Id IN (\'' + String.join(scope, '\',\'') + '\')'
            );
            List<String> sourceIds = new List<String>();
            for (Object o : sourceCases) sourceIds.add((String) ((Map<String, Object>) o).get('Id'));

            // Files
            List<Object> links = new List<Object>();
            if (!sourceIds.isEmpty()) {
                links = queryRecords(
                    'SELECT ContentDocumentId, LinkedEntityId, ContentDocument.Title ' +
                    'FROM ContentDocumentLink WHERE LinkedEntityId IN (\'' + String.join(sourceIds, '\',\'') + '\')'
                );
            }

            Map<String, List<Object>> contentDocToNewVersions = new Map<String, List<Object>>();
            Map<String, Id> contentDocToExistingTargetDocId = new Map<String, Id>();
            Map<String, String> contentDocToTitle = new Map<String, String>();
            Map<String, String> contentDocToSourceId = new Map<String, String>();
            Map<String, Blob> versionIdToBlob = new Map<String, Blob>();

            for (Object o : links) {
                Map<String, Object> link = (Map<String, Object>) o;
                String contentDocumentId = (String) link.get('ContentDocumentId');
                String sourceId = (String) link.get('LinkedEntityId');
                Map<String, Object> doc = (Map<String, Object>) link.get('ContentDocument');
                String title = (String) doc.get('Title');

                contentDocToTitle.put(contentDocumentId, title);
                contentDocToSourceId.put(contentDocumentId, sourceId);

                Id existingTargetDocId = null;
                Integer existingVersionCount = 0;
                for (ContentVersion cv : [SELECT ContentDocumentId FROM ContentVersion WHERE Title = :title WITH USER_MODE LIMIT 1]) {
                    existingTargetDocId = cv.ContentDocumentId;
                }
                if (existingTargetDocId != null) {
                    existingVersionCount = [SELECT COUNT() FROM ContentVersion WHERE ContentDocumentId = :existingTargetDocId WITH USER_MODE];
                    contentDocToExistingTargetDocId.put(contentDocumentId, existingTargetDocId);
                }

                List<Object> versions = queryRecords(
                    'SELECT Id, Title, PathOnClient, FileExtension, VersionNumber, ContentSize ' +
                    'FROM ContentVersion WHERE ContentDocumentId = \'' + contentDocumentId + '\' ORDER BY VersionNumber ASC'
                );
                if (versions.isEmpty() || existingVersionCount >= versions.size()) continue;

                List<Object> newVersions = new List<Object>();
                for (Integer i = existingVersionCount; i < versions.size(); i++) {
                    Map<String, Object> v = (Map<String, Object>) versions[i];
                    Long contentSize = v.get('ContentSize') != null ? Long.valueOf(String.valueOf(v.get('ContentSize'))) : 0;
                    if (contentSize > 12 * 1024 * 1024) {
                        errorLog.add('SKIPPED (too large for Apex callout, use migrate.js): "' + title + '" (' + contentSize + ' bytes)');
                        totalFilesSkipped++;
                        continue;
                    }
                    String versionId = (String) v.get('Id');
                    versionIdToBlob.put(versionId, fetchVersionData(versionId));
                    newVersions.add(v);
                }
                if (!newVersions.isEmpty()) contentDocToNewVersions.put(contentDocumentId, newVersions);
            }

            // EmailMessages linked to these Cases
            List<Object> sourceEmails = new List<Object>();
            if (!sourceIds.isEmpty()) {
                sourceEmails = queryRecords(
                    'SELECT Id, ParentId, Subject, TextBody, HtmlBody, FromAddress, ToAddress, Incoming ' +
                    'FROM EmailMessage WHERE ParentId IN (\'' + String.join(sourceIds, '\',\'') + '\')'
                );
            }

            // ============== PHASE 2 - ALL DML ==============
            Map<String, Id> sourceIdToTargetId = migrateCases(sourceCases);

            for (String contentDocumentId : contentDocToNewVersions.keySet()) {
                String sourceId = contentDocToSourceId.get(contentDocumentId);
                Id targetId = sourceIdToTargetId.get(sourceId);
                String title = contentDocToTitle.get(contentDocumentId);
                if (targetId == null) { totalFilesSkipped++; continue; }

                Id targetContentDocumentId = contentDocToExistingTargetDocId.get(contentDocumentId);
                List<Object> newVersions = contentDocToNewVersions.get(contentDocumentId);
                Integer migratedCount = 0;

                for (Object o : newVersions) {
                    Map<String, Object> v = (Map<String, Object>) o;
                    String versionId = (String) v.get('Id');
                    ContentVersion cv = new ContentVersion();
                    cv.Title = (String) v.get('Title');
                    cv.PathOnClient = (String) v.get('PathOnClient');
                    cv.VersionData = versionIdToBlob.get(versionId);
                    if (targetContentDocumentId != null) {
                        cv.ContentDocumentId = targetContentDocumentId;
                    } else {
                        cv.FirstPublishLocationId = targetId;
                    }
                    insert as user cv;
                    migratedCount++;
                    if (targetContentDocumentId == null) {
                        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id WITH USER_MODE];
                        targetContentDocumentId = cv.ContentDocumentId;
                    }
                }
                if (migratedCount > 0) { totalFilesMigrated++; } else { totalFilesSkipped++; }
            }

            // Insert EmailMessages, linked to their mapped target Case
            List<EmailMessage> emailsToInsert = new List<EmailMessage>();
            for (Object o : sourceEmails) {
                Map<String, Object> rec = (Map<String, Object>) o;
                String sourceParentId = (String) rec.get('ParentId');
                Id targetCaseId = sourceIdToTargetId.get(sourceParentId);
                if (targetCaseId == null) continue;

                EmailMessage em = new EmailMessage();
                em.ParentId = targetCaseId;
                em.Subject = (String) rec.get('Subject');
                em.TextBody = (String) rec.get('TextBody');
                em.HtmlBody = (String) rec.get('HtmlBody');
                em.FromAddress = (String) rec.get('FromAddress');
                em.ToAddress = (String) rec.get('ToAddress');
                em.Incoming = rec.get('Incoming') != null ? (Boolean) rec.get('Incoming') : true;
                emailsToInsert.add(em);
            }
            if (!emailsToInsert.isEmpty()) {
                insert as user emailsToInsert;
                totalEmailsMigrated += emailsToInsert.size();
            }

            totalCasesProcessed += sourceIdToTargetId.size();
        } catch (Exception e) {
            totalErrors++;
            errorLog.add('Chunk failed: ' + e.getMessage());
            System.debug(LoggingLevel.ERROR, 'Batch chunk failed: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('=== CASE MIGRATION BATCH COMPLETE ===');
        System.debug('Cases processed: ' + totalCasesProcessed);
        System.debug('Files migrated: ' + totalFilesMigrated);
        System.debug('Files skipped: ' + totalFilesSkipped);
        System.debug('Emails migrated: ' + totalEmailsMigrated);
        System.debug('Chunk errors: ' + totalErrors);
        if (failedUpserts > 0) {
            System.debug(LoggingLevel.ERROR, 'Records rejected by the target org: ' + failedUpserts + ' (see the ERROR lines above for each reason)');
        }
        if (!errorLog.isEmpty()) System.debug('Error details: ' + String.join(errorLog, ' | '));
    }

    private Map<String, Id> migrateCases(List<Object> sourceCases) {
        List<Case> toUpsert = new List<Case>();
        for (Object o : sourceCases) {
            Map<String, Object> rec = (Map<String, Object>) o;
            Case c = new Case();
            c.Subject = (String) rec.get('Subject');
            c.Status = rec.get('Status') != null ? (String) rec.get('Status') : 'New';
            c.Description = (String) rec.get('Description');
            c.Origin = (String) rec.get('Origin');
            c.put(EXTERNAL_ID_FIELD, (String) rec.get('Id'));
            toUpsert.add(c);
        }
        if (toUpsert.isEmpty()) return new Map<String, Id>();

        Schema.SObjectField extIdField = Case.getSObjectType().getDescribe().fields.getMap().get(EXTERNAL_ID_FIELD.toLowerCase());
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

        Map<String, Id> idMap = new Map<String, Id>();
        List<String> sourceIds = new List<String>();
        for (Object o : sourceCases) sourceIds.add((String) ((Map<String, Object>) o).get('Id'));
        for (Case c : [SELECT Id, Legacy_Case_Id__c FROM Case WHERE Legacy_Case_Id__c IN :sourceIds WITH USER_MODE]) {
            idMap.put(c.Legacy_Case_Id__c, c.Id);
        }
        return idMap;
    }

    private Blob fetchVersionData(String versionId) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(NAMED_CREDENTIAL + '/services/data/' + API_VERSION + '/sobjects/ContentVersion/' + versionId + '/VersionData');
        req.setMethod('GET');
        req.setTimeout(120000);
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) throw new MigrationException('Failed to fetch VersionData for ' + versionId + ': ' + res.getBody());
        return res.getBodyAsBlob();
    }

    private List<Object> queryRecords(String soql) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(NAMED_CREDENTIAL + '/services/data/' + API_VERSION + '/query?q=' + EncodingUtil.urlEncode(soql, 'UTF-8'));
        req.setMethod('GET');
        req.setTimeout(120000);
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) throw new MigrationException('Query failed: ' + res.getBody());

        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        List<Object> allRecords = new List<Object>((List<Object>) result.get('records'));
        Boolean done = (Boolean) result.get('done');
        String nextUrl = (String) result.get('nextRecordsUrl');
        while (done == false && nextUrl != null) {
            HttpRequest req2 = new HttpRequest();
            req2.setEndpoint(NAMED_CREDENTIAL + nextUrl);
            req2.setMethod('GET');
            req2.setTimeout(120000);
            HttpResponse res2 = new Http().send(req2);
            if (res2.getStatusCode() != 200) throw new MigrationException('Paginated query failed: ' + res2.getBody());
            Map<String, Object> result2 = (Map<String, Object>) JSON.deserializeUntyped(res2.getBody());
            allRecords.addAll((List<Object>) result2.get('records'));
            done = (Boolean) result2.get('done');
            nextUrl = (String) result2.get('nextRecordsUrl');
        }
        return allRecords;
    }
}
