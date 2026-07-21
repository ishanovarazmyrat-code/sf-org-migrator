/**
 * Source Org Opportunity + File Migration - Batch
 * ---------------------------------------------------
 * Runs in the target org. Pulls Opportunities (Id, Name, StageName,
 * CloseDate, Amount) and their Files from the source org via a Named
 * Credential, and creates them in the target org - no external script.
 *
 * Setup required (same Named Credential as the Account migration):
 *   1. Connected App in the source org, Client Credentials Flow enabled.
 *   2. Named Credential "Source_Org" in the target org.
 *   3. Legacy_Opportunity_Id__c field on Opportunity in the target org
 *      (Text(18), External Id, Unique).
 *
 * Usage (Execute Anonymous in the target org):
 *   SourceOrgOpportunityFileMigrationBatch.run();                          // all Opportunities
 *   SourceOrgOpportunityFileMigrationBatch.run(listOfOpportunityIds);      // specific Ids
 *   SourceOrgOpportunityFileMigrationBatch.runWhere('StageName = \'Closed Won\''); // any filter
 *
 * Notes:
 *   - Opportunity requires StageName and CloseDate, so these are migrated
 *     along with Name (unlike Account, which only needs Name). Amount is
 *     included too since it's commonly needed - remove it below if not.
 *   - Files above 12MB are skipped (Apex callout size limit) and logged -
 *     migrate those separately using migrate.js.
 *   - Idempotent: re-running only migrates new Opportunities/files/versions.
 */
public with sharing class SourceOrgOpportunityFileMigrationBatch implements Database.Batchable<String>, Database.AllowsCallouts, Database.Stateful {

    private static final String NAMED_CREDENTIAL = 'callout:Source_Org';
    private static final String API_VERSION = 'v64.0';
    private static final String EXTERNAL_ID_FIELD = 'Legacy_Opportunity_Id__c';

    public Integer totalOppsProcessed = 0;
    public Integer totalFilesMigrated = 0;
    public Integer totalFilesSkipped = 0;
    public Integer totalErrors = 0;
    public List<String> errorLog = new List<String>();

    public class MigrationException extends Exception {}

    private List<String> restrictToOppIds;
    private String customWhereClause;

    public SourceOrgOpportunityFileMigrationBatch() {
        this.restrictToOppIds = null;
        this.customWhereClause = null;
    }

    public SourceOrgOpportunityFileMigrationBatch(List<String> sourceOppIds) {
        this.restrictToOppIds = sourceOppIds;
        this.customWhereClause = null;
    }

    private SourceOrgOpportunityFileMigrationBatch(String whereClause, Boolean isWhereClause) {
        this.restrictToOppIds = null;
        this.customWhereClause = whereClause;
    }

    public static Id run() {
        return run(5);
    }

    public static Id run(Integer scopeSize) {
        return Database.executeBatch(new SourceOrgOpportunityFileMigrationBatch(), scopeSize);
    }

    public static Id run(List<String> sourceOppIds) {
        return run(sourceOppIds, 5);
    }

    public static Id run(List<String> sourceOppIds, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgOpportunityFileMigrationBatch(sourceOppIds), scopeSize);
    }

    public static Id runWhere(String whereClause) {
        return runWhere(whereClause, 5);
    }

    public static Id runWhere(String whereClause, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgOpportunityFileMigrationBatch(whereClause, true), scopeSize);
    }

    public Iterable<String> start(Database.BatchableContext bc) {
        String soql = 'SELECT Id FROM Opportunity';
        if (customWhereClause != null && customWhereClause.trim() != '') {
            soql += ' WHERE ' + customWhereClause;
        } else if (restrictToOppIds != null && !restrictToOppIds.isEmpty()) {
            soql += ' WHERE Id IN (\'' + String.join(restrictToOppIds, '\',\'') + '\')';
        }
        List<Object> sourceOpps = queryRecords(soql);
        List<String> ids = new List<String>();
        for (Object o : sourceOpps) {
            Map<String, Object> rec = (Map<String, Object>) o;
            ids.add((String) rec.get('Id'));
        }
        System.debug('Batch start: ' + ids.size() + ' source Opportunity Id(s) to process.');
        return ids;
    }

    public void execute(Database.BatchableContext bc, List<String> scope) {
        try {
            // ================================================================
            // PHASE 1 - ALL CALLOUTS FIRST (see Account version for why).
            // ================================================================
            List<Object> sourceOpps = queryRecords(
                'SELECT Id, Name, StageName, CloseDate, Amount ' +
                'FROM Opportunity WHERE Id IN (\'' + String.join(scope, '\',\'') + '\')'
            );

            List<String> sourceOppIds = new List<String>();
            for (Object o : sourceOpps) {
                sourceOppIds.add((String) ((Map<String, Object>) o).get('Id'));
            }

            List<Object> links = new List<Object>();
            if (!sourceOppIds.isEmpty()) {
                String idList = '\'' + String.join(sourceOppIds, '\',\'') + '\'';
                links = queryRecords(
                    'SELECT ContentDocumentId, LinkedEntityId, ContentDocument.Title ' +
                    'FROM ContentDocumentLink WHERE LinkedEntityId IN (' + idList + ')'
                );
            }

            Map<String, List<Object>> contentDocToNewVersions = new Map<String, List<Object>>();
            Map<String, Id> contentDocToExistingTargetDocId = new Map<String, Id>();
            Map<String, String> contentDocToTitle = new Map<String, String>();
            Map<String, String> contentDocToSourceOppId = new Map<String, String>();
            Map<String, Blob> versionIdToBlob = new Map<String, Blob>();

            for (Object o : links) {
                Map<String, Object> link = (Map<String, Object>) o;
                String contentDocumentId = (String) link.get('ContentDocumentId');
                String sourceOppId = (String) link.get('LinkedEntityId');
                Map<String, Object> doc = (Map<String, Object>) link.get('ContentDocument');
                String title = (String) doc.get('Title');

                contentDocToTitle.put(contentDocumentId, title);
                contentDocToSourceOppId.put(contentDocumentId, sourceOppId);

                Id existingTargetDocId = null;
                Integer existingVersionCount = 0;
                for (ContentVersion cv : [
                    SELECT ContentDocumentId
                    FROM ContentVersion
                    WHERE Title = :title
                    LIMIT 1
                ]) {
                    existingTargetDocId = cv.ContentDocumentId;
                }
                if (existingTargetDocId != null) {
                    existingVersionCount = [
                        SELECT COUNT()
                        FROM ContentVersion
                        WHERE ContentDocumentId = :existingTargetDocId
                    ];
                    contentDocToExistingTargetDocId.put(contentDocumentId, existingTargetDocId);
                }

                List<Object> versions = queryRecords(
                    'SELECT Id, Title, PathOnClient, FileExtension, VersionNumber, ContentSize ' +
                    'FROM ContentVersion WHERE ContentDocumentId = \'' + contentDocumentId + '\' ' +
                    'ORDER BY VersionNumber ASC'
                );

                if (versions.isEmpty() || existingVersionCount >= versions.size()) {
                    continue;
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
                    versionIdToBlob.put(versionId, fetchVersionData(versionId));
                    newVersions.add(v);
                }

                if (!newVersions.isEmpty()) {
                    contentDocToNewVersions.put(contentDocumentId, newVersions);
                }
            }

            // ================================================================
            // PHASE 2 - ALL DML AFTER THIS POINT. No more callouts below.
            // ================================================================
            Map<String, Id> sourceIdToTargetId = migrateOpportunities(sourceOpps);

            for (String contentDocumentId : contentDocToNewVersions.keySet()) {
                String sourceOppId = contentDocToSourceOppId.get(contentDocumentId);
                Id targetOppId = sourceIdToTargetId.get(sourceOppId);
                String title = contentDocToTitle.get(contentDocumentId);

                if (targetOppId == null) {
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
                        cv.FirstPublishLocationId = targetOppId;
                    }

                    insert cv;
                    migratedCount++;

                    if (targetContentDocumentId == null) {
                        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id];
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

            totalOppsProcessed += sourceIdToTargetId.size();
        } catch (Exception e) {
            totalErrors++;
            errorLog.add('Chunk failed: ' + e.getMessage());
            System.debug(LoggingLevel.ERROR, 'Batch chunk failed: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('=== OPPORTUNITY MIGRATION BATCH COMPLETE ===');
        System.debug('Opportunities processed: ' + totalOppsProcessed);
        System.debug('Files migrated: ' + totalFilesMigrated);
        System.debug('Files skipped: ' + totalFilesSkipped);
        System.debug('Chunk errors: ' + totalErrors);
        if (!errorLog.isEmpty()) {
            System.debug('Error details: ' + String.join(errorLog, ' | '));
        }
    }

    private Map<String, Id> migrateOpportunities(List<Object> sourceOpps) {
        List<Opportunity> toUpsert = new List<Opportunity>();
        for (Object o : sourceOpps) {
            Map<String, Object> rec = (Map<String, Object>) o;
            Opportunity opp = new Opportunity();
            opp.Name = (String) rec.get('Name');
            opp.StageName = (String) rec.get('StageName');
            opp.CloseDate = rec.get('CloseDate') != null
                ? Date.valueOf((String) rec.get('CloseDate'))
                : Date.today();
            if (rec.get('Amount') != null) {
                opp.Amount = Decimal.valueOf(String.valueOf(rec.get('Amount')));
            }
            opp.put(EXTERNAL_ID_FIELD, (String) rec.get('Id'));
            toUpsert.add(opp);
        }

        if (toUpsert.isEmpty()) {
            return new Map<String, Id>();
        }

        Schema.SObjectField extIdField = Opportunity.getSObjectType()
            .getDescribe().fields.getMap().get(EXTERNAL_ID_FIELD.toLowerCase());
        Database.upsert(toUpsert, extIdField, false);

        Map<String, Id> oppIdMap = new Map<String, Id>();
        List<String> sourceIds = new List<String>();
        for (Object o : sourceOpps) {
            sourceIds.add((String) ((Map<String, Object>) o).get('Id'));
        }
        for (Opportunity opp : [
            SELECT Id, Legacy_Opportunity_Id__c
            FROM Opportunity
            WHERE Legacy_Opportunity_Id__c IN :sourceIds
        ]) {
            oppIdMap.put(opp.Legacy_Opportunity_Id__c, opp.Id);
        }
        return oppIdMap;
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
