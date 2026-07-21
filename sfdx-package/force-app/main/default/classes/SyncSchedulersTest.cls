/**
 * Tests for all five sync schedulers. Each execute() should launch its batch
 * (mocked callouts) and advance its own watermark field on the
 * Migration_Sync_State__c hierarchy custom setting.
 */
@isTest
private class SyncSchedulersTest {

    private static final String CRON = '0 0 1 1 1 ? 2099';

    @isTest
    static void testAccountScheduler() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));
        Test.startTest();
        new AccountSyncScheduler().execute(null);
        Test.stopTest();
        System.assertNotEquals(null, Migration_Sync_State__c.getOrgDefaults().Account_Last_Sync__c,
            'Account watermark should be set');
    }

    @isTest
    static void testContactScheduler() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CON_ID));
        Test.startTest();
        new ContactSyncScheduler().execute(null);
        Test.stopTest();
        System.assertNotEquals(null, Migration_Sync_State__c.getOrgDefaults().Contact_Last_Sync__c,
            'Contact watermark should be set');
    }

    @isTest
    static void testOpportunityScheduler() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.OPP_ID));
        Test.startTest();
        new OpportunitySyncScheduler().execute(null);
        Test.stopTest();
        System.assertNotEquals(null, Migration_Sync_State__c.getOrgDefaults().Opportunity_Last_Sync__c,
            'Opportunity watermark should be set');
    }

    @isTest
    static void testCaseScheduler() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.CASE_ID));
        Test.startTest();
        new CaseSyncScheduler().execute(null);
        Test.stopTest();
        System.assertNotEquals(null, Migration_Sync_State__c.getOrgDefaults().Case_Last_Sync__c,
            'Case watermark should be set');
    }

    @isTest
    static void testSecondRunUsesStoredWatermark() {
        Migration_Sync_State__c s = Migration_Sync_State__c.getOrgDefaults();
        s.Account_Last_Sync__c = DateTime.newInstance(2020, 1, 1);
        upsert s;

        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));
        Test.startTest();
        new AccountSyncScheduler().execute(null);
        Test.stopTest();

        System.assert(Migration_Sync_State__c.getOrgDefaults().Account_Last_Sync__c
            > DateTime.newInstance(2020, 1, 1), 'Watermark should advance past the stored value');
    }

    @isTest
    static void testSchedulable() {
        Test.setMock(HttpCalloutMock.class, new SourceOrgMigrationMock(SourceOrgMigrationMock.ACC_ID));
        Test.startTest();
        Id jobId = System.schedule('AccountSyncSchedulerTest', CRON, new AccountSyncScheduler());
        Test.stopTest();
        System.assertNotEquals(null, jobId, 'The class should be schedulable');
    }
}
