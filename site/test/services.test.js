'use strict';

// Phase 2: the services block on pages A and B, the Professional services
// footer links, the 'services' event (tracker, /e and the log line) and the
// services/enquiry lines in stats.sh.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const additions = require('./fixtures/additions.js');

const ROOT = path.join(__dirname, '..');
const EM_DASH = String.fromCharCode(0x2014);

const HEADING = 'Want it built for you?';
const SENTENCE = "TurkeyCode's maker takes on client builds.";
const GET_IN_TOUCH = '<a href="/contact/">Get in touch</a>';
const FOOTER_LINK = '<a href="/contact/">Professional services</a>';

// A request with no User-Agent counts as a crawler, so every test that
// expects browser behaviour sends one.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    if (body !== null) req.write(body);
    req.end();
  });
}

function logLines() {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

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

function readSite(rel) {
  return fs.readFileSync(path.join(ROOT, 'site', rel), 'utf8');
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-services-test-'));
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

// --- The block on disk -----------------------------------------------------

test('flow 8: A and B carry the byte-identical services block, directly above the footer', () => {
  for (const rel of ['a/index.html', 'b/index.html']) {
    const html = readSite(rel);
    const first = html.indexOf(additions.SERVICES_BLOCK);
    assert.ok(first !== -1, rel + ' carries the services block');
    assert.equal(
      html.indexOf(additions.SERVICES_BLOCK, first + 1),
      -1,
      rel + ' carries the block exactly once'
    );
    assert.ok(
      html.slice(first + additions.SERVICES_BLOCK.length).startsWith('<footer>'),
      rel + ': the block sits directly before <footer>'
    );
  }
  // Byte-identical between the two files, extracted rather than assumed:
  const grab = (h) => /<section class="services-cta">[\s\S]*?<\/section>/.exec(h)[0];
  const blockA = grab(readSite('a/index.html'));
  const blockB = grab(readSite('b/index.html'));
  assert.equal(blockA, blockB, 'the extracted block is byte-identical on A and B');
  assert.ok(blockA.includes('<h2>' + HEADING + '</h2>'), 'exact heading');
  assert.ok(blockA.includes('<p>' + SENTENCE + '</p>'), 'exact sentence');
  assert.ok(blockA.includes(GET_IN_TOUCH), 'Get in touch link to /contact/');
});

test('footers of A, B and the write-up each carry exactly one Professional services link', () => {
  for (const rel of ['a/index.html', 'b/index.html', 'how-it-was-tested/index.html']) {
    const html = readSite(rel);
    const first = html.indexOf(FOOTER_LINK);
    assert.ok(first !== -1, rel + ' carries the link');
    assert.equal(html.indexOf(FOOTER_LINK, first + 1), -1, rel + ': exactly once');
    assert.ok(first > html.indexOf('<footer>'), rel + ': the link is inside the footer');
  }
});

test('the pages differ from their pre-phase fixtures only by the block, its CSS and the footer link', () => {
  const refA = path.join(ROOT, 'reference', 'current-site', 'index.html');
  if (fs.existsSync(refA)) {
    assert.equal(
      additions.strip(readSite('a/index.html'), [
        additions.SERVICES_CSS,
        additions.SERVICES_BLOCK,
        additions.FOOTER_LINK_A,
        additions.FOOTER_LINK_SDD_A,
      ]),
      fs.readFileSync(refA, 'utf8'),
      'page A minus the additions is the reference site'
    );
  }
  assert.equal(
    additions.strip(readSite('b/index.html'), [
      additions.SERVICES_CSS,
      additions.SERVICES_BLOCK,
      additions.FOOTER_LINK_B,
      additions.FOOTER_LINK_SDD_B,
    ]),
    fs.readFileSync(path.join(__dirname, 'fixtures', 'b-before-services.html'), 'utf8'),
    'page B minus the additions is the stored fixture'
  );
  const writeup = readSite('how-it-was-tested/index.html');
  assert.equal(
    additions.strip(writeup, [additions.FOOTER_LINK_WRITEUP, additions.FOOTER_LINK_SDD_WRITEUP]),
    fs.readFileSync(path.join(__dirname, 'fixtures', 'writeup-before-services.html'), 'utf8'),
    'the write-up minus the footer link is the stored fixture'
  );
  assert.ok(!writeup.includes('/t.js'), 'the write-up stays tracker-free');
  assert.ok(!writeup.includes('document.cookie'), 'the write-up stays cookie-free');
});

// --- The block as served -----------------------------------------------------

test('GET /a/ and /b/ each serve exactly one services block with the exact words', async () => {
  const before = logLines().length;
  for (const p of ['/a/', '/b/']) {
    const res = await request(p);
    assert.equal(res.status, 200);
    const html = res.body.toString('utf8');
    assert.equal(html.split(HEADING).length, 2, p + ': heading exactly once');
    assert.equal(html.split(SENTENCE).length, 2, p + ': sentence exactly once');
    assert.ok(html.includes(GET_IN_TOUCH), p + ': Get in touch link present');
    const idx = html.indexOf(additions.SERVICES_BLOCK);
    assert.ok(idx !== -1, p + ': the block is served');
    assert.ok(
      html.slice(idx + additions.SERVICES_BLOCK.length).startsWith('<footer>'),
      p + ': the served block sits directly before <footer>'
    );
    assert.ok(html.includes(FOOTER_LINK), p + ': Professional services footer link served');
  }
  await waitForLogCount(before + 2);
});

// --- POST /e event=services ---------------------------------------------------

test('flow 9: visit /, follow the contact link: a services split line is logged and the cookie is untouched', async () => {
  const before = logLines().length;
  const root = await request('/');
  assert.equal(root.status, 200);
  const setCookie = root.headers['set-cookie'];
  assert.ok(setCookie && setCookie.length === 1, 'assignment sets the cookie');
  const m = /^tc_ab=(a|b);/.exec(setCookie[0]);
  assert.ok(m, 'cookie value is a or b');
  const page = m[1];

  const res = await request('/e?page=' + page + '&event=services&via=split', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=' + page },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['set-cookie'], undefined, 'services never sets the cookie');
  let lines = await waitForLogCount(before + 2);
  assert.match(lines[lines.length - 1], new RegExp(' ' + page + ' services split first$'));

  // The visitor's first action is not used up: a later copy is still first
  // and only then does the cookie advance.
  const copy = await request('/e?page=' + page + '&event=copy&via=split', {
    method: 'POST',
    headers: { Cookie: 'tc_ab=' + page },
  });
  assert.equal(copy.status, 204);
  assert.ok(
    copy.headers['set-cookie'] && copy.headers['set-cookie'][0].startsWith('tc_ab=' + page + '1'),
    'the later copy advances the cookie'
  );
  lines = await waitForLogCount(before + 3);
  assert.match(lines[lines.length - 1], new RegExp(' ' + page + ' copy split first$'));
});

test('services responses are cookie-free for every cookie state, with the right first/repeat', async () => {
  const cases = [
    { cookie: 'tc_ab=a', query: 'page=a&event=services&via=split', tail: ' a services split first' },
    { cookie: 'tc_ab=b', query: 'page=b&event=services&via=split', tail: ' b services split first' },
    { cookie: 'tc_ab=a1', query: 'page=a&event=services&via=split', tail: ' a services split repeat' },
    { cookie: 'tc_ab=b1', query: 'page=b&event=services&via=split', tail: ' b services split repeat' },
    { cookie: null, query: 'page=a&event=services&via=split', tail: ' a services split repeat' },
    { cookie: 'tc_ab=a', query: 'page=a&event=services&via=direct', tail: ' a services direct repeat' },
  ];
  for (const c of cases) {
    const before = logLines().length;
    const headers = c.cookie ? { Cookie: c.cookie } : {};
    const res = await request('/e?' + c.query, { method: 'POST', headers });
    assert.equal(res.status, 204, c.query);
    assert.equal(res.headers['set-cookie'], undefined, 'no Set-Cookie for ' + JSON.stringify(c));
    const lines = await waitForLogCount(before + 1);
    assert.equal(lines.length, before + 1, 'one line for ' + c.query);
    assert.ok(lines[lines.length - 1].endsWith(c.tail), lines[lines.length - 1] + ' ends ' + c.tail);
  }
});

test('services works in a JSON body and is validated like other events', async () => {
  const before = logLines().length;
  const ok = await request('/e', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 'b', event: 'services', via: 'direct' }),
  });
  assert.equal(ok.status, 204);
  const lines = await waitForLogCount(before + 1);
  assert.match(lines[lines.length - 1], / b services direct repeat$/);

  for (const bad of [
    '/e?page=c&event=services',
    '/e?page=a&event=services&via=bogus',
    '/e?page=a&event=SERVICES',
  ]) {
    const res = await request(bad, { method: 'POST' });
    assert.equal(res.status, 400, bad + ' rejected');
  }
  assert.equal(logLines().length, before + 1, 'invalid services requests log nothing');
});

// --- The tracker ---------------------------------------------------------------

test('tracker sends services for same-origin contact links only, via the existing send path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'site', 't.js'), 'utf8');
  assert.ok(src.includes("send('services')"), 'services goes through send()');
  assert.ok(!src.includes('preventDefault'), 'navigation is never blocked');

  // Evaluate the matcher in isolation, like the outbound matcher test.
  const m = /function isContactLink\(href\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(m, 'isContactLink found in t.js');
  // eslint-disable-next-line no-new-func
  const isContact = new Function(
    'href',
    'var doc = { baseURI: "http://localhost/a/" };' + m[1]
  );
  for (const href of ['/contact/', '/contact', 'http://localhost/contact/', '/contact/?x=1']) {
    assert.equal(isContact(href), true, 'counted: ' + href);
  }
  for (const href of [
    'https://other.example/contact/',
    '/contact/thanks/',
    '/contacts/',
    '/',
    '#install',
    'https://github.com/TurkeyCode-ai/turkeycode',
  ]) {
    assert.equal(isContact(href), false, 'not counted: ' + href);
  }

  // The contact check runs before the outbound check and both left and
  // middle clicks are handled by the one capture-phase handler pair.
  assert.ok(
    src.indexOf("send('services')") < src.indexOf("send('outbound')"),
    'contact links are classified before outbound links'
  );
  assert.ok(src.includes("addEventListener('auxclick', handle, true)"), 'middle click counted');
});

// --- stats.sh -------------------------------------------------------------------

function runStats(args) {
  return spawnSync('sh', [path.join(ROOT, 'stats.sh'), ...args], { encoding: 'utf8' });
}

const BASE_LOG = [
  '2026-11-20T10:00:00.000Z a view split first',
  '2026-11-20T10:00:05.000Z a copy split first',
  '2026-11-20T10:00:10.000Z a copy split repeat',
  '2026-11-20T10:01:00.000Z b view split first',
  '2026-11-20T10:01:05.000Z b outbound split first',
  '2026-11-21T09:00:00.000Z a view direct repeat',
  '2026-11-21T09:05:00.000Z b view bot repeat',
  '2026-11-21T09:06:00.000Z a view',
];

const EXTRA_LINES = [
  '2026-11-20T10:00:20.000Z a services split first',
  '2026-11-20T10:00:25.000Z a services split repeat',
  '2026-11-21T09:07:00.000Z b services split repeat',
  '2026-11-21T09:08:00.000Z a services direct repeat',
  '2026-11-21T09:09:00.000Z a enquiry - -',
  '2026-11-21T09:10:00.000Z b enquiry - -',
  '2026-11-21T09:11:00.000Z b enquiry - -',
  '2026-11-21T09:12:00.000Z - enquiry - -',
];

function writeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-services-stats-'));
  const log = path.join(dir, 'events.log');
  fs.writeFileSync(log, lines.join('\n') + '\n');
  return log;
}

test('flows 9/10: services and enquiry lines move only their own labelled stats lines', () => {
  const plainLog = writeLog(BASE_LOG);
  // Interleave so ordering cannot matter.
  const mixedLog = writeLog([
    ...BASE_LOG.slice(0, 4),
    ...EXTRA_LINES.slice(0, 2),
    ...BASE_LOG.slice(4),
    ...EXTRA_LINES.slice(2),
  ]);

  const a = runStats([plainLog]);
  const b = runStats([mixedLog]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);

  // Visitor, acted, conversion, copies, outbound, direct, bot and legacy
  // figures are identical with and without the services/enquiry lines:
  const own = (l) => l.includes('services clicks=') || l.includes('enquiries=');
  assert.deepEqual(
    b.stdout.split('\n').filter((l) => !own(l)),
    a.stdout.split('\n').filter((l) => !own(l)),
    'core figures unchanged by services and enquiry lines'
  );

  // The services lines count split lines only (the direct one is dropped):
  assert.ok(
    b.stdout.includes('page a:  services clicks=   2  (split lines, not part of the conversion rate)'),
    'page a services clicks:\n' + b.stdout
  );
  assert.ok(
    b.stdout.includes('page b:  services clicks=   1  (split lines, not part of the conversion rate)'),
    'page b services clicks:\n' + b.stdout
  );
  // Enquiries per page, with page - for submissions without a split cookie:
  assert.ok(b.stdout.includes('page a:  enquiries=      1  (not part of the conversion rate)'));
  assert.ok(b.stdout.includes('page b:  enquiries=      2  (not part of the conversion rate)'));
  assert.ok(b.stdout.includes('page -:  enquiries=      1  (no split cookie, not part of the conversion rate)'));
  // The plain log shows zeros on the same lines:
  assert.ok(a.stdout.includes('page a:  services clicks=   0  (split lines, not part of the conversion rate)'));
  assert.ok(a.stdout.includes('page -:  enquiries=      0  (no split cookie, not part of the conversion rate)'));

  // --daily output is byte-identical with and without them:
  const da = runStats(['--daily', plainLog]);
  const db = runStats(['--daily', mixedLog]);
  assert.equal(da.status, 0, da.stderr);
  assert.equal(db.status, 0, db.stderr);
  assert.equal(db.stdout, da.stdout, '--daily unchanged by services and enquiry lines');
  assert.ok(!da.stdout.includes('services'), 'no services wording in --daily');
});

test('acceptance: one services split click on page a shows 1', () => {
  const log = writeLog([
    '2026-11-20T10:00:00.000Z a view split first',
    '2026-11-20T10:00:20.000Z a services split first',
  ]);
  const out = runStats([log]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(
    out.stdout.includes('page a:  services clicks=   1  (split lines, not part of the conversion rate)'),
    out.stdout
  );
  assert.ok(
    out.stdout.includes('page a:  visitors=      1  acted=      0  conversion=   0.0%'),
    'the services click never counts as acted:\n' + out.stdout
  );
});

// --- Hygiene ---------------------------------------------------------------------

test('no em dash in the files this phase touched', () => {
  for (const f of [
    path.join('site', 'a', 'index.html'),
    path.join('site', 'b', 'index.html'),
    path.join('site', 'how-it-was-tested', 'index.html'),
    path.join('site', 't.js'),
    'server.js',
    'stats.sh',
    'README.md',
    path.join('test', 'services.test.js'),
    path.join('test', 'fixtures', 'additions.js'),
  ]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(EM_DASH), 'U+2014 em dash found in ' + f);
  }
});
