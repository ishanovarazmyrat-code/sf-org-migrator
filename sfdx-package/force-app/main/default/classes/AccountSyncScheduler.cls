/**
 * Account Sync Scheduler
 * -------------------------
 * Runs on a schedule (e.g. every hour). Each run only migrates Accounts
 * modified since the last successful run, using LastModifiedDate.
 *
 * Setup required:
 *   1. The Hierarchy Custom Setting "Migration_Sync_State__c" with a
 *      field Account_Last_Sync__c (DateTime).
 *   2. Everything already required by SourceOrgAccountFileMigrationBatch
 *      (Named Credential, Legacy_Account_Id__c field, etc).
 *
 * Usage (Execute Anonymous, one time, to start the schedule):
 *   System.schedule('Account Sync - Hourly', '0 0 * * * ?', new AccountSyncScheduler());
 *
 * To run it once manually (without scheduling):
 *   new AccountSyncScheduler().execute(null);
 */
public with sharing class AccountSyncScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        DateTime lastSync = getLastSyncTime();
        DateTime runStartedAt = DateTime.now();

        String isoLastSync = lastSync.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        String whereClause = 'LastModifiedDate > ' + isoLastSync;

        System.debug('Account sync: migrating records changed since ' + isoLastSync);
        SourceOrgAccountFileMigrationBatch.runWhere(whereClause);

        // Advance the watermark to when this run started. Idempotency in
        // the batch class makes any overlap harmless if the batch itself
        // takes a while to finish.
        updateLastSyncTime(runStartedAt);
    }

    private DateTime getLastSyncTime() {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings != null && settings.Account_Last_Sync__c != null) {
            return settings.Account_Last_Sync__c;
        }
        // No prior sync recorded - default to a safe old date so the first
        // run picks up everything.
        return DateTime.newInstance(2000, 1, 1, 0, 0, 0);
    }

    private void updateLastSyncTime(DateTime newTime) {
        Migration_Sync_State__c settings = Migration_Sync_State__c.getOrgDefaults();
        if (settings == null) {
            settings = new Migration_Sync_State__c();
        }
        settings.Account_Last_Sync__c = newTime;
        upsert settings;
    }
}
