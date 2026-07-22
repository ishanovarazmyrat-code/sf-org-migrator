/**
 * Record migration — the "no Named Credential" path.
 *
 * Migrates records object-by-object directly between two orgs using the
 * tool's auth (OAuth / CLI / .env). Each record is upserted into the target
 * on its Legacy_<Object>_Id__c external Id, and lookup/master-detail parents
 * are re-pointed to the already-migrated target records.
 *
 * FIELD MAPPING
 * By default (fields omitted or "auto") the field list is DISCOVERED, not
 * hand-written: both orgs are described, and the migrated set is the
 * intersection of writable fields, excluding what can't or shouldn't be
 * copied:
 *   - formula/calculated and auto-number fields (not writable)
 *   - system audit fields (not createable)
 *   - reference (lookup) fields NOT declared in `parents` — a raw source-org
 *     Id would be meaningless in the target, so unmapped lookups are skipped
 *     and reported
 *   - compound fields (address/location) — their components are copied
 * RecordTypeId is handled specially: mapped source RT -> target RT by
 * DeveloperName when both orgs have record types for the object.
 *
 * An explicit `fields` array is validated the same way: unwritable/unsafe
 * entries are dropped with a warning instead of failing the run.
 *
 * Objects are processed in the order given, so list parents before children.
 */
const sf = require('./sf');

// Default objects. `fields: 'auto'` = discover from describe. Order matters:
// parents first. `parents` maps a lookup field -> the object it points to.
const DEFAULT_OBJECTS = [
  { name: 'Account', externalId: 'Legacy_Account_Id__c', fields: 'auto' },
  {
    name: 'Contact',
    externalId: 'Legacy_Contact_Id__c',
    fields: 'auto',
    parents: { AccountId: 'Account' },
  },
  {
    name: 'Opportunity',
    externalId: 'Legacy_Opportunity_Id__c',
    fields: 'auto',
    parents: { AccountId: 'Account' },
  },
  {
    name: 'Case',
    externalId: 'Legacy_Case_Id__c',
    fields: 'auto',
    parents: { AccountId: 'Account', ContactId: 'Contact' },
  },
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Builds the concrete field list for one object: which fields to copy, and
 * how to map RecordTypeId. Returns { fields, recordTypeMap, warnings }.
 */
async function buildFieldPlan(source, target, objCfg, log) {
  const { name, externalId, parents = {} } = objCfg;
  const parentFields = new Set(Object.keys(parents));

  const [srcDesc, tgtDesc] = await Promise.all([
    sf.withRetry(source, () => source.sobject(name).describe(), { label: `describe ${name}` }),
    sf.withRetry(target, () => target.sobject(name).describe(), { label: `describe ${name}` }),
  ]);
  const srcFields = new Map(srcDesc.fields.map((f) => [f.name, f]));
  const tgtFields = new Map(tgtDesc.fields.map((f) => [f.name, f]));

  const warnings = [];
  const isCopyable = (fname) => {
    const s = srcFields.get(fname);
    const t = tgtFields.get(fname);
    if (!s) return `${fname}: not on source ${name}`;
    if (!t) return `${fname}: not on target ${name}`;
    if (!t.createable && !t.updateable) return `${fname}: not writable on target`;
    if (t.calculated || s.calculated) return `${fname}: formula field`;
    if (t.autoNumber || s.autoNumber) return `${fname}: auto-number`;
    if (s.type === 'address' || s.type === 'location') return `${fname}: compound (components are copied instead)`;
    if (s.type === 'reference' && !parentFields.has(fname) && fname !== 'RecordTypeId') {
      return `${fname}: lookup not mapped in "parents" (source Ids don't exist in the target)`;
    }
    return null;
  };

  let candidates;
  const auto = !objCfg.fields || objCfg.fields === 'auto';
  if (auto) {
    candidates = [...srcFields.keys()].filter(
      (f) => f !== 'Id' && f !== externalId && !parentFields.has(f)
    );
  } else {
    candidates = objCfg.fields.filter((f) => f !== 'Id' && f !== externalId);
  }

  const valid = [];
  let recordTypeWanted = false;
  for (const f of candidates) {
    if (f === 'RecordTypeId') {
      recordTypeWanted = true;
      continue;
    }
    const why = isCopyable(f);
    if (why == null) valid.push(f);
    else if (!auto) warnings.push(`dropped ${why}`);
    // in auto mode, silently skip system/formula noise — only explicit lists warn
  }

  // State & Country Picklists: when a field has a copyable ISO-code partner
  // (BillingState -> BillingStateCode), send the CODE and skip the text —
  // codes are org-independent, text integration values often differ between
  // orgs ("USA" vs "United States") and fail with FIELD_INTEGRITY_EXCEPTION.
  const validSet = new Set(valid);
  const fields = valid.filter((f) => !validSet.has(f + 'Code'));

  // RecordTypeId: map by DeveloperName when both orgs have RTs for the object.
  let recordTypeMap = null;
  const srcHasRT = srcFields.has('RecordTypeId');
  const tgtHasRT = tgtFields.has('RecordTypeId');
  if ((auto || recordTypeWanted) && srcHasRT && tgtHasRT) {
    const [srcRTs, tgtRTs] = await Promise.all([
      sf.queryAllRecords(source, `SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = '${name}'`),
      sf.queryAllRecords(target, `SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = '${name}'`),
    ]);
    if (srcRTs.length && tgtRTs.length) {
      const tgtByName = new Map(tgtRTs.map((r) => [r.DeveloperName, r.Id]));
      recordTypeMap = new Map();
      for (const r of srcRTs) {
        if (tgtByName.has(r.DeveloperName)) recordTypeMap.set(r.Id, tgtByName.get(r.DeveloperName));
        else warnings.push(`record type "${r.DeveloperName}" missing in target — records keep the target default`);
      }
    }
  }

  // Heads-up for required target fields we won't be filling.
  for (const [fname, t] of tgtFields) {
    if (
      t.createable && !t.nillable && !t.defaultedOnCreate &&
      fname !== externalId && !fields.includes(fname) &&
      !parentFields.has(fname) && fname !== 'Id'
    ) {
      warnings.push(`target requires ${fname} but it is not in the migrated set — inserts may fail`);
    }
  }

  for (const w of warnings) log(`  (i) ${name}: ${w}`);
  return { fields, recordTypeMap };
}

/** target sourceId -> targetId map for one object, from its external Id field. */
async function buildLegacyMap(target, objCfg) {
  const map = new Map();
  const rows = await sf.queryAllRecords(
    target,
    `SELECT Id, ${objCfg.externalId} FROM ${objCfg.name} WHERE ${objCfg.externalId} != null`
  );
  for (const r of rows) map.set(r[objCfg.externalId], r.Id);
  return map;
}

async function migrateRecords(source, target, objects, log = console.log) {
  const byName = Object.fromEntries(objects.map((o) => [o.name, o]));
  const legacyMaps = {}; // objectName -> Map(sourceId -> targetId)
  const summary = [];
  const failures = []; // { phase, object, sourceId, reason } — for the CSV report

  for (const obj of objects) {
    const { name, externalId, parents = {}, where } = obj;
    const parentFields = Object.keys(parents);

    const plan = await buildFieldPlan(source, target, obj, log);
    const selectFields = [...new Set([
      'Id',
      ...plan.fields,
      ...parentFields,
      ...(plan.recordTypeMap ? ['RecordTypeId'] : []),
    ])];

    let soql = `SELECT ${selectFields.join(', ')} FROM ${name}`;
    if (where) soql += ` WHERE ${where}`;
    const rows = await sf.queryAllRecords(source, soql);
    log(`\n[${name}] ${rows.length} source record(s), copying ${plan.fields.length} field(s)`);

    // Make sure every parent object's source->target map is ready.
    for (const parentObj of Object.values(parents)) {
      if (!legacyMaps[parentObj] && byName[parentObj]) {
        legacyMaps[parentObj] = await buildLegacyMap(target, byName[parentObj]);
      }
    }

    const toUpsert = [];
    let skipped = 0;
    for (const r of rows) {
      const rec = {};
      for (const f of plan.fields) {
        if (r[f] !== undefined && r[f] !== null) rec[f] = r[f];
      }
      if (plan.recordTypeMap && r.RecordTypeId && plan.recordTypeMap.has(r.RecordTypeId)) {
        rec.RecordTypeId = plan.recordTypeMap.get(r.RecordTypeId);
      }

      let missingParent = null;
      for (const [lookup, parentObj] of Object.entries(parents)) {
        const srcParentId = r[lookup];
        if (srcParentId == null) {
          rec[lookup] = null;
          continue;
        }
        const targetParentId = legacyMaps[parentObj] && legacyMaps[parentObj].get(srcParentId);
        if (!targetParentId) {
          missingParent = `${lookup} -> ${parentObj} ${srcParentId}`; // not migrated yet
          break;
        }
        rec[lookup] = targetParentId;
      }
      if (missingParent) {
        skipped++;
        failures.push({ phase: 'records', object: name, sourceId: r.Id, reason: `parent not migrated: ${missingParent}` });
        continue;
      }
      rec[externalId] = r.Id;
      toUpsert.push(rec);
    }

    let upserted = 0;
    let failed = 0;
    for (const c of chunk(toUpsert, 200)) {
      const res = await sf.withRetry(
        target,
        () => target.sobject(name).upsert(c, externalId, { allOrNone: false }),
        { label: `upsert ${name}` }
      );
      const results = Array.isArray(res) ? res : [res];
      results.forEach((r, i) => {
        if (r.success) upserted++;
        else {
          failed++;
          const srcId = c[i] && c[i][externalId];
          const reason = JSON.stringify(r.errors);
          failures.push({ phase: 'records', object: name, sourceId: srcId, reason });
          log(`  FAILED ${name} (source ${srcId}): ${reason}`);
        }
      });
    }

    legacyMaps[name] = await buildLegacyMap(target, obj); // for child objects
    log(`[${name}] upserted ${upserted}, skipped ${skipped} (parent missing), failed ${failed}`);
    summary.push({ name, source: rows.length, upserted, skipped, failed });
  }

  return { summary, failures };
}

module.exports = { migrateRecords, DEFAULT_OBJECTS, buildFieldPlan };
