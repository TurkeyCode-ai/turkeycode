'use strict';

// Contact page tests. Each group spawns its own server (fresh in-memory rate
// limit state) on a free port with a temp LOG_FILE and CONTACT_FILE, and where
// email is involved, a local http stand-in for SendGrid via SENDGRID_API_URL.
// Nothing here ever contacts the real SendGrid.

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

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  description: 'Build me a small booking tool for two meeting rooms.',
  timeline: 'Two weeks',
};

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

function request(port, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
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

function postContact(port, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return request(port, '/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    },
    body,
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-contact-test-'));
  const logFile = path.join(dir, 'events.log');
  const contactFile = path.join(dir, 'contact.jsonl');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      LOG_FILE: logFile,
      CONTACT_FILE: contactFile,
      // Blank by default so a developer's real SendGrid env can never leak in.
      SENDGRID_API_KEY: '',
      CONTACT_TO: '',
      CONTACT_FROM: '',
      SENDGRID_API_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await request(port, '/t.js');
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error('server did not start: ' + stderr);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    proc,
    port,
    logFile,
    contactFile,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => proc.kill('SIGTERM'),
  };
}

// A local SendGrid stand-in that records every request it receives.
function startSendgrid(status = 200) {
  return new Promise((resolve) => {
    const received = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        received,
        url: 'http://127.0.0.1:' + srv.address().port + '/v3/mail/send',
        close: () => srv.close(),
      })
    );
  });
}

function contactLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function waitFor(fn, ms = 2000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    (function poll() {
      const v = fn();
      if (v || Date.now() > deadline) return resolve(v);
      setTimeout(poll, 20);
    })();
  });
}

function assertNoCookie(res) {
  assert.equal(res.headers['set-cookie'], undefined, 'contact response must not set a cookie');
}

function assertContactHeaders(res) {
  assertNoCookie(res);
  assert.equal(res.headers.vary, undefined, 'contact response must not send Vary');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /form-action 'self'/);
}

test('contact form, validation and storage (no SendGrid env)', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await t.test('GET /contact/ serves the form with the exact wording', async () => {
    const res = await request(s.port, '/contact/');
    assert.equal(res.status, 200);
    assertContactHeaders(res);
    const html = res.body.toString('utf8');
    assert.ok(html.includes('Want it built for you?'), 'heading');
    assert.ok(
      html.includes(
        'TurkeyCode is free to run yourself. If you would rather have its maker run the build for you, send a note about what you need.'
      ),
      'the two exact sentences'
    );
    assert.ok(
      html.includes(
        "What you send is emailed to TurkeyCode's maker and kept on this site's server. It is not shared with anyone else. Replies come by email."
      ),
      'the exact privacy sentence'
    );
    for (const [id, label] of [
      ['f-name', 'Your name'],
      ['f-email', 'Email'],
      ['f-company', 'Company'],
      ['f-description', 'What do you want built?'],
      ['f-timeline', 'Timeline'],
    ]) {
      assert.ok(html.includes('<label for="' + id + '">' + label), 'label for ' + id);
    }
    assert.equal((html.match(/class="req"/g) || []).length, 3, 'three required markers');
    assert.ok(html.includes('>Send</button>'), 'Send button');
    assert.ok(html.includes('method="post" action="/contact"'), 'form posts to /contact');
    assert.ok(html.includes('name="website"'), 'honeypot field present');
    assert.match(html, /aria-hidden="true"[\s\S]*name="website"/, 'honeypot aria-hidden');
    assert.ok(html.includes('tabindex="-1"'), 'honeypot out of tab order');
    assert.ok(!/(?:src|href)=["']https?:\/\//.test(html), 'no resource from another host');
    assert.ok(!html.includes(EM_DASH), 'no em dashes');
    const head = await request(s.port, '/contact/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assertNoCookie(head);
  });

  await t.test('GET /contact and /contact/thanks redirect to the slash forms', async () => {
    const r1 = await request(s.port, '/contact');
    assert.equal(r1.status, 301);
    assert.equal(r1.headers.location, '/contact/');
    assertNoCookie(r1);
    const r2 = await request(s.port, '/contact/thanks');
    assert.equal(r2.status, 301);
    assert.equal(r2.headers.location, '/contact/thanks/');
    assertNoCookie(r2);
  });

  await t.test('thanks page has the exact sentence and a link home', async () => {
    const res = await request(s.port, '/contact/thanks/');
    assert.equal(res.status, 200);
    assertContactHeaders(res);
    const html = res.body.toString('utf8');
    assert.ok(html.includes('Thanks. Your note has been sent.'));
    assert.ok(/href="\/"/.test(html), 'link back to /');
    assert.ok(!html.includes(EM_DASH));
  });

  await t.test('other methods get 405 with the right Allow header', async () => {
    const r1 = await request(s.port, '/contact/', { method: 'POST' });
    assert.equal(r1.status, 405);
    assert.equal(r1.headers.allow, 'GET, HEAD');
    const r2 = await request(s.port, '/contact', { method: 'DELETE' });
    assert.equal(r2.status, 405);
    assert.equal(r2.headers.allow, 'GET, HEAD, POST');
    const r3 = await request(s.port, '/contact/thanks/', { method: 'PUT' });
    assert.equal(r3.status, 405);
    assert.equal(r3.headers.allow, 'GET, HEAD');
  });

  await t.test('missing name re-renders with entries kept and a message beside the field', async () => {
    const res = await postContact(s.port, { ...VALID, name: '' });
    assert.equal(res.status, 200);
    assertContactHeaders(res);
    const html = res.body.toString('utf8');
    assert.ok(html.includes('Please enter your name.'));
    assert.match(html, /id="err-name"/);
    assert.match(html, /aria-describedby="err-name"/);
    assert.ok(html.includes('value="ada@example.com"'), 'email kept');
    assert.ok(html.includes(VALID.description), 'description kept');
    assert.ok(html.includes('value="Two weeks"'), 'timeline kept');
    assert.equal(contactLines(s.contactFile).length, 0, 'nothing saved');
    assert.ok(!fs.existsSync(s.logFile) || !fs.readFileSync(s.logFile, 'utf8').includes('enquiry'));
  });

  await t.test('implausible email gets a message beside the email field', async () => {
    for (const bad of ['not-an-address', 'a@b', '@example.com', 'a b@example.com', 'a@@example.com']) {
      const res = await postContact(s.port, { ...VALID, email: bad });
      assert.equal(res.status, 200);
      const html = res.body.toString('utf8');
      assert.ok(
        html.includes('Please enter an email address like name@example.com.'),
        'message for ' + bad
      );
      assert.match(html, /aria-describedby="err-email"/);
    }
    assert.equal(contactLines(s.contactFile).length, 0);
  });

  await t.test('missing description gets its own message', async () => {
    const res = await postContact(s.port, { ...VALID, description: '' });
    const html = res.body.toString('utf8');
    assert.ok(html.includes('Please say what you want built.'));
    assert.match(html, /aria-describedby="err-description"/);
  });

  await t.test('over-limit fields are each rejected with a message beside them', async () => {
    const res = await postContact(s.port, {
      name: 'x'.repeat(201),
      email: 'a'.repeat(250) + '@example.com', // 262 > 254
      company: 'y'.repeat(201),
      description: 'z'.repeat(5001),
      timeline: 'w'.repeat(201),
    });
    assert.equal(res.status, 200);
    const html = res.body.toString('utf8');
    for (const f of ['name', 'email', 'company', 'description', 'timeline']) {
      assert.match(html, new RegExp('id="err-' + f + '"'), 'error beside ' + f);
    }
    assert.ok(html.includes('Please keep this under 200 characters.'));
    assert.ok(html.includes('Please keep this under 254 characters.'));
    assert.ok(html.includes('Please keep this under 5000 characters.'));
    assert.equal(contactLines(s.contactFile).length, 0);
  });

  await t.test('kept entries are HTML-escaped', async () => {
    const res = await postContact(s.port, {
      ...VALID,
      email: '',
      name: '<b>"Ada"&\'co\'</b>',
      description: '<script>alert(1)</script> $& stays text',
    });
    const html = res.body.toString('utf8');
    assert.ok(html.includes('value="&lt;b&gt;&quot;Ada&quot;&amp;&#39;co&#39;&lt;/b&gt;"'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; $&amp; stays text'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<b>"Ada"'));
  });

  await t.test('a body over 20480 bytes gets 413 and nothing is saved', async () => {
    const res = await postContact(s.port, { ...VALID, description: 'z'.repeat(25000) });
    assert.equal(res.status, 413);
    assertNoCookie(res);
    assert.equal(contactLines(s.contactFile).length, 0);
    // A chunked body with no declared length is cut off while streaming too.
    const body = new URLSearchParams({ ...VALID, description: 'z'.repeat(25000) }).toString();
    const res2 = await request(s.port, '/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res2.status, 413);
    assert.equal(contactLines(s.contactFile).length, 0);
  });

  await t.test('honeypot filled: thanked, nothing saved or logged', async () => {
    const res = await postContact(s.port, { ...VALID, website: 'http://spam.example' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/contact/thanks/');
    assertNoCookie(res);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(contactLines(s.contactFile).length, 0, 'nothing saved');
    const log = fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '';
    assert.ok(!log.includes('enquiry'), 'nothing logged');
  });

  await t.test('valid submission: saved with emailSent false, 0600, one clean enquiry line', async () => {
    const res = await postContact(s.port, VALID, { Cookie: 'tc_ab=b' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/contact/thanks/');
    assertNoCookie(res);
    const lines = contactLines(s.contactFile);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.name, VALID.name);
    assert.equal(rec.email, VALID.email);
    assert.equal(rec.company, VALID.company);
    assert.equal(rec.description, VALID.description);
    assert.equal(rec.timeline, VALID.timeline);
    assert.equal(rec.emailSent, false);
    assert.match(rec.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(fs.statSync(s.contactFile).mode & 0o777, 0o600, 'file mode 0600');
    const log = await waitFor(() => {
      const text = fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '';
      return text.includes('enquiry') ? text : null;
    });
    const enquiryLines = log.split('\n').filter((l) => l.includes('enquiry'));
    assert.equal(enquiryLines.length, 1, 'exactly one enquiry line');
    assert.match(
      enquiryLines[0],
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z b enquiry - -$/,
      'five fields, page from the tc_ab cookie'
    );
    for (const word of ['Ada', 'Lovelace', 'example.com', 'Analytical', 'booking', 'weeks']) {
      assert.ok(!log.includes(word), 'log must not contain submitted text: ' + word);
    }
  });

  await t.test('a visitor with no cookie logs page "-"', async () => {
    const res = await postContact(s.port, { ...VALID, name: 'Grace Hopper' });
    assert.equal(res.status, 303);
    const log = await waitFor(() => {
      const text = fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '';
      const n = text.split('\n').filter((l) => l.includes('enquiry')).length;
      return n >= 2 ? text : null;
    });
    const lines = log.split('\n').filter((l) => l.includes('enquiry'));
    assert.match(lines[1], / - enquiry - -$/);
    assert.equal(contactLines(s.contactFile).length, 2);
  });
});

test('SendGrid send via a local stand-in', async (t) => {
  const sg = await startSendgrid(202);
  const s = await startServer({
    SENDGRID_API_KEY: 'SG.test-key-123',
    CONTACT_TO: 'maker@example.net',
    CONTACT_FROM: 'site@example.net',
    SENDGRID_API_URL: sg.url,
  });
  t.after(() => {
    s.stop();
    sg.close();
  });

  await t.test('one valid POST makes exactly one correct SendGrid request', async () => {
    const res = await postContact(s.port, VALID);
    assert.equal(res.status, 303);
    assert.equal(sg.received.length, 1, 'exactly one request to the stand-in');
    const got = sg.received[0];
    assert.equal(got.method, 'POST');
    assert.equal(got.headers.authorization, 'Bearer SG.test-key-123');
    assert.match(got.headers['content-type'], /application\/json/);
    const payload = JSON.parse(got.body);
    assert.deepEqual(payload.personalizations, [{ to: [{ email: 'maker@example.net' }] }]);
    assert.deepEqual(payload.from, { email: 'site@example.net' });
    assert.deepEqual(payload.reply_to, { email: VALID.email });
    assert.ok(payload.subject.startsWith('TurkeyCode enquiry from '));
    assert.equal(payload.subject, 'TurkeyCode enquiry from ' + VALID.name);
    assert.equal(payload.content.length, 1);
    assert.equal(payload.content[0].type, 'text/plain');
    for (const v of [VALID.name, VALID.email, VALID.company, VALID.description, VALID.timeline]) {
      assert.ok(payload.content[0].value.includes(v), 'body lists ' + v);
    }
    const lines = contactLines(s.contactFile);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).emailSent, true, 'saved line records the send');
  });

  await t.test('CR and LF are stripped from the subject', async () => {
    const res = await postContact(s.port, { ...VALID, name: 'Ada\r\nBcc: spam@example.org\u0000!' });
    assert.equal(res.status, 303);
    assert.equal(sg.received.length, 2);
    const payload = JSON.parse(sg.received[1].body);
    assert.ok(!/[\r\n\u0000]/.test(payload.subject), 'no control characters in subject');
    assert.ok(payload.subject.startsWith('TurkeyCode enquiry from '));
  });
});

test('SendGrid failure: visitor still thanked, one clean console line', async (t) => {
  const sg = await startSendgrid(500);
  const s = await startServer({
    SENDGRID_API_KEY: 'SG.secret-key-456',
    CONTACT_TO: 'maker@example.net',
    CONTACT_FROM: 'site@example.net',
    SENDGRID_API_URL: sg.url,
  });
  t.after(() => {
    s.stop();
    sg.close();
  });

  await t.test('stand-in returns 500', async () => {
    const res = await postContact(s.port, VALID);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/contact/thanks/');
    const lines = contactLines(s.contactFile);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).emailSent, false);
    const out = await waitFor(() => (s.stdout().includes('contact:') ? s.stdout() : null));
    const failLines = (out + s.stderr()).split('\n').filter((l) => l.startsWith('contact:'));
    assert.equal(failLines.length, 1, 'exactly one failure line');
    assert.equal(failLines[0], 'contact: email failed, status 500');
    assert.ok(!failLines[0].includes('@'), 'no address in the line');
    assert.ok(!failLines[0].includes('secret-key'), 'no key in the line');
    assert.ok(!(out + s.stderr()).includes('SG.secret-key-456'), 'key never printed');
    assert.ok(!(out + s.stderr()).includes('Ada'), 'submission never printed');
  });

  await t.test('network error: still thanked, status network-error', async () => {
    // A port nothing listens on: the send fails at the socket, not with a status.
    const deadPort = await freePort();
    const s2 = await startServer({
      SENDGRID_API_KEY: 'SG.secret-key-456',
      CONTACT_TO: 'maker@example.net',
      CONTACT_FROM: 'site@example.net',
      SENDGRID_API_URL: 'http://127.0.0.1:' + deadPort + '/v3/mail/send',
    });
    try {
      const res = await postContact(s2.port, { ...VALID, name: 'Grace Hopper' });
      assert.equal(res.status, 303);
      const lines = contactLines(s2.contactFile);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).emailSent, false);
      const out = await waitFor(() =>
        s2.stdout().includes('network-error') ? s2.stdout() : null
      );
      const failLines = out.split('\n').filter((l) => l.startsWith('contact:'));
      assert.equal(failLines.length, 1);
      assert.equal(failLines[0], 'contact: email failed, status network-error');
    } finally {
      s2.stop();
    }
  });
});

test('rate limit: the fourth valid submission from one address gets 429', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  for (let i = 1; i <= 3; i++) {
    const res = await postContact(s.port, { ...VALID, description: 'Accepted number ' + i });
    assert.equal(res.status, 303, 'submission ' + i + ' accepted');
  }
  const res4 = await postContact(s.port, { ...VALID, description: 'One too many' });
  assert.equal(res4.status, 429);
  assertContactHeaders(res4);
  const html = res4.body.toString('utf8');
  assert.match(res4.headers['content-type'], /text\/html/);
  assert.ok(html.includes('try again later'), 'asks the visitor to try again later');
  assert.ok(!html.includes(EM_DASH));
  const lines = contactLines(s.contactFile);
  assert.equal(lines.length, 3, 'the fourth submission is not saved');
  assert.ok(!lines.some((l) => l.includes('One too many')));
  // Invalid submissions do not count: still refused for valid, but an invalid
  // one is re-rendered normally rather than rate limited.
  const invalid = await postContact(s.port, { ...VALID, email: 'nope' });
  assert.equal(invalid.status, 200);
  assert.ok(invalid.body.toString('utf8').includes('Please enter an email address'));
});

test('rate limit internals: global cap and window expiry (unit level)', () => {
  // Loopback tests cannot exercise the global cap (every request shares one
  // address, so the per-address cap fires first); check the limiter directly.
  process.env.LOG_FILE = path.join(os.tmpdir(), 'tc-contact-unit-events.log');
  process.env.CONTACT_FILE = path.join(os.tmpdir(), 'tc-contact-unit-contact.jsonl');
  const srv = require(path.join(ROOT, 'server.js'));
  assert.equal(srv.RATE_PER_ADDRESS, 3);
  assert.equal(srv.RATE_GLOBAL, 20);
  assert.equal(srv.RATE_WINDOW_MS, 10 * 60 * 1000);
  const t0 = Date.now();
  // Per-address: a fourth submission from one address inside the window is refused.
  for (let i = 0; i < 3; i++) {
    assert.equal(srv.rateLimitAllows('10.0.0.1', t0 + i), true);
    srv.rateLimitRecord('10.0.0.1', t0 + i);
  }
  assert.equal(srv.rateLimitAllows('10.0.0.1', t0 + 10), false, 'per-address cap');
  assert.equal(srv.rateLimitAllows('10.0.0.2', t0 + 10), true, 'other addresses unaffected');
  // Global: 20 accepted submissions across addresses refuse the 21st address.
  for (let i = 0; i < 17; i++) {
    const addr = '10.0.1.' + i;
    assert.equal(srv.rateLimitAllows(addr, t0 + 20 + i), true);
    srv.rateLimitRecord(addr, t0 + 20 + i);
  }
  assert.equal(srv.rateLimitAllows('10.0.2.1', t0 + 100), false, 'global cap of 20');
  // After the window passes, both caps reset and the map is pruned.
  const later = t0 + srv.RATE_WINDOW_MS + 1000;
  assert.equal(srv.rateLimitAllows('10.0.0.1', later), true, 'window expiry');
});

test('stats.sh: enquiry lines move only the enquiries lines, and --daily ignores them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-contact-stats-'));
  const base = [
    '2026-11-20T10:00:00.000Z a view split first',
    '2026-11-20T10:01:00.000Z a copy split first',
    '2026-11-20T10:02:00.000Z b view split first',
    '2026-11-21T09:00:00.000Z b view direct repeat',
    '2026-11-21T09:05:00.000Z a view bot repeat',
  ];
  const withEnquiries = [
    base[0],
    '2026-11-20T10:00:30.000Z a enquiry - -',
    ...base.slice(1),
    '2026-11-21T09:10:00.000Z - enquiry - -',
    '2026-11-21T09:11:00.000Z b enquiry - -',
  ];
  const plain = path.join(dir, 'plain.log');
  const mixed = path.join(dir, 'mixed.log');
  fs.writeFileSync(plain, base.join('\n') + '\n');
  fs.writeFileSync(mixed, withEnquiries.join('\n') + '\n');
  const run = (args, log) =>
    spawnSync('sh', [path.join(ROOT, 'stats.sh'), ...args, log], { encoding: 'utf8' });

  // --daily is byte-identical with and without enquiry lines:
  const dailyA = run(['--daily'], plain);
  const dailyB = run(['--daily'], mixed);
  assert.equal(dailyA.status, 0);
  assert.equal(dailyB.status, 0);
  assert.equal(dailyB.stdout, dailyA.stdout, 'stats.sh --daily unchanged');

  // The plain report differs only on the labelled enquiries lines:
  const a = run([], plain);
  const b = run([], mixed);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  const isEnq = (l) => l.includes('enquiries=');
  assert.deepEqual(
    b.stdout.split('\n').filter((l) => !isEnq(l)),
    a.stdout.split('\n').filter((l) => !isEnq(l)),
    'every other stats.sh line unchanged by enquiry lines'
  );
  assert.ok(b.stdout.includes('page a:  enquiries=      1  (not part of the conversion rate)'), b.stdout);
  assert.ok(b.stdout.includes('page b:  enquiries=      1  (not part of the conversion rate)'), b.stdout);
  assert.ok(
    b.stdout.includes('page -:  enquiries=      1  (no split cookie, not part of the conversion rate)'),
    b.stdout
  );
  assert.ok(a.stdout.includes('page a:  enquiries=      0  (not part of the conversion rate)'), a.stdout);
});

test('contact.sh prints enquiries oldest first and handles a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-contact-sh-'));
  const file = path.join(dir, 'contact.jsonl');
  const recs = [
    {
      time: '2026-11-20T10:00:00.000Z',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: '',
      description: 'First note.',
      timeline: 'soon',
      emailSent: true,
    },
    {
      time: '2026-11-21T11:00:00.000Z',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      company: 'Navy',
      description: 'Second note.',
      timeline: '',
      emailSent: false,
    },
  ];
  fs.writeFileSync(
    file,
    JSON.stringify(recs[0]) + '\n' + 'this line is not json\n' + JSON.stringify(recs[1]) + '\n'
  );
  const out = spawnSync('sh', [path.join(ROOT, 'contact.sh'), file], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.ok(out.stdout.indexOf('Ada Lovelace') < out.stdout.indexOf('Grace Hopper'), 'oldest first');
  assert.ok(out.stdout.includes('email sent: yes'));
  assert.ok(out.stdout.includes('email sent: no'));
  assert.ok(out.stdout.includes('First note.'));
  assert.ok(!out.stdout.includes('not json'), 'malformed lines skipped');
  const missing = spawnSync(
    'sh',
    [path.join(ROOT, 'contact.sh'), path.join(dir, 'nope.jsonl')],
    { encoding: 'utf8' }
  );
  assert.equal(missing.status, 0);
  assert.ok(missing.stdout.includes('no enquiries'));
});

test('existing pages are untouched and carry no contact wiring', () => {
  for (const rel of ['a/index.html', 'b/index.html', 'how-it-was-tested/index.html']) {
    const diff = spawnSync('git', ['diff', 'HEAD', '--', path.join('site', rel)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(diff.stdout, '', rel + ' unchanged in the working tree');
  }
  // No SendGrid key or real address is baked into the repo's runtime files.
  for (const rel of ['server.js', 'Dockerfile', 'contact.sh']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/SG\.[A-Za-z0-9_-]{10,}/.test(text), rel + ' has no SendGrid key');
    assert.ok(!text.includes(EM_DASH), rel + ' has no em dashes');
  }
});
