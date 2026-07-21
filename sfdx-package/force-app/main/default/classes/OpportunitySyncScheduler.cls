/**
 * Opportunity Sync Scheduler
 * -----------------------------
 * Same idea as AccountSyncScheduler, for Opportunities.
 *
 * Usage (Execute Anonymous, one time, to start the schedule):
 *   System.schedule('Opportunity Sync - Hourly', '0 15 * * * ?', new OpportunitySyncScheduler());
 *
 * To run it once manually:
 *   new OpportunitySyncScheduler().execute(null);
 */
public with sharing class OpportunitySyncScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        DateTime lastSync = getLastSyncTime();
        DateTime runStartedAt = DateTime.now();

        String isoLastSync = lastSync.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        String whereClause = 'LastModifiedDate > ' + isoLastSync;

        System.debug('Opportunity sync: migrating records changed since ' + isoLastSync);
        SourceOrgOpportunityFileMigrationBatch.runWhere(whereClause);

        updateLastSyncTime(runStartedAt);
    }

    private DateTime getLastSyncTime() {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings != null && settings.Opportunity_Last_Sync__c != null) {
            return settings.Opportunity_Last_Sync__c;
        }
        return DateTime.newInstance(2000, 1, 1, 0, 0, 0);
    }

    private void updateLastSyncTime(DateTime newTime) {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings == null) {
            settings = new Migration_Sync_State__c();
        }
        settings.Opportunity_Last_Sync__c = newTime;
        upsert settings;
    }
}
