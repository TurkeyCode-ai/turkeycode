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
// Renders as 'We tested this site before we built it'.
const HEADING = 'We <em>tested</em> this site before we built it';

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

function stats() {
  const res = spawnSync('sh', [path.join(ROOT, 'stats.sh'), logFile], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, 'stats.sh exits 0');
  return res.stdout;
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-writeup-test-'));
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

test('flow 1: /how-it-was-tested/ serves the write-up untouched, with no tracker', async () => {
  const res = await request('/how-it-was-tested/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html; charset=utf-8/);
  assert.equal(res.headers['content-length'], String(res.body.length));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));

  const body = res.body.toString('utf8');
  assert.ok(body.includes(HEADING), 'write-up heading present');
  assert.ok(body.includes('<table'), 'write-up tables present');
  assert.ok(!body.includes('/t.js'), 'no tracker tag in the served write-up');

  const onDisk = fs.readFileSync(path.join(ROOT, 'site', 'how-it-was-tested', 'index.html'));
  assert.ok(res.body.equals(onDisk), 'served bytes equal the file on disk');

  // reference/ may be deleted in production; only compare when present.
  const ref = path.join(ROOT, 'reference', 'writeup.html');
  if (fs.existsSync(ref)) {
    assert.ok(res.body.equals(fs.readFileSync(ref)), 'served bytes equal reference/writeup.html');
  }
});

test('flow 2: /how-it-was-tested redirects 301 to the slash form', async () => {
  const res = await request('/how-it-was-tested');
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, '/how-it-was-tested/');
});

test('flow 3: the write-up never sets or changes the split cookie', async () => {
  const bare = await request('/how-it-was-tested/');
  assert.equal(bare.headers['set-cookie'], undefined, 'no Set-Cookie without a cookie');

  const withCookie = await request('/how-it-was-tested/', { headers: { Cookie: 'tc_ab=a' } });
  assert.equal(withCookie.status, 200);
  assert.equal(withCookie.headers['set-cookie'], undefined, 'no Set-Cookie with a cookie');
});

test('flow 4: three visits write no event lines and leave stats.sh output unchanged', async () => {
  // Put known lines in the log first so the counts are non-trivial.
  const seedA = await request('/a/');
  assert.equal(seedA.status, 200);
  const seedB = await request('/b/');
  assert.equal(seedB.status, 200);
  const beforeLines = await waitForLogCount(2);
  const beforeStats = stats();

  for (let i = 0; i < 3; i++) {
    const res = await request('/how-it-was-tested/');
    assert.equal(res.status, 200);
  }
  const head = await request('/how-it-was-tested/', { method: 'HEAD' });
  assert.equal(head.status, 200);

  // Give any stray async append time to land before checking.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterLines = logLines();
  assert.deepEqual(afterLines, beforeLines, 'event log unchanged by write-up visits');
  assert.equal(stats(), beforeStats, 'stats.sh output unchanged by write-up visits');
});

const NEW_SENTENCE =
  'You do not know which page you were given, and neither do we. ' +
  'It was picked at random when you first arrived, and you will keep getting the same one.';

test('flow 6: the new sentence is the second paragraph under What happens next, styled like its neighbours', async () => {
  const res = await request('/how-it-was-tested/');
  assert.equal(res.status, 200);
  const body = res.body.toString('utf8');

  const section = /<h2>What happens next<\/h2>([\s\S]*?)<\/section>/.exec(body);
  assert.ok(section, 'What happens next section found');
  const paragraphs = [...section[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  assert.ok(paragraphs.length >= 3, 'section has at least three paragraphs');
  assert.equal(paragraphs[1], NEW_SENTENCE, 'the exact sentence is the second paragraph');

  // Styled like its neighbours: a plain <p> with no attributes, no extra
  // markup inside, carried at the same indentation as the paragraph before it.
  assert.ok(
    section[1].includes('</p>\n  <p>' + NEW_SENTENCE + '</p>'),
    'plain <p>, same indentation as the neighbouring paragraphs'
  );
  assert.equal(body.split(NEW_SENTENCE).length, 2, 'the sentence appears exactly once');
});

const PRIVACY_SENTENCE =
  'It stores the time, the page, the event, how the page was reached and ' +
  "whether it was that visitor's first, and nothing else: no IP address, " +
  'no user agent and no identifier. Known crawlers are left out of the ' +
  'comparison.';

test('flow 11: the write-up carries the new privacy sentence verbatim, exactly once, and the old sentence is gone', async () => {
  const res = await request('/how-it-was-tested/');
  assert.equal(res.status, 200);
  const body = res.body.toString('utf8');
  assert.equal(body.split(PRIVACY_SENTENCE).length, 2, 'the new sentence appears exactly once');
  assert.ok(
    !body.includes('It stores the time, the page and the event'),
    'the old sentence is gone'
  );
  const onDisk = fs.readFileSync(
    path.join(ROOT, 'site', 'how-it-was-tested', 'index.html'),
    'utf8'
  );
  assert.ok(onDisk.includes(PRIVACY_SENTENCE), 'the file on disk carries the sentence');
});

test('flow 7: reference/writeup.html and site/how-it-was-tested/index.html are byte-identical', () => {
  const site = fs.readFileSync(path.join(ROOT, 'site', 'how-it-was-tested', 'index.html'));
  const ref = path.join(ROOT, 'reference', 'writeup.html');
  if (fs.existsSync(ref)) {
    assert.ok(site.equals(fs.readFileSync(ref)), 'the two write-up files stay identical');
  }
  assert.ok(site.toString('utf8').includes(NEW_SENTENCE), 'the write-up carries the sentence');
});

test('flow 8: pages A and B carry no write-up wording: page A is the reference plus only the services additions, page B free of the marker and the sentence', () => {
  const ref = path.join(ROOT, 'reference', 'current-site', 'index.html');
  if (fs.existsSync(ref)) {
    const additions = require('./fixtures/additions.js');
    const a = fs.readFileSync(path.join(ROOT, 'site', 'a', 'index.html'), 'utf8');
    assert.equal(
      additions.strip(a, [
        additions.SERVICES_CSS,
        additions.SERVICES_BLOCK,
        additions.FOOTER_LINK_A,
        additions.FOOTER_LINK_SDD_A,
      ]),
      fs.readFileSync(ref, 'utf8'),
      'site/a/index.html is the reference plus only the services additions'
    );
  }
  const b = fs.readFileSync(path.join(ROOT, 'site', 'b', 'index.html'), 'utf8');
  assert.ok(!b.includes('data-via'), 'page B on disk carries no data-via marker');
  assert.ok(!b.includes('You do not know which page'), 'page B wording unchanged');
  assert.ok(b.includes('<script src="/t.js"></script>'), 'page B keeps its own plain tag');
});

test('non-GET/HEAD on the write-up returns 405', async () => {
  const res = await request('/how-it-was-tested/', { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('page B footer links to the write-up; page A does not', () => {
  const b = fs.readFileSync(path.join(ROOT, 'site', 'b', 'index.html'), 'utf8');
  const link = '<p><a href="/how-it-was-tested/">How this site was tested</a></p>';
  const first = b.indexOf(link);
  assert.ok(first !== -1, 'page B footer carries the write-up link');
  assert.equal(b.indexOf(link, first + 1), -1, 'the link appears exactly once');
  assert.ok(first > b.indexOf('<footer>'), 'the link is inside the footer');

  const a = fs.readFileSync(path.join(ROOT, 'site', 'a', 'index.html'), 'utf8');
  assert.ok(!a.includes('/how-it-was-tested'), 'page A is untouched');
});

test('the write-up and the files this phase touched carry no em dash', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const f of [
    path.join('site', 'how-it-was-tested', 'index.html'),
    path.join('site', 'b', 'index.html'),
    'server.js',
    path.join('test', 'writeup.test.js'),
  ]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(emDash), 'no U+2014 in ' + f);
  }
});
