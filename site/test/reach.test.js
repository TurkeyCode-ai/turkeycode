'use strict';

// Acceptance flows for crawler detection and the five-field log:
// flows 1 to 4 (first/repeat and the a/b to a1/b1 cookie transition),
// flows 6 to 9 (bots, no User-Agent, direct repeat, nothing identifying
// logged or printed) and flows 12 to 13 (old cookies honoured, invalid
// cookie values treated as absent). One fresh server, one empty log,
// driven in flow order with exact line counts.

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

// A request with no User-Agent counts as a crawler, so every test that
// expects browser behaviour sends one.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const COOKIE_RE = /^tc_ab=(a|b); Max-Age=2592000; Path=\/; SameSite=Lax; HttpOnly$/;
const ACTED_COOKIE_RE = /^tc_ab=(a1|b1); Max-Age=2592000; Path=\/; SameSite=Lax; HttpOnly$/;

let server;
let port;
let logFile;
let serverOutput = '';

// Set in flow 1, reused by the later flows.
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

// Pass 'User-Agent': null to send no User-Agent header at all.
function request(reqPath, { method = 'GET', headers = {} } = {}) {
  const merged = { 'User-Agent': BROWSER_UA, ...headers };
  if (merged['User-Agent'] === null) delete merged['User-Agent'];
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: merged },
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

function setCookies(res) {
  const v = res.headers['set-cookie'];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
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

// Readiness is polled on /t.js, which never writes a log line, so no
// warm-up view line can race a test's log counting (see server.test.js).
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

function pageOf(body) {
  const text = body.toString('utf8');
  const isA = text.includes(PAGE_A_MARKER);
  const isB = text.includes(PAGE_B_MARKER);
  assert.ok(isA !== isB, 'body must be exactly one of page A or page B');
  return isA ? 'a' : 'b';
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reach-test-'));
  logFile = path.join(dir, 'events.log');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), LOG_FILE: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { serverOutput += c.toString('utf8'); });
  server.stderr.on('data', (c) => { serverOutput += c.toString('utf8'); });
  await waitForServer(5000);
});

test.after(() => {
  if (server) server.kill('SIGTERM');
});

test('flow 1: empty log, browser GET / with no cookie: cookie a|b set, one view split first line', async () => {
  assert.equal(logLines().length, 0, 'the log starts empty');
  const res = await request('/');
  assert.equal(res.status, 200);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1, 'exactly one Set-Cookie');
  assert.match(cookies[0], COOKIE_RE);
  assigned = COOKIE_RE.exec(cookies[0])[1];
  assert.equal(pageOf(res.body), assigned, 'cookie matches the page served');

  const lines = await waitForLogCount(1);
  assert.equal(lines.length, 1, 'exactly one line');
  assert.match(
    lines[0],
    new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ' + assigned + ' view split first$')
  );
});

test('flow 2: GET / with the assigned cookie: same page, no Set-Cookie, view split repeat', async () => {
  const res = await request('/', { headers: { Cookie: 'tc_ab=' + assigned } });
  assert.equal(res.status, 200);
  assert.equal(setCookies(res).length, 0, 'no new cookie');
  assert.equal(pageOf(res.body), assigned, 'same page');

  const lines = await waitForLogCount(2);
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(' ' + assigned + ' view split repeat$'));
});

test('the page script reports seen with cookie a|b: seen split first, cookie moves to a0|b0', async () => {
  const res = await request('/e?page=' + assigned + '&event=seen&via=split', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=' + assigned },
  });
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1, 'the response records that the script ran');
  assert.equal(
    cookies[0],
    'tc_ab=' + assigned + '0; Max-Age=2592000; Path=/; SameSite=Lax; HttpOnly'
  );

  const lines = await waitForLogCount(3);
  assert.equal(lines.length, 3);
  assert.match(lines[2], new RegExp(' ' + assigned + ' seen split first$'));
});

test('flow 3: first copy event with cookie a0|b0: copy split first, cookie moves to a1|b1', async () => {
  const res = await request('/e?page=' + assigned + '&event=copy&via=split', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=' + assigned + '0' },
  });
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1, 'the response advances the cookie');
  assert.match(cookies[0], ACTED_COOKIE_RE);
  assert.equal(ACTED_COOKIE_RE.exec(cookies[0])[1], assigned + '1');

  const lines = await waitForLogCount(4);
  assert.equal(lines.length, 4);
  assert.match(lines[3], new RegExp(' ' + assigned + ' copy split first$'));
});

test('flow 4: outbound then copy with the a1|b1 cookie: both split repeat, no Set-Cookie', async () => {
  const acted = 'tc_ab=' + assigned + '1';
  const out = await request('/e?page=' + assigned + '&event=outbound&via=split', {
    method: 'POST',
    headers: { Cookie: acted },
  });
  assert.equal(out.status, 204);
  assert.equal(setCookies(out).length, 0, 'no Set-Cookie on a repeat event');
  const copy = await request('/e?page=' + assigned + '&event=copy&via=split', {
    method: 'POST',
    headers: { Cookie: acted },
  });
  assert.equal(copy.status, 204);
  assert.equal(setCookies(copy).length, 0);

  const lines = await waitForLogCount(6);
  assert.equal(lines.length, 6);
  assert.match(lines[4], new RegExp(' ' + assigned + ' outbound split repeat$'));
  assert.match(lines[5], new RegExp(' ' + assigned + ' copy split repeat$'));
});

test('a view at / with the a1|b1 cookie is honoured: same page, no Set-Cookie, view split repeat', async () => {
  const res = await request('/', { headers: { Cookie: 'tc_ab=' + assigned + '1' } });
  assert.equal(res.status, 200);
  assert.equal(setCookies(res).length, 0);
  assert.equal(pageOf(res.body), assigned);

  const lines = await waitForLogCount(7);
  assert.equal(lines.length, 7);
  assert.match(lines[6], new RegExp(' ' + assigned + ' view split repeat$'));
});

test('flow 6: GET / as Googlebot with no cookie: a page served, no Set-Cookie, view bot repeat', async () => {
  const res = await request('/', { headers: { 'User-Agent': GOOGLEBOT_UA } });
  assert.equal(res.status, 200);
  assert.equal(setCookies(res).length, 0, 'crawlers never get a cookie');
  pageOf(res.body);

  const lines = await waitForLogCount(8);
  assert.equal(lines.length, 8);
  assert.match(lines[7], / [ab] view bot repeat$/);
});

test('flow 7: curl, a missing User-Agent and a bot-substring agent are all logged as bot, cookie-free', async () => {
  const agents = ['curl/8.4.0', null, 'FriendlyExampleBot/1.0'];
  for (const ua of agents) {
    const res = await request('/', { headers: { 'User-Agent': ua } });
    assert.equal(res.status, 200, String(ua));
    assert.equal(setCookies(res).length, 0, 'no cookie for ' + String(ua));
  }
  const lines = await waitForLogCount(11);
  assert.equal(lines.length, 11);
  for (const line of lines.slice(8)) {
    assert.match(line, / [ab] view bot repeat$/, line);
  }
});

test('crawlers at /a/ and /b/ are also logged as bot', async () => {
  const a = await request('/a/', { headers: { 'User-Agent': GOOGLEBOT_UA } });
  assert.equal(a.status, 200);
  assert.equal(setCookies(a).length, 0);
  const b = await request('/b/', { headers: { 'User-Agent': 'Wget/1.21' } });
  assert.equal(b.status, 200);

  const lines = await waitForLogCount(13);
  assert.equal(lines.length, 13);
  assert.match(lines[11], / a view bot repeat$/);
  assert.match(lines[12], / b view bot repeat$/);
});

test('flow 8: browser GET /b/ and a direct copy event both end direct repeat', async () => {
  const view = await request('/b/');
  assert.equal(view.status, 200);
  assert.equal(setCookies(view).length, 0);
  const copy = await request('/e?page=b&event=copy&via=direct', { method: 'POST' });
  assert.equal(copy.status, 204);

  const lines = await waitForLogCount(15);
  assert.equal(lines.length, 15);
  assert.match(lines[13], / b view direct repeat$/);
  assert.match(lines[14], / b copy direct repeat$/);
});

test('a direct event is direct repeat even from a visitor with an a|b cookie, and never moves the cookie', async () => {
  const res = await request('/e?page=b&event=copy&via=direct', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=b' },
  });
  assert.equal(res.status, 204);
  assert.equal(setCookies(res).length, 0, 'direct events never touch the cookie');

  const lines = await waitForLogCount(16);
  assert.equal(lines.length, 16);
  assert.match(lines[15], / b copy direct repeat$/);
});

test('flow 13: cookie values c, a2 and ab are treated as no cookie: new assignment, view split first', async () => {
  for (const bad of ['c', 'a2', 'ab']) {
    const res = await request('/', { headers: { Cookie: 'tc_ab=' + bad } });
    assert.equal(res.status, 200, bad);
    const cookies = setCookies(res);
    assert.equal(cookies.length, 1, 'reassigned for tc_ab=' + bad);
    assert.match(cookies[0], COOKIE_RE);
  }
  const lines = await waitForLogCount(19);
  assert.equal(lines.length, 19);
  for (const line of lines.slice(16)) {
    assert.match(line, / [ab] view split first$/, line);
  }
});

test('flow 12: old a and b cookies still serve that page at /, wording intact', async () => {
  const a = await request('/', { headers: { Cookie: 'tc_ab=a' } });
  assert.equal(pageOf(a.body), 'a');
  assert.equal(setCookies(a).length, 0);
  const b = await request('/', { headers: { Cookie: 'tc_ab=b' } });
  assert.equal(pageOf(b.body), 'b');
  assert.equal(setCookies(b).length, 0);
  assert.ok(a.body.toString('utf8').includes(PAGE_A_MARKER), 'page A wording unchanged');
  assert.ok(b.body.toString('utf8').includes(PAGE_B_MARKER), 'page B wording unchanged');

  const lines = await waitForLogCount(21);
  assert.equal(lines.length, 21);
  assert.match(lines[19], / a view split repeat$/);
  assert.match(lines[20], / b view split repeat$/);
});

test('an event from a visitor with no cookie at all is split repeat', async () => {
  const res = await request('/e?page=a&event=outbound&via=split', { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(setCookies(res).length, 0);
  const lines = await waitForLogCount(22);
  assert.equal(lines.length, 22);
  assert.match(lines[21], / a outbound split repeat$/);
});

test('flow 9: no User-Agent string ever reaches the log or the server output', async () => {
  // Let any in-flight append land before reading the raw file.
  await waitForLogCount(22);
  const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  for (const needle of ['Googlebot', 'Mozilla', 'curl', 'Wget', 'FriendlyExampleBot']) {
    assert.ok(!raw.includes(needle), needle + ' must not appear in the log');
    assert.ok(!serverOutput.includes(needle), needle + ' must not appear in stdout/stderr');
  }
  const printed = serverOutput.split('\n').filter(Boolean);
  assert.ok(printed.length <= 1, 'only the startup line may be printed: ' + JSON.stringify(printed));
  if (printed.length === 1) assert.match(printed[0], /listening/);
});

test('a seen from a0|b0, a1|b1 or no cookie is seen split repeat and sets no cookie', async () => {
  const before = logLines().length;
  for (const cookie of ['tc_ab=a0', 'tc_ab=b1', null]) {
    const res = await request('/e?page=a&event=seen&via=split', {
      method: 'POST',
      headers: cookie ? { Cookie: cookie } : {},
    });
    assert.equal(res.status, 204);
    assert.equal(setCookies(res).length, 0, String(cookie));
  }
  const lines = await waitForLogCount(before + 3);
  assert.equal(lines.length, before + 3);
  for (const line of lines.slice(before)) assert.match(line, / a seen split repeat$/);
});

test('a direct seen is accepted and never logged, and never moves the cookie', async () => {
  const before = logLines().length;
  const res = await request('/e?page=b&event=seen&via=direct', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=b' },
  });
  assert.equal(res.status, 204);
  assert.equal(setCookies(res).length, 0);
  // A following logged request proves nothing was queued ahead of it.
  await request('/b/');
  const lines = await waitForLogCount(before + 1);
  assert.equal(lines.length, before + 1);
  assert.match(lines[before], / b view direct repeat$/);
});

test('a first copy straight from cookie a|b logs seen first ahead of copy first and moves the cookie to a1|b1', async () => {
  const before = logLines().length;
  const res = await request('/e?page=a&event=copy&via=split', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=a' },
  });
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1);
  assert.equal(ACTED_COOKIE_RE.exec(cookies[0])[1], 'a1');
  const lines = await waitForLogCount(before + 2);
  assert.equal(lines.length, before + 2);
  assert.match(lines[before], / a seen split first$/);
  assert.match(lines[before + 1], / a copy split first$/);
});

test('a0 and b0 cookies are honoured at /: same page, no Set-Cookie, view split repeat', async () => {
  const before = logLines().length;
  const a = await request('/', { headers: { Cookie: 'tc_ab=a0' } });
  assert.equal(pageOf(a.body), 'a');
  assert.equal(setCookies(a).length, 0);
  const b = await request('/', { headers: { Cookie: 'tc_ab=b0' } });
  assert.equal(pageOf(b.body), 'b');
  assert.equal(setCookies(b).length, 0);
  const lines = await waitForLogCount(before + 2);
  assert.match(lines[before], / a view split repeat$/);
  assert.match(lines[before + 1], / b view split repeat$/);
});

test('every line in this run is a well-formed five-field line', () => {
  const lines = logLines();
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(
      line,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [ab] (view|seen|copy|outbound) (split|direct|bot) (first|repeat)$/,
      line
    );
  }
});

test('no em dash in this test file or the crawler list in server.js', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const f of ['server.js', path.join('test', 'reach.test.js')]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(emDash), 'U+2014 em dash found in ' + f);
  }
});
