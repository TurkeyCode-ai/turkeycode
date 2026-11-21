'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const EM_DASH = String.fromCharCode(0x2014);

let server;
let port;
let logFile;

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

function request(reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers },
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
    if (body !== null) req.write(body);
    req.end();
  });
}

function logLines() {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

// The server appends log lines asynchronously (it never delays a response for
// logging), so a line may land just after the response: poll briefly.
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
      request('/b/')
        .then(resolve)
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error('server did not start'));
          setTimeout(poll, 100);
        });
    })();
  });
}

function decodeAttr(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-events-test-'));
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

// --- Tracker script -----------------------------------------------------------

test('/t.js is served as javascript, cookie-free, and matches site/t.js', async () => {
  const res = await request('/t.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.equal(res.headers['set-cookie'], undefined, 'no cookie on /t.js');
  const onDisk = fs.readFileSync(path.join(ROOT, 'site', 't.js'));
  assert.ok(res.body.equals(onDisk), '/t.js serves site/t.js bytes');
});

test('tracker uses sendBeacon with fetch keepalive fallback, capture-phase click and auxclick, no storage', () => {
  const src = fs.readFileSync(path.join(ROOT, 'site', 't.js'), 'utf8');
  assert.ok(src.includes('navigator.sendBeacon'), 'sendBeacon');
  assert.ok(/fetch\(url,\s*\{[^}]*keepalive:\s*true/.test(src), 'fetch keepalive fallback');
  assert.ok(src.includes("addEventListener('click', handle, true)"), 'capture click');
  assert.ok(src.includes("addEventListener('auxclick', handle, true)"), 'capture auxclick');
  assert.ok(!src.includes('preventDefault'), 'default action never prevented');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/i.test(src), 'no storage APIs');
  assert.ok(src.includes("'/e?page='"), 'posts to /e');
});

test('tracker counts the repo and npm package links, not the org link or turkeycode.ai', () => {
  // Evaluate the URL matcher in isolation with the same logic as t.js.
  const src = fs.readFileSync(path.join(ROOT, 'site', 't.js'), 'utf8');
  const m = /function isCountedOutbound\(href\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(m, 'isCountedOutbound found in t.js');
  // eslint-disable-next-line no-new-func
  const isCounted = new Function(
    'href',
    'var doc = { baseURI: "http://localhost/" };' + m[1]
  );
  for (const href of [
    'https://github.com/TurkeyCode-ai/turkeycode',
    'https://github.com/TurkeyCode-ai/turkeycode/',
    'https://github.com/TurkeyCode-ai/turkeycode#readme',
    'https://github.com/TurkeyCode-ai/turkeycode#quick-start',
    'https://github.com/TurkeyCode-ai/turkeycode/issues',
    'https://github.com/TurkeyCode-ai/turkeycode/tree/main/skills',
    'https://www.npmjs.com/package/turkeycode',
  ]) {
    assert.equal(isCounted(href), true, 'counted: ' + href);
  }
  for (const href of [
    'https://github.com/TurkeyCode-ai',
    'https://github.com/TurkeyCode-ai/',
    'https://github.com/TurkeyCode-ai/turkeycode2',
    'https://github.com/other/turkeycode',
    'https://turkeycode.ai',
    'https://turkeycode.ai/',
    'https://www.npmjs.com/package/other',
    'http://github.com/TurkeyCode-ai/turkeycode',
    '#install',
  ]) {
    assert.equal(isCounted(href), false, 'not counted: ' + href);
  }
});

// --- Page wiring ---------------------------------------------------------------

test('flow 7: page B Copy button carries exactly the todo-app command and page B loads /t.js', async () => {
  const before = logLines().length;
  const res = await request('/b/');
  const html = res.body.toString('utf8');
  assert.ok(html.includes('<script src="/t.js"></script>'), 'page B loads the tracker');
  const btn = /<button type="button" data-copy="([^"]+)"/.exec(html);
  assert.ok(btn, 'a data-copy button exists');
  assert.equal(
    decodeAttr(btn[1]),
    'npx turkeycode run "a todo app with user accounts"',
    'first Copy button copies exactly the command'
  );
  assert.ok(html.includes('data-page="b"'), 'page B is marked data-page="b"');
  await waitForLogCount(before + 1);
});

test('flow 8: page B links to the GitHub repo', async () => {
  const before = logLines().length;
  const res = await request('/b/');
  const html = res.body.toString('utf8');
  assert.ok(
    html.includes('href="https://github.com/TurkeyCode-ai/turkeycode"'),
    'GitHub repo link present'
  );
  await waitForLogCount(before + 1);
});

test('served / and /a/ carry the injected tracker tag; disk file does not', async () => {
  const before = logLines().length;
  const tag = '<script src="/t.js" data-page="a"></script>';
  const a = await request('/a/');
  assert.ok(a.body.toString('utf8').includes(tag), '/a/ carries the tag');
  const root = await request('/', { headers: { Cookie: 'tc_ab=a' } });
  assert.ok(root.body.toString('utf8').includes(tag), '/ (variant a) carries the tag');
  const onDisk = fs.readFileSync(path.join(ROOT, 'site', 'a', 'index.html'), 'utf8');
  assert.ok(!onDisk.includes('/t.js'), 'site/a/index.html untouched');
  await waitForLogCount(before + 2);
});

test('CSP on pages includes connect-src self', async () => {
  const before = logLines().length;
  for (const p of ['/a/', '/b/']) {
    const res = await request(p);
    assert.ok(
      res.headers['content-security-policy'].includes("connect-src 'self'"),
      p + ' CSP has connect-src'
    );
  }
  await waitForLogCount(before + 2);
});

// --- POST /e -------------------------------------------------------------------

test('flow 7: POST /e page=b event=copy returns 204 cookie-free and appends exactly one b copy line', async () => {
  const before = logLines().length;
  const res = await request('/e?page=b&event=copy', { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(res.headers['set-cookie'], undefined, 'no Set-Cookie');
  assert.equal(res.body.length, 0, 'empty body');
  const after = await waitForLogCount(before + 1);
  assert.equal(after.length, before + 1, 'exactly one line appended');
  assert.match(
    after[after.length - 1],
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z b copy$/
  );
});

test('flow 8: POST /e page=b event=outbound appends exactly one b outbound line', async () => {
  const before = logLines().length;
  const res = await request('/e?page=b&event=outbound', { method: 'POST' });
  assert.equal(res.status, 204);
  const after = await waitForLogCount(before + 1);
  assert.equal(after.length, before + 1);
  assert.match(
    after[after.length - 1],
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z b outbound$/
  );
});

test('page A copy and outbound events log a copy and a outbound lines', async () => {
  const before = logLines().length;
  assert.equal((await request('/e?page=a&event=copy', { method: 'POST' })).status, 204);
  assert.equal((await request('/e?page=a&event=outbound', { method: 'POST' })).status, 204);
  const after = await waitForLogCount(before + 2);
  assert.equal(after.length, before + 2);
  assert.match(after[after.length - 2], / a copy$/);
  assert.match(after[after.length - 1], / a outbound$/);
});

test('POST /e accepts urlencoded and JSON bodies', async () => {
  const before = logLines().length;
  const form = await request('/e', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'page=a&event=copy',
  });
  assert.equal(form.status, 204);
  const json = await request('/e', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 'b', event: 'outbound' }),
  });
  assert.equal(json.status, 204);
  assert.equal((await waitForLogCount(before + 2)).length, before + 2);
});

test('invalid events are rejected and never logged', async () => {
  const before = logLines().length;
  const cases = [
    '/e?page=c&event=copy',
    '/e?page=a&event=view',
    '/e?page=a&event=foo',
    '/e?page=a%0A&event=copy',
    '/e?page=a&event=copy%0Ab%20outbound',
    '/e?page=&event=',
    '/e',
  ];
  for (const p of cases) {
    const res = await request(p, { method: 'POST' });
    assert.equal(res.status, 400, p + ' rejected');
    assert.equal(res.headers['set-cookie'], undefined);
  }
  const bodyCases = ['page=c&event=copy', 'page=a\n&event=copy', '{"page":"a","event":"view"}', 'garbage'];
  for (const b of bodyCases) {
    const res = await request('/e', { method: 'POST', body: b });
    assert.equal(res.status, 400, JSON.stringify(b) + ' rejected');
  }
  assert.equal(logLines().length, before, 'no log lines from invalid events');
});

test('oversized body returns 413 and logs nothing', async () => {
  const before = logLines().length;
  const res = await request('/e', { method: 'POST', body: 'x'.repeat(1000) });
  assert.equal(res.status, 413);
  assert.equal(logLines().length, before);
});

test('query parameters win and client text never reaches the log', async () => {
  const before = logLines().length;
  const res = await request('/e?page=b&event=copy', {
    method: 'POST',
    body: 'page=evil\ninjected&event=copy',
  });
  assert.equal(res.status, 204);
  const after = await waitForLogCount(before + 1);
  assert.equal(after.length, before + 1);
  assert.match(after[after.length - 1], / b copy$/);
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.ok(!raw.includes('evil'), 'no client text in the log');
  assert.ok(!raw.includes('injected'), 'no injected line in the log');
});

test('GET /e is not allowed', async () => {
  const res = await request('/e');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('every log line stays in the fixed three-field format', () => {
  for (const line of logLines()) {
    assert.match(
      line,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [ab] (view|copy|outbound)$/,
      line
    );
  }
});

// --- flow 10: stats.sh ----------------------------------------------------------

function runStats(args, env) {
  return spawnSync('sh', [path.join(ROOT, 'stats.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('flow 10: stats.sh summarises a known log with one-decimal engagement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stats-'));
  const log = path.join(dir, 'events.log');
  const lines = [];
  const t = '2026-11-21T12:00:00.000Z';
  for (let i = 0; i < 12; i++) lines.push(t + ' a view');
  for (let i = 0; i < 3; i++) lines.push(t + ' a copy');
  for (let i = 0; i < 2; i++) lines.push(t + ' a outbound');
  for (let i = 0; i < 14; i++) lines.push(t + ' b view');
  for (let i = 0; i < 5; i++) lines.push(t + ' b copy');
  lines.push(t + ' b outbound');
  // Malformed lines that must be ignored:
  lines.push('not a log line');
  lines.push(t + ' c view');
  lines.push(t + ' a clicked');
  lines.push('');
  fs.writeFileSync(log, lines.join('\n') + '\n');

  const out = runStats([log]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  assert.equal(
    out.stdout,
    'page a: views=12 copies=3 outbound=2 engagement=41.7%\n' +
      'page b: views=14 copies=5 outbound=1 engagement=42.9%\n'
  );
});

test('flow 10: stats.sh matches the live test log', () => {
  const counts = {};
  for (const line of logLines()) {
    const [, page, event] = line.split(' ');
    counts[page + ' ' + event] = (counts[page + ' ' + event] || 0) + 1;
  }
  const out = runStats([logFile]);
  assert.equal(out.status, 0, out.stderr);
  for (const p of ['a', 'b']) {
    const v = counts[p + ' view'] || 0;
    const c = counts[p + ' copy'] || 0;
    const o = counts[p + ' outbound'] || 0;
    const share = v > 0 ? ((c + o) * 100 / v).toFixed(1) + '%' : '0.0%';
    assert.ok(
      out.stdout.includes(
        'page ' + p + ': views=' + v + ' copies=' + c + ' outbound=' + o + ' engagement=' + share
      ),
      'stats for page ' + p + ' match the log:\n' + out.stdout
    );
  }
});

test('stats.sh handles missing and empty logs and the LOG_FILE variable', () => {
  const zero =
    'page a: views=0 copies=0 outbound=0 engagement=0.0%\n' +
    'page b: views=0 copies=0 outbound=0 engagement=0.0%\n';

  const missing = runStats([path.join(os.tmpdir(), 'tc-definitely-missing.log')]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, zero);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stats-empty-'));
  const empty = path.join(dir, 'empty.log');
  fs.writeFileSync(empty, '');
  const emptyRun = runStats([empty]);
  assert.equal(emptyRun.status, 0, emptyRun.stderr);
  assert.equal(emptyRun.stdout, zero);

  fs.writeFileSync(empty, '2026-11-21T12:00:00.000Z a view\n');
  const viaEnv = runStats([], { LOG_FILE: empty });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.ok(viaEnv.stdout.includes('page a: views=1'), 'LOG_FILE is honoured');
});

// --- Hygiene --------------------------------------------------------------------

test('no em dash in project files', () => {
  const files = [
    'README.md',
    'stats.sh',
    'Dockerfile',
    '.dockerignore',
    'server.js',
    'package.json',
    path.join('site', 't.js'),
    path.join('site', 'b', 'index.html'),
    path.join('test', 'server.test.js'),
    path.join('test', 'events.test.js'),
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(EM_DASH), 'U+2014 em dash found in ' + f);
  }
});

test('Dockerfile runs as non-root with the /data volume and exec-form CMD', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(docker, /^FROM node:alpine$/m);
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /^VOLUME \/data$/m);
  assert.match(docker, /^EXPOSE 3000$/m);
  assert.match(docker, /PORT=3000/);
  assert.match(docker, /LOG_FILE=\/data\/events\.log/);
  assert.match(docker, /^CMD \["node", "server\.js"\]$/m);
  assert.ok(!docker.includes('npm install'), 'no npm install needed');
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  for (const entry of ['reference/', '.turkey/', '.git', 'node_modules']) {
    assert.ok(ignore.includes(entry), '.dockerignore excludes ' + entry);
  }
});
