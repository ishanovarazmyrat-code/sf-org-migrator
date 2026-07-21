@isTest
private class SourceOrgAccountFileMigrationBatchTest {

    @isTest
    static void testFullMigration() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));

        Test.startTest();
        SourceOrgAccountFileMigrationBatch.run();
        Test.stopTest();

        List<Account> migrated = [SELECT Id, Name, Legacy_Account_Id__c FROM Account
                                  WHERE Legacy_Account_Id__c = :SourceOrgMigrationMock.ACC_ID];
        System.assertEquals(1, migrated.size(), 'Account should be upserted with the source Id');
        System.assertEquals('Mig Test Account', migrated[0].Name);

        List<ContentVersion> files = [SELECT Id, Title FROM ContentVersion WHERE Title = 'MigrationTestDoc'];
        System.assertEquals(1, files.size(), 'The file should be migrated');

        List<ContentDocumentLink> links = [SELECT Id FROM ContentDocumentLink
                                           WHERE LinkedEntityId = :migrated[0].Id];
        System.assert(!links.isEmpty(), 'The file should be linked to the migrated Account');
    }

    @isTest
    static void testRunWhereAndIdempotency() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));

        Test.startTest();
        SourceOrgAccountFileMigrationBatch.runWhere('Name != null');
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Account
                                WHERE Legacy_Account_Id__c = :SourceOrgMigrationMock.ACC_ID]);
    }

    @isTest
    static void testRunWithSpecificIds() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));

        Test.startTest();
        SourceOrgAccountFileMigrationBatch.run(new List<String>{ SourceOrgMigrationMock.ACC_ID });
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Account
                                WHERE Legacy_Account_Id__c = :SourceOrgMigrationMock.ACC_ID]);
    }
}
