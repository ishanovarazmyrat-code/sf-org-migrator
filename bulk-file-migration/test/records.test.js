const { test } = require('node:test');
const assert = require('node:assert/strict');
const sf = require('../lib/sf');
const { buildFieldPlan, migrateRecords } = require('../lib/records');

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

// --- duplicate rule bypass -------------------------------------------------

// migrateRecords() needs more of the org stubbed than buildFieldPlan does:
// source rows, the legacy-Id lookup, and the upsert itself. This captures the
// options the upsert was called with, which is what the header rides on.
function runMigrateCapturingUpsert(options) {
  const originalWithRetry = sf.withRetry;
  const originalQueryAll = sf.queryAllRecords;
  const calls = [];

  sf.withRetry = async (conn, fn) => fn();
  sf.queryAllRecords = async (conn, soql) =>
    /FROM Account$/.test(soql.trim()) ? [{ Id: '001SRC', Name: 'Acme' }] : [];

  const org = {
    sobject: () => ({
      describe: async () => ({ fields: [field('Id'), field('Name')] }),
      upsert: async (records, extIdField, opts) => {
        calls.push({ records, extIdField, opts });
        return records.map(() => ({ success: true }));
      },
    }),
  };

  return migrateRecords(
    org,
    org,
    [{ name: 'Account', externalId: 'Legacy_Account_Id__c', fields: 'auto' }],
    () => {},
    options
  )
    .then(() => calls)
    .finally(() => {
      sf.withRetry = originalWithRetry;
      sf.queryAllRecords = originalQueryAll;
    });
}

test('migrateRecords() bypasses duplicate rules by default', async () => {
  const calls = await runMigrateCapturingUpsert(undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers['Sforce-Duplicate-Rule-Header'], 'allowSave=true');
  assert.equal(calls[0].opts.allOrNone, false);
});

test('migrateRecords() leaves duplicate rules enforced when allowDuplicates is false', async () => {
  const calls = await runMigrateCapturingUpsert({ allowDuplicates: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers, undefined);
});

test('buildFieldPlan() drops a parent lookup the target will not accept', async () => {
  // Lead.ConvertedAccountId is set by lead conversion, never by an insert.
  // Parent lookups bypass the field list, so without this check every single
  // record fails with INVALID_FIELD_FOR_INSERT_UPDATE.
  const describe = {
    source: { Lead: { fields: [field('Id'), field('Company'), field('ConvertedAccountId', { type: 'reference' }), field('OwnerId', { type: 'reference' })] } },
    target: {
      Lead: {
        fields: [
          field('Id'),
          field('Company'),
          field('ConvertedAccountId', { type: 'reference', createable: false, updateable: false }),
          field('OwnerId', { type: 'reference' }),
        ],
      },
    },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(
      source,
      target,
      { name: 'Lead', externalId: 'Legacy_Lead_Id__c', fields: 'auto', parents: { ConvertedAccountId: 'Account', OwnerId: 'User' } },
      () => {}
    );
    assert.equal('ConvertedAccountId' in plan.parents, false, 'read-only lookup is dropped');
    assert.equal(plan.parents.OwnerId, 'User', 'a writable lookup is kept');
  });
});

test('buildFieldPlan() drops a parent lookup that does not exist on the target', async () => {
  const describe = {
    source: { Lead: { fields: [field('Id'), field('Custom__c', { type: 'reference' })] } },
    target: { Lead: { fields: [field('Id')] } },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(
      source, target,
      { name: 'Lead', externalId: 'Legacy_Lead_Id__c', fields: 'auto', parents: { Custom__c: 'Account' } },
      () => {}
    );
    assert.deepEqual(plan.parents, {});
  });
});

test('buildFieldPlan() drops a create-only field, because upsert has to survive a re-run', async () => {
  // Lead.IsConverted and Opportunity.ContactId describe as createable but not
  // updateable. Records go in by upsert, so such a field lands fine the first
  // time and then fails every record once they exist.
  const describe = {
    source: { Lead: { fields: [field('Id'), field('Company'), field('IsConverted', { type: 'boolean' })] } },
    target: {
      Lead: {
        fields: [
          field('Id'),
          field('Company'),
          field('IsConverted', { type: 'boolean', createable: true, updateable: false }),
        ],
      },
    },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Lead', externalId: 'Legacy_Lead_Id__c', fields: 'auto' }, () => {});
    assert.deepEqual(plan.fields, ['Company']);
  });
});

test('buildFieldPlan() keeps a field that is only updateable — an upsert can still write it', async () => {
  const describe = {
    source: { Account: { fields: [field('Id'), field('Note__c')] } },
    target: { Account: { fields: [field('Id'), field('Note__c', { createable: false, updateable: true })] } },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(source, target, { name: 'Account', externalId: 'Legacy_Account_Id__c', fields: 'auto' }, () => {});
    assert.deepEqual(plan.fields, ['Note__c']);
  });
});

test('buildFieldPlan() drops a create-only parent lookup for the same reason', async () => {
  const describe = {
    source: { Opportunity: { fields: [field('Id'), field('ContactId', { type: 'reference' })] } },
    target: { Opportunity: { fields: [field('Id'), field('ContactId', { type: 'reference', createable: true, updateable: false })] } },
  };
  await withStubbedSf(describe, {}, async (source, target) => {
    const plan = await buildFieldPlan(
      source, target,
      { name: 'Opportunity', externalId: 'Legacy_Opportunity_Id__c', fields: 'auto', parents: { ContactId: 'Contact' } },
      () => {}
    );
    assert.deepEqual(plan.parents, {});
  });
});
