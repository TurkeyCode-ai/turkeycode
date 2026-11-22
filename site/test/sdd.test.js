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

const PARAGRAPH =
  'Test it before you build it. You write one sentence about what you want. ' +
  'An AI writes a test from it: who will show up and what they need to ' +
  'understand. Simulated visitors try cheap mock-ups until one works, and ' +
  'only that one gets built. Then the real thing takes the same test, and ' +
  'real visitors have the final say.';

const READ_MORE_TESTED =
  'The short version: what we did, the numbers, and what we corrected along the way.';
const READ_MORE_PAPER =
  'The full method, every table, the limits and the open questions.';

const SDD_LINK = '<a href="/sdd/">About SDD</a>';

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

function readSite(rel) {
  return fs.readFileSync(path.join(ROOT, 'site', rel), 'utf8');
}

test.before(async () => {
  port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sdd-test-'));
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

// --- Flow 1: the SDD page ------------------------------------------------------

test('flow 1: /sdd/ serves the page with the exact words, the video and no cookie', async () => {
  const res = await request('/sdd/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html; charset=utf-8/);
  assert.equal(res.headers['content-length'], String(res.body.length));
  assert.equal(res.headers['set-cookie'], undefined, 'no Set-Cookie');
  assert.equal(res.headers.vary, undefined, 'no Vary: Cookie');
  assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));

  const body = res.body.toString('utf8');
  assert.ok(body.includes('<h1>Simulation Driven Development</h1>'), 'heading present');
  assert.equal(body.split(PARAGRAPH).length, 2, 'the exact paragraph appears exactly once');
  assert.ok(body.includes('<h2>Turkeyman explains</h2>'), 'video heading present');
  assert.ok(body.includes('<h2>Read more</h2>'), 'Read more heading present');
  assert.ok(!body.includes('/t.js'), 'no tracker tag');

  // The video: browser controls, poster, nothing preloaded, no autoplay, no loop.
  const video = /<video\b[^>]*>/.exec(body);
  assert.ok(video, 'video tag present');
  assert.ok(video[0].includes('controls'), 'controls');
  assert.ok(video[0].includes('preload="none"'), 'preload="none"');
  assert.ok(video[0].includes('poster="/sdd/turkeyman-poster.jpg"'), 'poster');
  assert.ok(video[0].includes('src="/sdd/turkeyman.mp4"'), 'plays the SDD video');
  assert.ok(!video[0].includes('autoplay'), 'no autoplay');
  assert.ok(!video[0].includes('loop'), 'no loop');

  // Read more: both links with their exact one-line descriptions.
  assert.ok(
    body.includes('<a href="/how-it-was-tested/">How this site was tested</a>'),
    'write-up link'
  );
  assert.ok(body.includes(READ_MORE_TESTED), 'write-up line');
  assert.ok(
    body.includes('<a href="/sdd/whitepaper/">The white paper</a>'),
    'white paper link'
  );
  assert.ok(body.includes(READ_MORE_PAPER), 'white paper line');

  // The same services block the landing pages carry, linking to /contact/.
  const additions = require('./fixtures/additions.js');
  assert.ok(body.includes(additions.SERVICES_BLOCK), 'the exact services block');

  // The served bytes are the file on disk, untouched.
  assert.ok(
    res.body.equals(fs.readFileSync(path.join(ROOT, 'site', 'sdd', 'index.html'))),
    'served bytes equal the file on disk'
  );
});

test('flow 1: /sdd/ never sets or changes the split cookie, even mid-test', async () => {
  const withCookie = await request('/sdd/', { headers: { Cookie: 'tc_ab=a' } });
  assert.equal(withCookie.status, 200);
  assert.equal(withCookie.headers['set-cookie'], undefined, 'no Set-Cookie with a cookie');
});

test('the SDD page fits a narrow screen: 16 by 9 video that never overflows', () => {
  const html = readSite('sdd/index.html');
  assert.ok(html.includes('aspect-ratio: 16 / 9'), 'video keeps 16 by 9');
  assert.ok(html.includes('max-width: 100%'), 'video never wider than its frame');
  assert.ok(/\.frame\s*\{[^}]*border: var\(--edge\)/.test(html), 'hard-bordered frame');
});

test('nothing under /sdd/ references another host', () => {
  for (const rel of ['sdd/index.html', path.join('sdd', 'whitepaper', 'index.html')]) {
    const html = readSite(rel);
    assert.ok(
      !/src="https?:\/\//.test(html) && !/@import|url\(https?:/.test(html),
      rel + ': no external resources'
    );
  }
  const sdd = readSite('sdd/index.html');
  assert.ok(!/href="https?:\/\//.test(sdd), 'sdd/index.html links stay on this site');
});

// --- Redirects ------------------------------------------------------------------

test('/sdd and /sdd/whitepaper redirect 301 to the slash forms', async () => {
  const r1 = await request('/sdd');
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.location, '/sdd/');
  const r2 = await request('/sdd/whitepaper');
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.location, '/sdd/whitepaper/');
});

// --- Flow 3: the video over Range ------------------------------------------------

test('flow 3: Range bytes=0-999 on the video returns 206 video/mp4 with 1000 bytes', async () => {
  const res = await request('/sdd/turkeyman.mp4', {
    headers: { Range: 'bytes=0-999' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['content-length'], '1000');
  assert.equal(res.body.length, 1000);
  const onDisk = fs.readFileSync(path.join(ROOT, 'site', 'sdd', 'turkeyman.mp4'));
  assert.equal(
    res.headers['content-range'],
    'bytes 0-999/' + onDisk.length,
    'Content-Range covers the whole file'
  );
  assert.ok(res.body.equals(onDisk.subarray(0, 1000)), 'the first 1000 bytes of the file');
});

test('the full video and poster are served, byte-identical to the reference files', async () => {
  const video = await request('/sdd/turkeyman.mp4');
  assert.equal(video.status, 200);
  assert.equal(video.headers['content-type'], 'video/mp4');
  assert.equal(video.headers['accept-ranges'], 'bytes');
  const refVideo = path.join(ROOT, 'reference', 'sdd', 'turkeyman.mp4');
  if (fs.existsSync(refVideo)) {
    assert.ok(video.body.equals(fs.readFileSync(refVideo)), 'video not re-encoded');
  }
  const poster = await request('/sdd/turkeyman-poster.jpg');
  assert.equal(poster.status, 200);
  assert.equal(poster.headers['content-type'], 'image/jpeg');
  const refPoster = path.join(ROOT, 'reference', 'sdd', 'turkeyman-poster.jpg');
  if (fs.existsSync(refPoster)) {
    assert.ok(poster.body.equals(fs.readFileSync(refPoster)), 'poster byte-identical');
  }
});

// --- Flow 5: the white paper ------------------------------------------------------

test('flow 5: the white paper is the reference plus only the About SDD link, above the contents', async () => {
  const site = readSite(path.join('sdd', 'whitepaper', 'index.html'));
  const link = '<p>' + SDD_LINK + '</p>\n';
  const first = site.indexOf(link);
  assert.ok(first !== -1, 'the About SDD link is present');
  assert.equal(site.indexOf(link, first + 1), -1, 'the link appears exactly once');
  assert.ok(
    first > site.indexOf('<main class="wrap">'),
    'the link is at the top of the main content'
  );
  assert.ok(first < site.indexOf('<nav class="toc"'), 'the link sits above the contents list');

  // reference/ may be deleted in production; only compare when present.
  const ref = path.join(ROOT, 'reference', 'sdd', 'whitepaper.html');
  if (fs.existsSync(ref)) {
    const stripped = site.slice(0, first) + site.slice(first + link.length);
    assert.equal(stripped, fs.readFileSync(ref, 'utf8'), 'only the link was added');
  }

  const res = await request('/sdd/whitepaper/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html; charset=utf-8/);
  assert.equal(res.headers['set-cookie'], undefined, 'no Set-Cookie');
  assert.equal(res.headers.vary, undefined, 'no Vary: Cookie');
  assert.ok(res.body.toString('utf8') === site, 'served bytes equal the file on disk');
  assert.ok(!res.body.toString('utf8').includes('/t.js'), 'no tracker tag');
  assert.ok(site.includes('.scroll { overflow-x: auto;'), 'wide tables scroll in their own frame');
});

// --- Flow 6: the footer links ------------------------------------------------------

test('flow 6: the five pages each carry exactly one About SDD footer link; A and B identical', () => {
  const pages = [
    'a/index.html',
    'b/index.html',
    'how-it-was-tested/index.html',
    'contact/index.html',
    path.join('contact', 'thanks', 'index.html'),
  ];
  for (const rel of pages) {
    const html = readSite(rel);
    const first = html.indexOf(SDD_LINK);
    assert.ok(first !== -1, rel + ' carries the link');
    assert.equal(html.indexOf(SDD_LINK, first + 1), -1, rel + ': exactly once');
    assert.ok(first > html.indexOf('<footer>'), rel + ': the link is inside the footer');
    assert.ok(
      !/data-event|data-track/.test(SDD_LINK),
      rel + ': the link carries no tracked-click attributes'
    );
  }

  // Identical words and position on A and B: the same anchor, directly after
  // the Professional services link, last in the footer on both pages.
  for (const rel of ['a/index.html', 'b/index.html']) {
    const html = readSite(rel);
    const footer = html.slice(html.indexOf('<footer>'));
    const anchors = [...footer.matchAll(/<a href="[^"]*"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
    assert.equal(anchors[anchors.length - 1], SDD_LINK, rel + ': About SDD is the last footer link');
    assert.equal(
      anchors[anchors.length - 2],
      '<a href="/contact/">Professional services</a>',
      rel + ': it follows the Professional services link'
    );
  }
});

test('flow 6: the served pages carry the link too', async () => {
  for (const p of ['/a/', '/b/', '/how-it-was-tested/', '/contact/', '/contact/thanks/']) {
    const res = await request(p);
    assert.equal(res.status, 200, p);
    assert.ok(res.body.toString('utf8').includes(SDD_LINK), p + ': About SDD link served');
  }
});

// --- Flow 7: outside the split test -------------------------------------------------

test('flow 7: three visits each write no event lines and leave stats.sh output unchanged', async () => {
  // Put known lines in the log first so the counts are non-trivial. Earlier
  // tests in this file also viewed /a/ and /b/, so wait for the seeds on top
  // of whatever is already there, then let the log settle before baselining.
  const pre = logLines();
  const seedA = await request('/a/');
  assert.equal(seedA.status, 200);
  const seedB = await request('/b/');
  assert.equal(seedB.status, 200);
  await waitForLogCount(pre.length + 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const beforeLines = logLines();
  const beforeStats = stats();

  for (let i = 0; i < 3; i++) {
    assert.equal((await request('/sdd/')).status, 200);
    assert.equal((await request('/sdd/whitepaper/')).status, 200);
  }
  const headSdd = await request('/sdd/', { method: 'HEAD' });
  assert.equal(headSdd.status, 200);
  const headPaper = await request('/sdd/whitepaper/', { method: 'HEAD' });
  assert.equal(headPaper.status, 200);

  // Give any stray async append time to land before checking.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(logLines(), beforeLines, 'event log unchanged by SDD visits');
  assert.equal(stats(), beforeStats, 'stats.sh output unchanged by SDD visits');
});

// --- Hygiene ---------------------------------------------------------------------

test('non-GET/HEAD on the SDD pages returns 405', async () => {
  for (const p of ['/sdd/', '/sdd/whitepaper/']) {
    const res = await request(p, { method: 'POST' });
    assert.equal(res.status, 405, p);
    assert.equal(res.headers.allow, 'GET, HEAD', p);
  }
});

test('no em dash in the files this phase touched', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const f of [
    'server.js',
    'README.md',
    path.join('site', 'sdd', 'index.html'),
    path.join('site', 'a', 'index.html'),
    path.join('site', 'b', 'index.html'),
    path.join('site', 'how-it-was-tested', 'index.html'),
    path.join('site', 'contact', 'index.html'),
    path.join('site', 'contact', 'thanks', 'index.html'),
    path.join('test', 'sdd.test.js'),
  ]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(emDash), 'U+2014 em dash found in ' + f);
  }
});
