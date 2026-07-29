const { test } = require('node:test');
const assert = require('node:assert/strict');
const { linkSharing, SAFE_SHARING } = require('../lib/links');

test('linkSharing() preserves Collaborator access instead of downgrading it', () => {
  assert.deepEqual(linkSharing({ shareType: 'C', visibility: 'InternalUsers' }), {
    ShareType: 'C',
    Visibility: 'InternalUsers',
  });
});

test('linkSharing() preserves Visibility as recorded', () => {
  assert.equal(linkSharing({ shareType: 'V', visibility: 'AllUsers' }).Visibility, 'AllUsers');
});

test('linkSharing() turns Inferred into Viewer — an insert cannot express "I"', () => {
  assert.equal(linkSharing({ shareType: 'I', visibility: 'InternalUsers' }).ShareType, 'V');
});

test('linkSharing() falls back to Viewer for manifests written before sharing was captured', () => {
  assert.deepEqual(linkSharing({ src: '001x', target: '001y', state: 'pending' }), { ShareType: 'V' });
  assert.deepEqual(linkSharing(), { ShareType: 'V' });
});

test('linkSharing() omits Visibility when the source had none, letting the org default apply', () => {
  assert.equal('Visibility' in linkSharing({ shareType: 'C' }), false);
});

test('SAFE_SHARING is the combination every org accepts', () => {
  assert.deepEqual(SAFE_SHARING, { ShareType: 'V', Visibility: 'InternalUsers' });
});
