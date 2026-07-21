@isTest
private class SourceOrgOppFileMigrationBatchTest {

    @isTest
    static void testFullMigration() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.OPP_ID));

        Test.startTest();
        SourceOrgOpportunityFileMigrationBatch.run();
        Test.stopTest();

        List<Opportunity> migrated = [SELECT Id, Name, StageName, CloseDate, Amount, Legacy_Opportunity_Id__c
                                      FROM Opportunity
                                      WHERE Legacy_Opportunity_Id__c = :SourceOrgMigrationMock.OPP_ID];
        System.assertEquals(1, migrated.size(), 'Opportunity should be upserted with the source Id');
        System.assertEquals('Mig Test Opp', migrated[0].Name);
        System.assertEquals('Prospecting', migrated[0].StageName);
        System.assertEquals(Date.newInstance(2026, 12, 31), migrated[0].CloseDate);

        System.assertEquals(1, [SELECT COUNT() FROM ContentVersion WHERE Title = 'MigrationTestDoc'],
            'The file should be migrated');
        System.assert(![SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = :migrated[0].Id].isEmpty(),
            'The file should be linked to the migrated Opportunity');
    }

    @isTest
    static void testRunWhere() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.OPP_ID));

        Test.startTest();
        SourceOrgOpportunityFileMigrationBatch.runWhere('StageName != null');
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Opportunity
                                WHERE Legacy_Opportunity_Id__c = :SourceOrgMigrationMock.OPP_ID]);
    }
}
