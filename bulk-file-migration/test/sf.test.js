const { test } = require('node:test');
const assert = require('node:assert/strict');
const sf = require('../lib/sf');

test('isTransient() treats known deterministic Salesforce error codes as non-retryable', () => {
  for (const code of ['INVALID_FIELD', 'REQUIRED_FIELD_MISSING', 'DUPLICATE_VALUE', 'STRING_TOO_LONG']) {
    assert.equal(sf.isTransient({ errorCode: code, message: 'x' }), false, code);
  }
});

test('isTransient() retries session errors', () => {
  assert.equal(sf.isTransient({ statusCode: 401, message: 'x' }), true);
  assert.equal(sf.isTransient({ errorCode: 'INVALID_SESSION_ID', message: 'x' }), true);
  assert.equal(sf.isTransient({ message: 'INVALID_SESSION_ID: session expired' }), true);
});

test('isTransient() retries rate limiting and server errors, not other 4xx', () => {
  assert.equal(sf.isTransient({ statusCode: 429, message: 'x' }), true);
  assert.equal(sf.isTransient({ statusCode: 500, message: 'x' }), true);
  assert.equal(sf.isTransient({ statusCode: 503, message: 'x' }), true);
  // A generic 4xx with no known deterministic code and no matching message text
  // is treated as deterministic (client errors don't fix themselves on retry).
  assert.equal(sf.isTransient({ statusCode: 403, message: 'Forbidden' }), false);
});

test('isTransient() retries known transient network error codes', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']) {
    assert.equal(sf.isTransient({ code, message: 'x' }), true, code);
  }
});

test('isTransient() defaults unknown errors to retryable (conservative)', () => {
  assert.equal(sf.isTransient({ message: 'something we have never seen before' }), true);
});

test('isTransient() returns false for a falsy error', () => {
  assert.equal(sf.isTransient(null), false);
  assert.equal(sf.isTransient(undefined), false);
});

test('createLimiter() never runs more than N functions concurrently', async () => {
  const limit = sf.createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = () =>
    limit(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return 'ok';
    });
  const results = await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(maxActive <= 2, true, `expected max 2 concurrent, saw ${maxActive}`);
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('createLimiter() propagates a rejection without blocking later tasks', async () => {
  const limit = sf.createLimiter(1);
  await assert.rejects(() => limit(async () => { throw new Error('boom'); }), /boom/);
  // The queue must keep moving after a failure.
  const after = await limit(async () => 'still works');
  assert.equal(after, 'still works');
});

function fakeConn() {
  return { $prefix: 'TEST', $reauth: async () => { fakeConn.reauthCalls = (fakeConn.reauthCalls || 0) + 1; } };
}

test('withRetry() returns the result immediately on first success', async () => {
  const conn = fakeConn();
  const result = await sf.withRetry(conn, async () => 'value', { tries: 3 });
  assert.equal(result, 'value');
});

test('withRetry() retries a transient failure and succeeds', async () => {
  const conn = fakeConn();
  let calls = 0;
  const result = await sf.withRetry(
    conn,
    async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('server busy');
        err.statusCode = 503;
        throw err;
      }
      return 'recovered';
    },
    { tries: 4 }
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('withRetry() fails fast on a deterministic error without exhausting all tries', async () => {
  const conn = fakeConn();
  let calls = 0;
  await assert.rejects(
    () =>
      sf.withRetry(
        conn,
        async () => {
          calls++;
          const err = new Error('bad field');
          err.errorCode = 'INVALID_FIELD';
          throw err;
        },
        { tries: 5 }
      ),
    /bad field/
  );
  assert.equal(calls, 1, 'a deterministic error should not be retried');
});

test('withRetry() re-authenticates on a session error and keeps going', async () => {
  const conn = fakeConn();
  let reauthCalls = 0;
  conn.$reauth = async () => { reauthCalls++; };
  let calls = 0;
  const result = await sf.withRetry(
    conn,
    async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('session expired');
        err.errorCode = 'INVALID_SESSION_ID';
        throw err;
      }
      return 'ok-after-reauth';
    },
    { tries: 3 }
  );
  assert.equal(result, 'ok-after-reauth');
  assert.equal(reauthCalls, 1);
});

test('withRetry() throws the last error once all tries are exhausted', async () => {
  const conn = fakeConn();
  await assert.rejects(
    () =>
      sf.withRetry(
        conn,
        async () => {
          const err = new Error('still down');
          err.statusCode = 500;
          throw err;
        },
        { tries: 2 }
      ),
    /still down/
  );
});
