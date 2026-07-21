@isTest
private class SourceOrgContactFileMigrationBatchTest {

    @isTest
    static void testFullMigration() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CON_ID));

        Test.startTest();
        SourceOrgContactFileMigrationBatch.run();
        Test.stopTest();

        List<Contact> migrated = [SELECT Id, LastName, Legacy_Contact_Id__c FROM Contact
                                  WHERE Legacy_Contact_Id__c = :SourceOrgMigrationMock.CON_ID];
        System.assertEquals(1, migrated.size(), 'Contact should be upserted with the source Id');
        System.assertEquals('Test Contact', migrated[0].LastName);

        System.assertEquals(1, [SELECT COUNT() FROM ContentVersion WHERE Title = 'MigrationTestDoc'],
            'The file should be migrated');
        System.assert(![SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = :migrated[0].Id].isEmpty(),
            'The file should be linked to the migrated Contact');
    }

    @isTest
    static void testRunWhere() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CON_ID));

        Test.startTest();
        SourceOrgContactFileMigrationBatch.runWhere('Email != null');
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Contact
                                WHERE Legacy_Contact_Id__c = :SourceOrgMigrationMock.CON_ID]);
    }
}
