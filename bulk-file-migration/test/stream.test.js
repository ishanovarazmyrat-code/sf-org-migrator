const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sf = require('../lib/sf');

// Two real HTTP servers stand in for the two orgs, so the whole path is
// exercised end to end: the GET against the source, the multipart POST into
// the target, Content-Length bookkeeping, and the bytes in between.

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Source org: serves `body` as a ContentVersion's VersionData. */
function fakeSource(body, { status = 200 } = {}) {
  const hits = [];
  return listen((req, res) => {
    hits.push(req.url);
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end('{"message":"nope"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  }).then((s) => ({ ...s, hits }));
}

/** Target org: accepts the multipart POST and records what actually arrived. */
function fakeTarget({ status = 201, failFirst = 0 } = {}) {
  const received = [];
  let calls = 0;
  return listen((req, res) => {
    calls++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      received.push({
        bytes: raw.length,
        contentLength: Number(req.headers['content-length']),
        body: raw,
      });
      if (calls <= failFirst) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"message":"Session expired or invalid"}');
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `068FAKE${calls}`, success: true }));
    });
  }).then((s) => ({ ...s, received, calls: () => calls }));
}

function conn(port, prefix) {
  return {
    instanceUrl: `http://127.0.0.1:${port}`,
    version: '64.0',
    accessToken: 'token',
    $prefix: prefix,
  };
}

const META = { Title: 'doc', PathOnClient: 'doc.bin' };

test('streams a file from the source org into the target without touching disk', async () => {
  const payload = Buffer.alloc(64 * 1024, 7); // bigger than one chunk
  const src = await fakeSource(payload);
  const tgt = await fakeTarget();
  try {
    const res = await sf.streamVersionBetweenOrgs(
      conn(src.port, 'SOURCE'),
      conn(tgt.port, 'TARGET'),
      '068abc',
      META,
      payload.length
    );

    assert.equal(res.success, true);
    assert.equal(tgt.received.length, 1);

    const got = tgt.received[0];
    // The declared length must match what was actually sent, or Salesforce
    // would hang waiting for the rest of the body.
    assert.equal(got.bytes, got.contentLength);
    // And the payload must survive the hop intact.
    assert.ok(got.body.includes(payload), 'the source bytes arrived unchanged');
    assert.match(src.hits[0], /068abc\/VersionData$/);
  } finally {
    src.server.close();
    tgt.server.close();
  }
});

test('a source shorter than its declared ContentSize fails loudly instead of uploading a truncated file', async () => {
  const src = await fakeSource(Buffer.alloc(100));
  const tgt = await fakeTarget();
  try {
    await assert.rejects(
      () =>
        sf.streamVersionBetweenOrgs(
          conn(src.port, 'SOURCE'),
          conn(tgt.port, 'TARGET'),
          '068abc',
          META,
          999999 // manifest says ~1MB, source serves 100 bytes
        ),
      /size mismatch: expected 999999 bytes, streamed 100/
    );
  } finally {
    src.server.close();
    tgt.server.close();
  }
});

test('a 401 from the target re-authenticates both orgs and retries with a fresh source stream', async () => {
  const payload = Buffer.alloc(1024, 3);
  const src = await fakeSource(payload);
  const tgt = await fakeTarget({ failFirst: 1 });
  let sourceReauths = 0;
  let targetReauths = 0;
  try {
    const source = { ...conn(src.port, 'SOURCE'), $reauth: async () => void sourceReauths++ };
    const target = { ...conn(tgt.port, 'TARGET'), $reauth: async () => void targetReauths++ };

    const res = await sf.streamVersionBetweenOrgs(source, target, '068abc', META, payload.length);

    assert.equal(res.success, true);
    assert.equal(tgt.calls(), 2, 'first attempt 401d, second succeeded');
    assert.equal(sourceReauths, 1, 'the source is refreshed too — the 401 could be its own');
    assert.equal(targetReauths, 1);
    // The retry must have re-fetched the binary: a consumed stream is empty.
    assert.equal(src.hits.length, 2);
    assert.equal(tgt.received[1].bytes, tgt.received[1].contentLength);
  } finally {
    src.server.close();
    tgt.server.close();
  }
});

test('a non-200 from the source is reported rather than uploading an error page as the file', async () => {
  const src = await fakeSource(null, { status: 404 });
  const tgt = await fakeTarget();
  try {
    await assert.rejects(
      () =>
        sf.streamVersionBetweenOrgs(conn(src.port, 'SOURCE'), conn(tgt.port, 'TARGET'), '068abc', META, 10),
      /HTTP 404/
    );
    assert.equal(tgt.received.length, 0, 'nothing was written to the target org');
    // A missing version will be missing on every attempt, so the error carries
    // its status and the retry logic gives up immediately instead of burning
    // three rounds of backoff per file.
    assert.equal(src.hits.length, 1, 'a 404 is deterministic — not retried');
  } finally {
    src.server.close();
    tgt.server.close();
  }
});

test('openVersionStream hands back a readable body for a 200', async () => {
  const src = await fakeSource(Buffer.from('hello'));
  try {
    const res = await sf.openVersionStream(conn(src.port, 'SOURCE'), '068abc');
    const chunks = [];
    for await (const c of res) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), 'hello');
  } finally {
    src.server.close();
  }
});
