/**
 * Case Sync Scheduler
 * ----------------------
 * Same pattern as AccountSyncScheduler, for Case (also picks up any new
 * EmailMessages on those Cases, since SourceOrgCaseFileMigrationBatch
 * already handles that).
 *
 * Usage (Execute Anonymous, one time, to start the schedule):
 *   System.schedule('Case Sync - Hourly', '0 45 * * * ?', new CaseSyncScheduler());
 *
 * To run it once manually:
 *   new CaseSyncScheduler().execute(null);
 */
public with sharing class CaseSyncScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        DateTime lastSync = getLastSyncTime();
        DateTime runStartedAt = DateTime.now();

        String isoLastSync = lastSync.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        String whereClause = 'LastModifiedDate > ' + isoLastSync;

        System.debug('Case sync: migrating records changed since ' + isoLastSync);
        SourceOrgCaseFileMigrationBatch.runWhere(whereClause);

        updateLastSyncTime(runStartedAt);
    }

    private DateTime getLastSyncTime() {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings != null && settings.Case_Last_Sync__c != null) {
            return settings.Case_Last_Sync__c;
        }
        return DateTime.newInstance(2000, 1, 1, 0, 0, 0);
    }

    private void updateLastSyncTime(DateTime newTime) {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings == null) {
            settings = new Migration_Sync_State__c();
        }
        settings.Case_Last_Sync__c = newTime;
        upsert settings;
    }
}
