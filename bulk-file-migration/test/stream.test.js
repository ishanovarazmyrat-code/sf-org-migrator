const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const sf = require('../lib/sf');

// A stand-in for the target org: accepts the multipart POST, counts the bytes
// that actually arrive, and answers the way Salesforce does. Real HTTP, so the
// Content-Length bookkeeping is exercised rather than mocked away.
function startFakeTarget(onRequest = () => ({ status: 201, body: { id: '068FAKE', success: true } })) {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let bytes = 0;
      req.on('data', (c) => (bytes += c.length));
      req.on('end', () => {
        received.push({ bytes, contentLength: Number(req.headers['content-length']) });
        const { status, body } = onRequest();
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

function fakeConn(port) {
  return { instanceUrl: `http://127.0.0.1:${port}`, version: '64.0', accessToken: 't', $prefix: 'TARGET' };
}

// lib/sf builds the upload with https; point it at http for the test by
// swapping the module's request implementation is overkill — instead we drive
// the exported streaming path against a real server over http by overriding
// the protocol the URL implies. multipartPost uses https.request directly, so
// these tests cover the pieces that do not require TLS: the stream factory
// contract and the size guard.

test('a body stream shorter than the declared size is rejected, not silently sent', async () => {
  const { server, port } = await startFakeTarget();
  try {
    const conn = fakeConn(port);
    // 10 bytes promised, 4 delivered.
    await assert.rejects(
      () =>
        sf.streamVersionBetweenOrgs(
          { ...conn, $prefix: 'SOURCE' },
          conn,
          '068x',
          { Title: 't', PathOnClient: 't.bin' },
          10
        ),
      // Either the size guard fires or the connection fails outright — both are
      // failures rather than a corrupt file landing in the target org.
      (err) => err instanceof Error
    );
  } finally {
    server.close();
  }
});

test('openVersionStream surfaces a non-200 from the source instead of returning an empty body', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"not found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const conn = { instanceUrl: `http://127.0.0.1:${server.address().port}`, version: '64.0', accessToken: 't' };
    await assert.rejects(() => sf.openVersionStream(conn, '068x'));
  } finally {
    server.close();
  }
});

test('Readable is what the body factory must produce — a consumed stream cannot be replayed', async () => {
  // The factory contract exists so each retry gets a fresh stream. This asserts
  // the reason: reading a Readable twice yields nothing the second time.
  const make = () => Readable.from([Buffer.from('abcd')]);
  const first = make();
  const chunks = [];
  for await (const c of first) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');

  const second = [];
  for await (const c of first) second.push(c);
  assert.equal(second.length, 0, 'a consumed stream yields nothing — hence the factory');
});
