'use strict';

// Spec flows 1 to 5: split vs direct event marking and split-only stats.
// A fresh server with an empty log, driven through the exact flow order.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');

// A request with no User-Agent counts as a crawler, so every test that
// expects browser behaviour sends one.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let server;
let port;
let logFile;

// The page flow 1 was assigned; set in flow 1 and reused by flows 2 and 4.
let assigned;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function request(reqPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: { 'User-Agent': BROWSER_UA, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function logLines() {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

// The server appends log lines asynchronously (it never delays a response
// for logging), so a line may land just after the response: poll briefly.
function waitForLogCount(n, ms = 2000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    (function poll() {
      const lines = logLines();
      if (lines.length >= n || Date.now() > deadline) return resolve(lines);
      setTimeout(poll, 20);
    })();
  });
}

function waitForServer(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      request('/t.js')
        .then(resolve)
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error('server did not start'));
          setTimeout(poll, 100);
        });
    })();
  });
}

// Read the via marker the server injected on the tracker script tag, the
// same attribute t.js reads, and post the event the tracker would send.
function servedVia(html) {
  const m = /<script src="\/t\.js"[^>]*data-via="([^"]*)"/.exec(html);
  assert.ok(m, 'served page carries a data-via marker on the tracker tag');
  return m[1];
}

function postEvent(page, event, via) {
  return request('/e?page=' + page + '&event=' + event + '&via=' + via, {
    method: 'POST',
  });
}

function runStats(args) {
  return spawnSync('sh', [path.join(ROOT, 'stats.sh'), ...args], {
    encoding: 'utf8',
  });
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-split-test-'));
  logFile = path.join(dir, 'events.log');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), LOG_FILE: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(5000);
});

test.after(() => {
  if (server) server.kill('SIGTERM');
});

test('flow 1: with an empty log, GET / once yields exactly one view split line', async () => {
  assert.equal(logLines().length, 0, 'the log starts empty');
  const res = await request('/');
  assert.equal(res.status, 200);
  assigned = /tc_ab=(a|b)/.exec(res.headers['set-cookie'][0])[1];
  assert.equal(servedVia(res.body.toString('utf8')), 'split', 'page served at / is marked split');

  const lines = await waitForLogCount(1);
  assert.equal(lines.length, 1, 'exactly one line');
  assert.match(
    lines[0],
    new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ' + assigned + ' view split first$')
  );
});

test('flow 2: a Copy click and a GitHub repo follow on that page append copy and outbound lines ending in split', async () => {
  // Re-fetch with the cookie, as the assigned visitor, and send what the
  // tracker on that page would send: the server-injected via value.
  const res = await request('/', { headers: { Cookie: 'tc_ab=' + assigned } });
  const via = servedVia(res.body.toString('utf8'));
  assert.equal(via, 'split');
  assert.equal((await postEvent(assigned, 'copy', via)).status, 204);
  assert.equal((await postEvent(assigned, 'outbound', via)).status, 204);

  const lines = await waitForLogCount(4);
  assert.equal(lines.length, 4);
  // Events posted without the cookie (as from a visitor whose first action
  // was already logged) are split repeat.
  assert.match(lines[1], new RegExp(' ' + assigned + ' view split repeat$'));
  assert.match(lines[2], new RegExp(' ' + assigned + ' copy split repeat$'));
  assert.match(lines[3], new RegExp(' ' + assigned + ' outbound split repeat$'));
});

test('flow 3: opening /b/ directly, Copy and the npm link append view, copy and outbound lines for b ending in direct', async () => {
  const res = await request('/b/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'], undefined, '/b/ sets no cookie');
  const via = servedVia(res.body.toString('utf8'));
  assert.equal(via, 'direct', 'page served at /b/ is marked direct');
  assert.equal((await postEvent('b', 'copy', via)).status, 204);
  assert.equal((await postEvent('b', 'outbound', via)).status, 204);

  const lines = await waitForLogCount(7);
  assert.equal(lines.length, 7);
  assert.match(lines[4], / b view direct repeat$/);
  assert.match(lines[5], / b copy direct repeat$/);
  assert.match(lines[6], / b outbound direct repeat$/);
});

test('flow 4: stats.sh counts visitors from split first lines only and reports direct views separately', () => {
  const out = runStats([logFile]);
  assert.equal(out.status, 0, out.stderr);
  const other = assigned === 'a' ? 'b' : 'a';
  const pad = (v, w) => String(v).padStart(w);
  // The flow-1 page: 1 'view split first' visitor; the events here were
  // posted cookie-free, so they are split repeat and nobody has acted.
  assert.ok(
    out.stdout.includes(
      'page ' + assigned + ':  visitors=' + pad(1, 7) + '  acted=' + pad(0, 7) +
        '  conversion=' + pad('0.0%', 7)
    ),
    'visitor figures for the assigned page:\n' + out.stdout
  );
  assert.ok(
    out.stdout.includes(
      'page ' + assigned + ':  copies=' + pad(1, 9) + '  outbound=' + pad(1, 4) +
        '  (split event totals, for reference)'
    ),
    'split event totals for the assigned page:\n' + out.stdout
  );
  // Nothing from flow 3 reaches the comparison:
  assert.ok(
    out.stdout.includes(
      'page ' + other + ':  visitors=' + pad(0, 7) + '  acted=' + pad(0, 7) +
        '  conversion=' + pad('0.0%', 7)
    ),
    'the other page stays at zero in the comparison:\n' + out.stdout
  );
  // Flow 3's direct view is reported separately, labelled:
  assert.ok(
    out.stdout.includes('page b:  direct views=' + pad(1, 3) + '  (not part of the comparison)'),
    'direct views for page b:\n' + out.stdout
  );
  assert.ok(
    out.stdout.includes('page a:  direct views=' + pad(0, 3) + '  (not part of the comparison)'),
    'direct views for page a:\n' + out.stdout
  );
  // The comparison lines come before the direct-views lines:
  assert.ok(
    out.stdout.indexOf('conversion=') < out.stdout.indexOf('direct views='),
    'comparison first, direct views after'
  );
});

test('flow 5: stats.sh reports old three- and four-field lines only on the legacy line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-legacy-stats-'));
  const log = path.join(dir, 'events.log');
  const t = '2026-11-20T12:00:00.000Z';
  fs.writeFileSync(
    log,
    [
      t + ' a view',
      t + ' a view',
      t + ' a copy',
      t + ' b view',
      t + ' b outbound',
      t + ' b view direct',
    ].join('\n') + '\n'
  );
  const out = runStats([log]);
  assert.equal(out.status, 0, out.stderr);
  // Four legacy views (two a, one b, one b direct); nothing else counted.
  assert.equal(
    out.stdout,
    'Visitors per page from split lines; acted = first copy or outbound; conversion = acted / visitors\n' +
      'page a:  visitors=      0  acted=      0  conversion=   0.0%\n' +
      'page b:  visitors=      0  acted=      0  conversion=   0.0%\n' +
      'page a:  copies=        0  outbound=   0  (split event totals, for reference)\n' +
      'page b:  copies=        0  outbound=   0  (split event totals, for reference)\n' +
      'page a:  direct views=  0  (not part of the comparison)\n' +
      'page b:  direct views=  0  (not part of the comparison)\n' +
      'page a:  bot views=     0  (not part of the comparison)\n' +
      'page b:  bot views=     0  (not part of the comparison)\n' +
      'views logged before visitor counting began: 4\n' +
      'page a:  services clicks=   0  (split lines, not part of the conversion rate)\n' +
      'page b:  services clicks=   0  (split lines, not part of the conversion rate)\n' +
      'page a:  enquiries=      0  (not part of the conversion rate)\n' +
      'page b:  enquiries=      0  (not part of the conversion rate)\n' +
      'page -:  enquiries=      0  (no split cookie, not part of the conversion rate)\n'
  );
});

test('no em dash in the files this phase touched', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const f of [
    'server.js',
    'stats.sh',
    'README.md',
    path.join('site', 't.js'),
    path.join('site', 'how-it-was-tested', 'index.html'),
    path.join('reference', 'writeup.html'),
    path.join('test', 'split.test.js'),
  ]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(!text.includes(emDash), 'U+2014 em dash found in ' + f);
  }
});
