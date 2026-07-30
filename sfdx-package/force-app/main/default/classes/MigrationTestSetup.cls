/**
 * Test setup shared by the migration batch tests.
 *
 * The batches run their SOQL and DML in user mode, so they only work if the
 * running user has field-level access to the Legacy_*_Id__c external Ids —
 * which is exactly what the packaged Migration_Access permission set grants.
 *
 * Running the batches as a purpose-made user with only that permission set
 * turns the permission set into something the suite verifies: add a field to
 * the migration and forget to add it to the permission set, and these tests
 * fail instead of a customer discovering it.
 *
 * It has to be System.runAs and a separate user. Assigning the permission set
 * to the *current* user — in @TestSetup or anywhere else — does not change
 * what that user can see for the rest of the transaction, so the tests would
 * pass or fail based on whoever happened to run them.
 */
@isTest
public class MigrationTestSetup {

    /**
     * A Standard User holding only Migration_Access. Run the batch inside
     * System.runAs(migrationUser()) so it sees exactly the access the package
     * grants a customer, and nothing the deploying admin happens to have.
     */
    public static User migrationUser() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        String nonce = String.valueOf(Datetime.now().getTime()) + String.valueOf(Math.abs(Crypto.getRandomInteger()));
        User u = new User(
            ProfileId = p.Id,
            LastName = 'Migration',
            Email = 'migration.test@example.invalid',
            Username = 'migration.test.' + nonce + '@example.invalid',
            Alias = 'migtst',
            TimeZoneSidKey = 'GMT',
            LocaleSidKey = 'en_US',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US'
        );
        insert u;

        PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Migration_Access' LIMIT 1];
        insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
        return u;
    }
}
