// Seeds the SOURCE org with sample records + files, so there's something to
// migrate. Run against the source org:
//   sf apex run --file tools/seed-source.apex --target-org sourceOrg

List<String> names = new List<String>{ 'Acme Corp', 'Globex', 'Initech' };
List<Account> accounts = new List<Account>();
for (String n : names) accounts.add(new Account(Name = n));
insert accounts;

List<Contact> contacts = new List<Contact>();
List<Opportunity> opps = new List<Opportunity>();
List<Case> cases = new List<Case>();
for (Account a : accounts) {
    contacts.add(new Contact(LastName = a.Name + ' Contact', AccountId = a.Id));
    opps.add(new Opportunity(
        Name = a.Name + ' Deal', StageName = 'Prospecting',
        CloseDate = Date.today().addDays(30), AccountId = a.Id));
    cases.add(new Case(Subject = a.Name + ' Issue', Status = 'New', AccountId = a.Id));
}
insert contacts;
insert opps;
insert cases;

// Attach a file to each Account and each Opportunity.
Map<Id, String> targets = new Map<Id, String>();
for (Account a : accounts) targets.put(a.Id, a.Name + '_Overview');
for (Opportunity o : opps) targets.put(o.Id, o.Name + '_Quote');

for (Id parentId : targets.keySet()) {
    String title = targets.get(parentId);
    ContentVersion cv = new ContentVersion(
        Title = title,
        PathOnClient = title + '.txt',
        VersionData = Blob.valueOf('Sample file for ' + title + '. '.repeat(50)));
    insert cv;
    Id docId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;
    insert new ContentDocumentLink(
        ContentDocumentId = docId, LinkedEntityId = parentId, ShareType = 'V');
}

System.debug('Seeded ' + accounts.size() + ' accounts, ' + contacts.size() + ' contacts, '
    + opps.size() + ' opps, ' + cases.size() + ' cases, ' + targets.size() + ' files.');
