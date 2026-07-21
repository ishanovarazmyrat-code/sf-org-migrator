/**
 * Minimal local web UI for the migration tool. No external dependencies.
 *
 *   node server.js        then open http://localhost:4599
 *
 * Buttons run the same CLI commands (stats / records / run / verify) as child
 * processes and stream their output live to the page. This hides the terminal
 * for people who don't want to use it.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.UI_PORT || 4599;
const CLI = path.join(__dirname, 'cli.js');

// Only these commands can be triggered from the UI (no destructive/interactive ones).
const ALLOWED = new Set(['stats', 'records', 'run', 'verify']);

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  if (url.pathname === '/run') {
    const cmd = url.searchParams.get('cmd');
    if (!ALLOWED.has(cmd)) {
      res.writeHead(400);
      return res.end('bad command');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const args = [CLI, cmd];
    if (url.searchParams.get('allVersions') === '1' && cmd === 'run') args.push('--all-versions');
    // Run in the user's working directory so work/, .auth/, config resolve there.
    const child = spawn('node', args, { cwd: process.cwd() });
    child.stdout.on('data', (d) => d.toString().split('\n').forEach((l) => l && send('log', l)));
    child.stderr.on('data', (d) => d.toString().split('\n').forEach((l) => l && send('log', l)));
    child.on('close', (code) => {
      send('done', { code });
      res.end();
    });
    req.on('close', () => child.kill());
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// Bind to localhost only — the UI can trigger migrations, so it must never
// be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Migration UI running at  http://localhost:${PORT}  (localhost only)\n`);
});
