/**
 * Shared HTTP mock for all migration batch tests.
 *
 * The batches talk to the source org via REST (query + VersionData). This
 * mock answers those callouts with one record per object, one linked file
 * (one version), and one EmailMessage — enough to drive every code path:
 * start(), the callout phase, record upsert, file insert, and link creation.
 */
@isTest
public class SourceOrgMigrationMock implements HttpCalloutMock {

    // Fake but well-formed source-org record Ids (stored into Legacy_*_Id__c).
    public static final String ACC_ID  = '001000000000001AAA';
    public static final String CON_ID  = '003000000000001AAA';
    public static final String OPP_ID  = '006000000000001AAA';
    public static final String CASE_ID = '500000000000001AAA';
    public static final String DOC_ID  = '069000000000001AAA';
    public static final String VER_ID  = '068000000000001AAA';
    public static final String EMAIL_ID = '02s000000000001AAA';

    /** Which record the ContentDocumentLink points at (the object under test). */
    private final String linkedEntityId;

    public SourceOrgMigrationMock(String linkedEntityId) {
        this.linkedEntityId = linkedEntityId;
    }

    public HTTPResponse respond(HTTPRequest req) {
        HttpResponse res = new HttpResponse();
        res.setStatusCode(200);
        res.setHeader('Content-Type', 'application/json');

        String ep = req.getEndpoint();

        if (ep.contains('/VersionData')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setBodyAsBlob(Blob.valueOf('Test file content'));
            return res;
        }

        List<Object> records = new List<Object>();

        if (ep.contains('FROM+ContentDocumentLink')) {
            records.add(new Map<String, Object>{
                'ContentDocumentId' => DOC_ID,
                'LinkedEntityId' => linkedEntityId,
                'ContentDocument' => new Map<String, Object>{ 'Title' => 'MigrationTestDoc' }
            });
        } else if (ep.contains('FROM+ContentVersion')) {
            records.add(new Map<String, Object>{
                'Id' => VER_ID,
                'Title' => 'MigrationTestDoc',
                'PathOnClient' => 'MigrationTestDoc.txt',
                'FileExtension' => 'txt',
                'VersionNumber' => '1',
                'ContentSize' => 17
            });
        } else if (ep.contains('FROM+EmailMessage')) {
            records.add(new Map<String, Object>{
                'Id' => EMAIL_ID,
                'ParentId' => CASE_ID,
                'Subject' => 'Test Email',
                'TextBody' => 'body',
                'HtmlBody' => null,
                'FromAddress' => 'a@example.com',
                'ToAddress' => 'b@example.com',
                'Incoming' => true
            });
        } else if (ep.contains('FROM+Account')) {
            records.add(new Map<String, Object>{ 'Id' => ACC_ID, 'Name' => 'Mig Test Account' });
        } else if (ep.contains('FROM+Contact')) {
            records.add(new Map<String, Object>{
                'Id' => CON_ID, 'FirstName' => 'Mig', 'LastName' => 'Test Contact',
                'Email' => 'mig@example.com', 'Phone' => '555-0100'
            });
        } else if (ep.contains('FROM+Opportunity')) {
            records.add(new Map<String, Object>{
                'Id' => OPP_ID, 'Name' => 'Mig Test Opp', 'StageName' => 'Prospecting',
                'CloseDate' => '2026-12-31', 'Amount' => 100
            });
        } else if (ep.contains('FROM+Case')) {
            records.add(new Map<String, Object>{
                'Id' => CASE_ID, 'Subject' => 'Mig Test Case', 'Status' => 'New',
                'Description' => 'desc', 'Origin' => 'Web'
            });
        }

        res.setBody(JSON.serialize(new Map<String, Object>{
            'records' => records, 'done' => true, 'totalSize' => records.size()
        }));
        return res;
    }
}
