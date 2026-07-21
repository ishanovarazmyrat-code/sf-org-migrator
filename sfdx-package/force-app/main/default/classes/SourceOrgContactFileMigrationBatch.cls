/**
 * Source Org Contact + File Migration - Batch
 * -----------------------------------------------
 * Same pattern as SourceOrgAccountFileMigrationBatch (Account), for Contact.
 * Migrates Id, FirstName, LastName, Email, Phone + Files.
 *
 * Setup required:
 *   1. Named Credential "Source_Org" (already set up for Account/Opportunity).
 *   2. Legacy_Contact_Id__c field on Contact in the target org
 *      (Text(18), External Id, Unique).
 *
 * Usage:
 *   SourceOrgContactFileMigrationBatch.run();
 *   SourceOrgContactFileMigrationBatch.run(listOfContactIds);
 *   SourceOrgContactFileMigrationBatch.runWhere('Email != null');
 */
public with sharing class SourceOrgContactFileMigrationBatch implements Database.Batchable<String>, Database.AllowsCallouts, Database.Stateful {

    private static final String NAMED_CREDENTIAL = 'callout:Source_Org';
    private static final String API_VERSION = 'v64.0';
    private static final String EXTERNAL_ID_FIELD = 'Legacy_Contact_Id__c';

    public Integer totalContactsProcessed = 0;
    public Integer totalFilesMigrated = 0;
    public Integer totalFilesSkipped = 0;
    public Integer totalErrors = 0;
    public List<String> errorLog = new List<String>();

    public class MigrationException extends Exception {}

    private List<String> restrictToIds;
    private String customWhereClause;

    public SourceOrgContactFileMigrationBatch() {}

    public SourceOrgContactFileMigrationBatch(List<String> sourceIds) {
        this.restrictToIds = sourceIds;
    }

    private SourceOrgContactFileMigrationBatch(String whereClause, Boolean isWhereClause) {
        this.customWhereClause = whereClause;
    }

    public static Id run() { return run(5); }
    public static Id run(Integer scopeSize) {
        return Database.executeBatch(new SourceOrgContactFileMigrationBatch(), scopeSize);
    }
    public static Id run(List<String> sourceIds) { return run(sourceIds, 5); }
    public static Id run(List<String> sourceIds, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgContactFileMigrationBatch(sourceIds), scopeSize);
    }
    public static Id runWhere(String whereClause) { return runWhere(whereClause, 5); }
    public static Id runWhere(String whereClause, Integer scopeSize) {
        return Database.executeBatch(new SourceOrgContactFileMigrationBatch(whereClause, true), scopeSize);
    }

    public Iterable<String> start(Database.BatchableContext bc) {
        String soql = 'SELECT Id FROM Contact';
        if (customWhereClause != null && customWhereClause.trim() != '') {
            soql += ' WHERE ' + customWhereClause;
        } else if (restrictToIds != null && !restrictToIds.isEmpty()) {
            soql += ' WHERE Id IN (\'' + String.join(restrictToIds, '\',\'') + '\')';
        }
        List<Object> records = queryRecords(soql);
        List<String> ids = new List<String>();
        for (Object o : records) {
            ids.add((String) ((Map<String, Object>) o).get('Id'));
        }
        System.debug('Batch start: ' + ids.size() + ' source Contact Id(s) to process.');
        return ids;
    }

    public void execute(Database.BatchableContext bc, List<String> scope) {
        try {
            List<Object> sourceContacts = queryRecords(
                'SELECT Id, FirstName, LastName, Email, Phone ' +
                'FROM Contact WHERE Id IN (\'' + String.join(scope, '\',\'') + '\')'
            );

            List<String> sourceIds = new List<String>();
            for (Object o : sourceContacts) {
                sourceIds.add((String) ((Map<String, Object>) o).get('Id'));
            }

            List<Object> links = new List<Object>();
            if (!sourceIds.isEmpty()) {
                links = queryRecords(
                    'SELECT ContentDocumentId, LinkedEntityId, ContentDocument.Title ' +
                    'FROM ContentDocumentLink WHERE LinkedEntityId IN (\'' +
                    String.join(sourceIds, '\',\'') + '\')'
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
                for (ContentVersion cv : [SELECT ContentDocumentId FROM ContentVersion WHERE Title = :title LIMIT 1]) {
                    existingTargetDocId = cv.ContentDocumentId;
                }
                if (existingTargetDocId != null) {
                    existingVersionCount = [SELECT COUNT() FROM ContentVersion WHERE ContentDocumentId = :existingTargetDocId];
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

            // ALL DML BELOW - no more callouts after this point.
            Map<String, Id> sourceIdToTargetId = migrateContacts(sourceContacts);

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
                    insert cv;
                    migratedCount++;
                    if (targetContentDocumentId == null) {
                        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id];
                        targetContentDocumentId = cv.ContentDocumentId;
                    }
                }
                if (migratedCount > 0) { totalFilesMigrated++; } else { totalFilesSkipped++; }
            }

            totalContactsProcessed += sourceIdToTargetId.size();
        } catch (Exception e) {
            totalErrors++;
            errorLog.add('Chunk failed: ' + e.getMessage());
            System.debug(LoggingLevel.ERROR, 'Batch chunk failed: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('=== CONTACT MIGRATION BATCH COMPLETE ===');
        System.debug('Contacts processed: ' + totalContactsProcessed);
        System.debug('Files migrated: ' + totalFilesMigrated);
        System.debug('Files skipped: ' + totalFilesSkipped);
        System.debug('Chunk errors: ' + totalErrors);
        if (!errorLog.isEmpty()) System.debug('Error details: ' + String.join(errorLog, ' | '));
    }

    private Map<String, Id> migrateContacts(List<Object> sourceContacts) {
        List<Contact> toUpsert = new List<Contact>();
        for (Object o : sourceContacts) {
            Map<String, Object> rec = (Map<String, Object>) o;
            Contact c = new Contact();
            c.FirstName = (String) rec.get('FirstName');
            c.LastName = rec.get('LastName') != null ? (String) rec.get('LastName') : 'Unknown';
            c.Email = (String) rec.get('Email');
            c.Phone = (String) rec.get('Phone');
            c.put(EXTERNAL_ID_FIELD, (String) rec.get('Id'));
            toUpsert.add(c);
        }
        if (toUpsert.isEmpty()) return new Map<String, Id>();

        Schema.SObjectField extIdField = Contact.getSObjectType().getDescribe().fields.getMap().get(EXTERNAL_ID_FIELD.toLowerCase());
        Database.upsert(toUpsert, extIdField, false);

        Map<String, Id> idMap = new Map<String, Id>();
        List<String> sourceIds = new List<String>();
        for (Object o : sourceContacts) sourceIds.add((String) ((Map<String, Object>) o).get('Id'));
        for (Contact c : [SELECT Id, Legacy_Contact_Id__c FROM Contact WHERE Legacy_Contact_Id__c IN :sourceIds]) {
            idMap.put(c.Legacy_Contact_Id__c, c.Id);
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
