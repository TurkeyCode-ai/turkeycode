'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');

const PAGE_A_MARKER = 'One prompt in.';
const PAGE_B_MARKER = 'Hand a whole build to Claude Code. Come back to';

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

// Raw HTTP request helper: keeps the path exactly as given (no client-side
// normalization), collects the full body.
function request(reqPath, { method = 'GET', headers = {} } = {}) {
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
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function setCookies(res) {
  const v = res.headers['set-cookie'];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
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
      request('/a/')
        .then(resolve)
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error('server did not start'));
          setTimeout(poll, 100);
        });
    })();
  });
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-site-test-'));
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

test('GET / with no cookie: 200, a known page, exactly one 30-day cookie, one view line', async () => {
  const before = logLines().length;
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html; charset=utf-8/);
  const body = res.body.toString('utf8');
  const isA = body.includes(PAGE_A_MARKER);
  const isB = body.includes(PAGE_B_MARKER);
  assert.ok(isA !== isB, 'body must be exactly one of page A or page B');
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1, 'exactly one Set-Cookie');
  assert.match(cookies[0], /^tc_ab=(a|b); Max-Age=2592000; Path=\/; SameSite=Lax; HttpOnly$/);
  const page = /tc_ab=(a|b)/.exec(cookies[0])[1];
  assert.equal(page === 'a', isA, 'cookie matches the page served');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['vary'], 'Cookie');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));
  const after = await waitForLogCount(before + 1);
  assert.equal(after.length, before + 1, 'one view line appended');
  assert.match(after[after.length - 1], new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ' + page + ' view split$'));
});

test('10 repeat GET / with a cookie: same page, no new cookie, one view line each', async () => {
  const first = await request('/');
  const cookie = setCookies(first)[0].split(';')[0];
  const page = cookie.split('=')[1];
  const marker = page === 'a' ? PAGE_A_MARKER : PAGE_B_MARKER;
  const before = logLines().length;
  for (let i = 0; i < 10; i++) {
    const res = await request('/', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.ok(res.body.toString('utf8').includes(marker), 'same page every time');
    assert.equal(setCookies(res).length, 0, 'no new cookie');
  }
  assert.equal((await waitForLogCount(before + 10)).length, before + 10, 'ten view lines');
});

test('40 cookie-less GET /: both pages appear at least 10 times', async () => {
  const before = logLines().length;
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 40; i++) {
    const res = await request('/');
    const page = /tc_ab=(a|b)/.exec(setCookies(res)[0])[1];
    counts[page] += 1;
  }
  assert.ok(counts.a >= 10, 'page a at least 10 of 40 (got ' + counts.a + ')');
  assert.ok(counts.b >= 10, 'page b at least 10 of 40 (got ' + counts.b + ')');
  await waitForLogCount(before + 40);
});

test('invalid cookie is treated as unassigned and reassigned', async () => {
  const before = logLines().length;
  const res = await request('/', { headers: { Cookie: 'tc_ab=zzz' } });
  assert.equal(res.status, 200);
  assert.equal(setCookies(res).length, 1);
  await waitForLogCount(before + 1);
});

test('/a/ and /b/ ignore the cookie and never set one', async () => {
  const before = logLines().length;
  const a = await request('/a/', { headers: { Cookie: 'tc_ab=b' } });
  assert.equal(a.status, 200);
  assert.ok(a.body.toString('utf8').includes(PAGE_A_MARKER));
  assert.equal(setCookies(a).length, 0);

  const b = await request('/b/', { headers: { Cookie: 'tc_ab=a' } });
  assert.equal(b.status, 200);
  assert.ok(b.body.toString('utf8').includes(PAGE_B_MARKER));
  assert.equal(setCookies(b).length, 0);
  await waitForLogCount(before + 2);
});

test('/a and /b redirect 301 to the slash form', async () => {
  const a = await request('/a');
  assert.equal(a.status, 301);
  assert.equal(a.headers.location, '/a/');
  const b = await request('/b');
  assert.equal(b.status, 301);
  assert.equal(b.headers.location, '/b/');
});

test('reference paths, traversal and unknown paths return 404', async () => {
  for (const p of [
    '/reference/design.html',
    '/../server.js',
    '/a/../../server.js',
    '/a/..%2f..%2fserver.js',
    '/server.js',
    '/package.json',
    '/nope',
    '/a/nope.mp4',
  ]) {
    const res = await request(p);
    assert.equal(res.status, 404, p + ' must 404 (got ' + res.status + ')');
  }
});

test('/a/ serves site/a/index.html plus exactly one injected tracker tag', async () => {
  const before = logLines().length;
  const res = await request('/a/');
  const onDisk = fs.readFileSync(path.join(ROOT, 'site', 'a', 'index.html'), 'utf8');
  const served = res.body.toString('utf8');
  const tag = '<script src="/t.js" data-page="a" data-via="direct"></script>\n';
  assert.ok(!onDisk.includes('/t.js'), 'file on disk carries no tracker');
  const first = served.indexOf(tag);
  assert.ok(first !== -1, 'served page A contains the tracker tag');
  assert.equal(served.indexOf(tag, first + 1), -1, 'tracker tag appears exactly once');
  assert.equal(served.replace(tag, ''), onDisk, 'served page A differs from disk only by the tag');
  await waitForLogCount(before + 1);
});

test('video and poster content types and Range support at all three locations', async () => {
  const before = logLines().length;
  for (const p of ['/a/turkey.mp4', '/b/turkey.mp4', '/turkey.mp4']) {
    const full = await request(p);
    assert.equal(full.status, 200, p);
    assert.equal(full.headers['content-type'], 'video/mp4', p);
    assert.equal(full.headers['accept-ranges'], 'bytes', p);

    const ranged = await request(p, { headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206, p + ' range');
    assert.equal(ranged.body.length, 100);
    assert.match(ranged.headers['content-range'], /^bytes 0-99\/\d+$/);
  }
  for (const p of ['/a/turkey-poster.jpg', '/b/turkey-poster.jpg', '/turkey-poster.jpg']) {
    const res = await request(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['content-type'], 'image/jpeg', p);
  }
  assert.equal(logLines().length, before, 'assets never add view lines');
});

test('unsatisfiable range returns 416', async () => {
  const res = await request('/turkey.mp4', { headers: { Range: 'bytes=999999999-' } });
  assert.equal(res.status, 416);
});

test('HEAD requests and favicon never log views', async () => {
  const before = logLines().length;
  const h1 = await request('/', { method: 'HEAD' });
  assert.equal(h1.status, 200);
  const h2 = await request('/a/', { method: 'HEAD' });
  assert.equal(h2.status, 200);
  const fav = await request('/favicon.ico');
  assert.equal(fav.status, 404);
  assert.equal(logLines().length, before, 'no view lines from HEAD or favicon');
});

test('log lines carry only time, page, event and split/direct', () => {
  const lines = logLines();
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [ab] view (split|direct)$/, line);
  }
});

test('server prints no access log for requests', async () => {
  // Collected stdout/stderr so far must only hold the single startup line.
  const out = server.stdout.read();
  const text = out ? out.toString('utf8') : '';
  const lines = text.split('\n').filter(Boolean);
  assert.ok(lines.length <= 1, 'only the startup line may be printed: ' + JSON.stringify(lines));
  if (lines.length === 1) assert.match(lines[0], /listening/);
});

test('page B contains design wording in order, allowed links only, no em dash', () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'b', 'index.html'), 'utf8');
  assert.ok(!html.includes(String.fromCharCode(0x2014)), 'no U+2014 em dash in page B');

  const inOrder = [
    'Open source CLI',
    'Hand a whole build to Claude Code. Come back to',
    'runs a whole build from one prompt while you are away',
    'You need: Node.js 20+ and Git',
    'You pay for:',
    'What checks the work:',
    'Start a build:',
    'npx turkeycode run "a todo app with user accounts"',
    'Settle the scope first.',
    'Then it runs on its own.',
    'Use Codex CLI, Gemini CLI or OpenCode?',
    'npx turkeycode run --agent codex "a todo app with user accounts"',
    'What you need: Node.js 20+, Git and a logged-in agent CLI',
    'Quick start: one build',
    'mkdir my-app &amp;&amp; cd my-app',
    'Want it unattended from the first moment?',
    'While it runs',
    'What has checked the work when you come back',
    'up to 3 QA attempts per phase',
    'What runs on your machine',
    'Not on Claude Code? Switch with one flag',
    'Install',
    'npm install -g turkeycode',
    'After the build',
    'What TurkeyCode is not',
    'version 4.0.0 on npm',
  ];
  let idx = 0;
  for (const needle of inOrder) {
    const at = html.indexOf(needle, idx);
    assert.ok(at !== -1, 'missing or out of order: ' + needle);
    idx = at;
  }

  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    const ok =
      href.startsWith('#') ||
      href === '/how-it-was-tested/' ||
      href.startsWith('data:image/svg+xml') ||
      href.startsWith('https://turkeycode.ai') ||
      href.startsWith('https://github.com/TurkeyCode-ai') ||
      href.startsWith('https://www.npmjs.com/package/turkeycode');
    assert.ok(ok, 'disallowed link: ' + href);
    if (href.startsWith('#')) {
      assert.ok(html.includes('id="' + href.slice(1) + '"'), 'anchor target missing: ' + href);
    }
  }

  assert.ok(html.includes('data-page="b"'), 'page marked data-page="b"');
  assert.ok(!/src="https?:\/\//.test(html) && !/@import|url\(https?:/.test(html), 'no external resources');
});

test('server.js has no em dash and site/a is byte-identical to its source of truth', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!srv.includes(String.fromCharCode(0x2014)), 'no U+2014 in server.js');
  // reference/ may be deleted in production; only compare when present.
  const ref = path.join(ROOT, 'reference', 'current-site');
  if (fs.existsSync(ref)) {
    for (const f of ['index.html', 'turkey.mp4', 'turkey-poster.jpg']) {
      const a = fs.readFileSync(path.join(ROOT, 'site', 'a', f));
      const b = fs.readFileSync(path.join(ref, f));
      assert.ok(a.equals(b), 'site/a/' + f + ' byte-identical to reference');
    }
  }
});
