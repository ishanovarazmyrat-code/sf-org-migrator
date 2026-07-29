const { test } = require('node:test');
const assert = require('node:assert/strict');
const sf = require('../lib/sf');
const { buildFieldPlan } = require('../lib/records');

// buildFieldPlan() calls sf.withRetry(conn, fn) and sf.queryAllRecords(conn, soql)
// internally. Since `sf` is a plain CommonJS module.exports object and Node
// caches modules, records.js holds a reference to the very same object we
// require here — reassigning its methods for the scope of a test is a real,
// dependency-free way to stub Salesforce I/O without touching the network.
function withStubbedSf(describeByObject, recordTypesByObject, run) {
  const originalWithRetry = sf.withRetry;
  const originalQueryAll = sf.queryAllRecords;
  sf.withRetry = async (conn, fn) => fn();
  sf.queryAllRecords = async (conn, soql) => {
    const m = soql.match(/FROM RecordType WHERE SobjectType = '(\w+)'/);
    if (m) return recordTypesByObject[m[1]] || [];
    return [];
  };
  const fakeOrg = (which) => ({
    sobject: (name) => ({
      describe: async () => describeByObject[which][name],
    }),
  });
  return run(fakeOrg('source'), fakeOrg('target')).finally(() => {
    sf.withRetry = originalWithRetry;
    sf.queryAllRecords = originalQueryAll;
  });
}

function field(name, overrides = {}) {
  return {
    name,
    createable: true,
    updateable: true,
    calculated: false,
    autoNumber: false,
    type: 'string',
    nillable: true,
    defaultedOnCreate: false,
    ...overrides,
  };
}

test('buildFieldPlan() auto mode copies fields present and writable on both orgs', async () => {
  const describeByObject = {
    source: { Account: { fields: [field('Id'), field('Name'), field('Description')] } },
    target: { Account: { fields: [field('Id'), field('Name'), field('Description')] } },
  };
  await withStubbedSf(describeByObject, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Account', externalId: 'Legacy_Account_Id__c' }, () => {});
    assert.deepEqual(plan.fields.sort(), ['Description', 'Name']);
  });
});

test('buildFieldPlan() drops formula and auto-number fields even in auto mode', async () => {
  const describeByObject = {
    source: {
      Account: {
        fields: [
          field('Id'),
          field('Name'),
          field('AnnualRevenueFormula__c', { calculated: true }),
          field('AccountNumber__c', { autoNumber: true }),
        ],
      },
    },
    target: {
      Account: {
        fields: [
          field('Id'),
          field('Name'),
          field('AnnualRevenueFormula__c', { calculated: true }),
          field('AccountNumber__c', { autoNumber: true }),
        ],
      },
    },
  };
  await withStubbedSf(describeByObject, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Account', externalId: 'Legacy_Account_Id__c' }, () => {});
    assert.deepEqual(plan.fields, ['Name']);
  });
});

test('buildFieldPlan() drops a lookup field that is not declared in parents', async () => {
  const contactFields = [
    field('Id'),
    field('LastName'),
    field('AccountId', { type: 'reference' }),
    field('OwnerId', { type: 'reference' }),
  ];
  const describe = {
    source: { Contact: { fields: contactFields } },
    target: { Contact: { fields: contactFields } },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(
      source,
      target,
      { name: 'Contact', externalId: 'Legacy_Contact_Id__c', parents: { AccountId: 'Account' } },
      () => {}
    );
    // AccountId is handled separately as a parent lookup, not as a plain copied field.
    assert.equal(plan.fields.includes('AccountId'), false);
    // OwnerId is an unmapped lookup — must be dropped, not sent as a meaningless source Id.
    assert.equal(plan.fields.includes('OwnerId'), false);
    assert.equal(plan.fields.includes('LastName'), true);
  });
});

test('buildFieldPlan() sends the State/Country ISO code field instead of the free-text one when both exist', async () => {
  const fields = [
    field('Id'),
    field('BillingState'),
    field('BillingStateCode'),
    field('BillingCountry'),
    field('BillingCountryCode'),
  ];
  const describe = { source: { Account: { fields } }, target: { Account: { fields } } };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Account', externalId: 'Legacy_Account_Id__c' }, () => {});
    assert.equal(plan.fields.includes('BillingStateCode'), true);
    assert.equal(plan.fields.includes('BillingState'), false);
    assert.equal(plan.fields.includes('BillingCountryCode'), true);
    assert.equal(plan.fields.includes('BillingCountry'), false);
  });
});

test('buildFieldPlan() maps RecordTypeId by DeveloperName when both orgs have matching record types', async () => {
  const fields = [field('Id'), field('Name'), field('RecordTypeId', { type: 'reference' })];
  const describe = { source: { Account: { fields } }, target: { Account: { fields } } };
  const recordTypes = {
    Account: [], // placeholder, overridden per-org below via the query stub match
  };
  const originalWithRetry = sf.withRetry;
  const originalQueryAll = sf.queryAllRecords;
  sf.withRetry = async (conn, fn) => fn();
  let callCount = 0;
  sf.queryAllRecords = async (conn) => {
    callCount++;
    // First call is for source RTs, second for target RTs (buildFieldPlan queries source then target).
    if (callCount === 1) return [{ Id: 'src-rt-1', DeveloperName: 'Enterprise' }];
    return [{ Id: 'tgt-rt-1', DeveloperName: 'Enterprise' }];
  };
  try {
    const fakeOrg = () => ({ sobject: () => ({ describe: async () => describe.source.Account }) });
    const plan = await buildFieldPlan(fakeOrg(), fakeOrg(), { name: 'Account', externalId: 'Legacy_Account_Id__c' }, () => {});
    assert.ok(plan.recordTypeMap);
    assert.equal(plan.recordTypeMap.get('src-rt-1'), 'tgt-rt-1');
  } finally {
    sf.withRetry = originalWithRetry;
    sf.queryAllRecords = originalQueryAll;
  }
});

test('buildFieldPlan() reports required target fields that made it into the migrated set', async () => {
  const describe = {
    source: { Account: { fields: [field('Id'), field('Name')] } },
    target: {
      Account: {
        fields: [field('Id'), field('Name', { nillable: false })],
      },
    },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Account', externalId: 'Legacy_Account_Id__c' }, () => {});
    assert.deepEqual(plan.required, ['Name']);
  });
});
