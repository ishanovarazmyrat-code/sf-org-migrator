@isTest
private class SourceOrgCaseFileMigrationBatchTest {

    @isTest
    static void testFullMigration() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CASE_ID));

        Test.startTest();
        SourceOrgCaseFileMigrationBatch.run();
        Test.stopTest();

        List<Case> migrated = [SELECT Id, Subject, Legacy_Case_Id__c FROM Case
                               WHERE Legacy_Case_Id__c = :SourceOrgMigrationMock.CASE_ID];
        System.assertEquals(1, migrated.size(), 'Case should be upserted with the source Id');
        System.assertEquals('Mig Test Case', migrated[0].Subject);

        System.assertEquals(1, [SELECT COUNT() FROM ContentVersion WHERE Title = 'MigrationTestDoc'],
            'The file should be migrated');
        System.assert(![SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = :migrated[0].Id].isEmpty(),
            'The file should be linked to the migrated Case');

        System.assertEquals(1, [SELECT COUNT() FROM EmailMessage WHERE ParentId = :migrated[0].Id],
            'The EmailMessage should be migrated onto the Case');
    }

    @isTest
    static void testRunWhere() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CASE_ID));

        Test.startTest();
        SourceOrgCaseFileMigrationBatch.runWhere('Status != null');
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Case
                                WHERE Legacy_Case_Id__c = :SourceOrgMigrationMock.CASE_ID]);
    }
}
