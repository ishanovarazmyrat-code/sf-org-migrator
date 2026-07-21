/**
 * Contact Sync Scheduler
 * -------------------------
 * Same pattern as AccountSyncScheduler, for Contact.
 *
 * Usage (Execute Anonymous, one time, to start the schedule):
 *   System.schedule('Contact Sync - Hourly', '0 30 * * * ?', new ContactSyncScheduler());
 *
 * To run it once manually:
 *   new ContactSyncScheduler().execute(null);
 */
public with sharing class ContactSyncScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        DateTime lastSync = getLastSyncTime();
        DateTime runStartedAt = DateTime.now();

        String isoLastSync = lastSync.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        String whereClause = 'LastModifiedDate > ' + isoLastSync;

        System.debug('Contact sync: migrating records changed since ' + isoLastSync);
        SourceOrgContactFileMigrationBatch.runWhere(whereClause);

        updateLastSyncTime(runStartedAt);
    }

    private DateTime getLastSyncTime() {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings != null && settings.Contact_Last_Sync__c != null) {
            return settings.Contact_Last_Sync__c;
        }
        return DateTime.newInstance(2000, 1, 1, 0, 0, 0);
    }

    private void updateLastSyncTime(DateTime newTime) {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings == null) {
            settings = new Migration_Sync_State__c();
        }
        settings.Contact_Last_Sync__c = newTime;
        upsert settings;
    }
}
