// Adds a new version (v2) to 2 existing files in the SOURCE org, so you can
// test that version history migrates. Run against the source org:
//   sf apex run --file tools/seed-versions.apex --target-org sourceOrg

List<ContentDocument> docs = [SELECT Id, Title FROM ContentDocument ORDER BY CreatedDate LIMIT 2];
for (ContentDocument d : docs) {
    ContentVersion cv = new ContentVersion(
        ContentDocumentId = d.Id,               // same document -> a new version
        Title = d.Title,
        PathOnClient = d.Title + '.txt',
        VersionData = Blob.valueOf('UPDATED v2 of ' + d.Title + ' at ' + System.now()));
    insert cv;
}
System.debug('Added a v2 to ' + docs.size() + ' file(s): ' + docs);
