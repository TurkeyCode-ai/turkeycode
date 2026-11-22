'use strict';

// stats.sh against fixture logs: the visitor report (core flow 5), the bot
// line (flow 6, stats part), direct lines (flow 8, stats part) and the mixed
// legacy, multi-day log (flow 10), plus --daily, argument handling and
// alignment. The server side of these flows is covered in reach.test.js;
// here each fixture is the exact log those flows produce.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EM_DASH = String.fromCharCode(0x2014);

function runStats(args, env) {
  return spawnSync('sh', [path.join(ROOT, 'stats.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stats-fixture-'));
  const log = path.join(dir, 'events.log');
  fs.writeFileSync(log, lines.length ? lines.join('\n') + '\n' : '');
  return log;
}

// --- Expected-output builders, mirroring the printf widths in stats.sh ------

const pad = (v, w) => String(v).padStart(w);
const conv = (acted, vis) =>
  vis > 0 ? ((acted * 100) / vis).toFixed(1) + '%' : '0.0%';

const PLAIN_HEADER =
  'Visitors per page (split, browser ran the page script); acted = first copy or outbound; conversion = acted / visitors';
const DAILY_HEADER =
  'Split visitors per UTC day (browser ran the page script); acted = first copy or outbound; the total row matches plain stats.sh';

function dailyColumnsLine() {
  return (
    'day'.padEnd(12) +
    pad('a visitors', 12) + pad('a acted', 9) + pad('a conv', 8) +
    pad('b visitors', 12) + pad('b acted', 9) + pad('b conv', 8)
  );
}

function visitorLine(p, v, a) {
  return 'page ' + p + ':  visitors=' + pad(v, 7) + '  acted=' + pad(a, 7) +
    '  conversion=' + pad(conv(a, v), 7);
}

function refLine(p, c, o) {
  return 'page ' + p + ':  copies=' + pad(c, 9) + '  outbound=' + pad(o, 4) +
    '  (split event totals, for reference)';
}

function servedLine(p, n) {
  return 'page ' + p + ':  pages served=' + pad(n, 3) +
    '  (first split views, script run or not; not part of the comparison)';
}

function earlyLine(n) {
  return 'first actions before the script check began: ' + n +
    '  (not part of the comparison)';
}

function directLine(p, d) {
  return 'page ' + p + ':  direct views=' + pad(d, 3) +
    '  (not part of the comparison)';
}

function botLine(p, n) {
  return 'page ' + p + ':  bot views=' + pad(n, 6) +
    '  (not part of the comparison)';
}

function legacyLine(n) {
  return 'views logged before visitor counting began: ' + n;
}

function servicesLine(p, n) {
  return 'page ' + p + ':  services clicks=' + pad(n, 4) +
    '  (split lines, not part of the conversion rate)';
}

function enquiriesLine(p, n) {
  return 'page ' + p + ':  enquiries=' + pad(n, 7) +
    '  (not part of the conversion rate)';
}

function enquiriesNoCookieLine(n) {
  return 'page -:  enquiries=' + pad(n, 7) +
    '  (no split cookie, not part of the conversion rate)';
}

// counts: { a: {v, a, c, o, p, d, b, s, e}, b: {...}, early, legacy, noCookieEnq },
// all defaulting to 0 (p = pages served, s = services split clicks,
// e = enquiries, early = first actions before the script check began).
function plainReport(counts) {
  const page = (p) => {
    const z = { v: 0, a: 0, c: 0, o: 0, p: 0, d: 0, b: 0, s: 0, e: 0, ...(counts[p] || {}) };
    return z;
  };
  const A = page('a');
  const B = page('b');
  return [
    PLAIN_HEADER,
    visitorLine('a', A.v, A.a),
    visitorLine('b', B.v, B.a),
    refLine('a', A.c, A.o),
    refLine('b', B.c, B.o),
    servedLine('a', A.p),
    servedLine('b', B.p),
    earlyLine(counts.early || 0),
    directLine('a', A.d),
    directLine('b', B.d),
    botLine('a', A.b),
    botLine('b', B.b),
    legacyLine(counts.legacy || 0),
    servicesLine('a', A.s),
    servicesLine('b', B.s),
    enquiriesLine('a', A.e),
    enquiriesLine('b', B.e),
    enquiriesNoCookieLine(counts.noCookieEnq || 0),
  ].join('\n') + '\n';
}

function dailyRow(label, av, aa, bv, ba) {
  return label.padEnd(12) +
    pad(av, 12) + pad(aa, 9) + pad(conv(aa, av), 8) +
    pad(bv, 12) + pad(ba, 9) + pad(conv(ba, bv), 8);
}

// --- Flow 5: the log flows 1 to 4 produce ----------------------------------

// Flow 1: view split first, then the page script reports seen; flow 2: view
// split repeat; flow 3: copy split first; flow 4: outbound and copy, both split repeat. Page a throughout.
const FLOW_1_TO_4 = [
  '2026-11-21T10:00:00.000Z a view split first',
  '2026-11-21T10:00:01.000Z a seen split first',
  '2026-11-21T10:00:05.000Z a view split repeat',
  '2026-11-21T10:00:10.000Z a copy split first',
  '2026-11-21T10:00:15.000Z a outbound split repeat',
  '2026-11-21T10:00:20.000Z a copy split repeat',
];

test('flow 5: the flows 1-4 log shows 1 visitor, 1 acted, 100.0%, copies 2, outbound 1', () => {
  const out = runStats([writeLog(FLOW_1_TO_4)]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  assert.equal(
    out.stdout,
    plainReport({ a: { v: 1, a: 1, c: 2, o: 1, p: 1 } })
  );
});

test('flow 6 (stats): a view bot repeat line leaves the visitor figures unchanged and shows on the bot line', () => {
  const out = runStats([
    writeLog([...FLOW_1_TO_4, '2026-11-21T10:01:00.000Z b view bot repeat']),
  ]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout,
    plainReport({ a: { v: 1, a: 1, c: 2, o: 1, p: 1 }, b: { b: 1 } })
  );
});

test('flow 8 (stats): direct repeat lines change only the direct line', () => {
  const out = runStats([
    writeLog([
      ...FLOW_1_TO_4,
      '2026-11-21T10:02:00.000Z b view direct repeat',
      '2026-11-21T10:02:05.000Z b copy direct repeat',
    ]),
  ]);
  assert.equal(out.status, 0, out.stderr);
  // The direct copy is not a split event, so only the direct views line moves.
  assert.equal(
    out.stdout,
    plainReport({ a: { v: 1, a: 1, c: 2, o: 1, p: 1 }, b: { d: 1 } })
  );
});

// --- Flow 10: mixed legacy, multi-day, bot and direct lines -----------------

// Days are deliberately out of order in the file so --daily must sort them.
const MIXED = [
  '2026-11-20T08:00:00.000Z b view split first',
  '2026-11-20T08:00:01.000Z b seen split first',
  '2026-11-20T08:00:02.000Z b seen split repeat',
  '2026-11-20T08:00:05.000Z b copy split first',
  // Legacy three- and four-field lines, from before visitor counting:
  '2026-11-18T09:00:00.000Z a view',
  '2026-11-18T09:00:01.000Z a copy',
  '2026-11-18T09:00:02.000Z b view split',
  '2026-11-18T09:00:03.000Z a view direct',
  // Day 2026-11-19, split lines for page a:
  '2026-11-19T10:00:00.000Z a view split first',
  '2026-11-19T10:00:01.000Z a seen split first',
  '2026-11-19T10:00:05.000Z a view split repeat',
  '2026-11-19T10:00:10.000Z a outbound split first',
  // Served a page but never ran the script: not a visitor.
  '2026-11-19T10:00:15.000Z a view split first',
  // Bot and direct lines:
  '2026-11-19T11:00:00.000Z a view bot repeat',
  '2026-11-19T11:30:00.000Z b view direct repeat',
  // Malformed lines that must be ignored:
  'not a log line',
  '2026-11-19T12:00:00.000Z c view split first',
  '2026-11-19T12:00:00.000Z a clicked split first',
  '2026-11-19T12:00:00.000Z a view sideways first',
  '2026-11-19T12:00:00.000Z a view split extra',
];

test('flow 10: plain report counts old lines only on the pre-visitor-counting line', () => {
  const out = runStats([writeLog(MIXED)]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  // Legacy views: 'a view', 'b view split' and 'a view direct' (the legacy
  // copy has no view and counts nowhere).
  assert.equal(
    out.stdout,
    plainReport({
      a: { v: 1, a: 1, o: 1, p: 2, b: 1 },
      b: { v: 1, a: 1, c: 1, p: 1, d: 1 },
      legacy: 3,
    })
  );
});

test('flow 10: --daily prints one row per UTC day, oldest first, and a totals row matching the plain report', () => {
  const out = runStats(['--daily', writeLog(MIXED)]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  assert.equal(
    out.stdout,
    [
      DAILY_HEADER,
      dailyColumnsLine(),
      dailyRow('2026-11-19', 1, 1, 0, 0),
      dailyRow('2026-11-20', 0, 0, 1, 1),
      dailyRow('total', 1, 1, 1, 1),
    ].join('\n') + '\n'
  );
  // The legacy day 2026-11-18 has no five-field split line: no row for it.
  assert.ok(!out.stdout.includes('2026-11-18'), 'no row for a legacy-only day');
});

test('flow 10: plain and --daily agree on the totals', () => {
  const log = writeLog(MIXED);
  const plain = runStats([log]).stdout;
  const daily = runStats(['--daily', log]).stdout;
  const figures = {};
  for (const p of ['a', 'b']) {
    const m = new RegExp(
      'page ' + p + ':  visitors=\\s*(\\d+)  acted=\\s*(\\d+)  conversion=\\s*([\\d.]+%)'
    ).exec(plain);
    assert.ok(m, 'plain figures for page ' + p + ':\n' + plain);
    figures[p] = m;
  }
  const totalRow = daily.trimEnd().split('\n').pop();
  assert.ok(totalRow.startsWith('total'), 'last daily row is the total:\n' + daily);
  const cols = totalRow.replace(/^total/, '').trim().split(/\s+/);
  assert.deepEqual(
    cols,
    [figures.a[1], figures.a[2], figures.a[3], figures.b[1], figures.b[2], figures.b[3]],
    'daily total matches the plain report'
  );
});

test('a page served to a client that never runs the script is not a visitor', () => {
  const out = runStats([
    writeLog([
      '2026-11-22T09:00:00.000Z a view split first',
      '2026-11-22T09:00:01.000Z b view split first',
      '2026-11-22T09:00:02.000Z b view split first',
      '2026-11-22T09:00:03.000Z b seen split first',
    ]),
  ]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, plainReport({ a: { p: 1 }, b: { v: 1, p: 2 } }));
});

test('first actions logged before the first seen line are reported apart, in both modes', () => {
  const log = writeLog([
    '2026-11-21T23:00:00.000Z a view split first',
    '2026-11-21T23:30:00.000Z a outbound split first',
    '2026-11-22T09:00:00.000Z b view split first',
    '2026-11-22T09:00:01.000Z b seen split first',
    '2026-11-22T09:00:09.000Z b copy split first',
  ]);
  const out = runStats([log]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout,
    plainReport({ a: { o: 1, p: 1 }, b: { v: 1, a: 1, c: 1, p: 1 }, early: 1 })
  );
  const daily = runStats(['--daily', log]);
  assert.equal(
    daily.stdout,
    [
      DAILY_HEADER,
      dailyColumnsLine(),
      dailyRow('2026-11-22', 0, 0, 1, 1),
      dailyRow('total', 0, 0, 1, 1),
    ].join('\n') + '\n'
  );
});

// --- Arguments, empty logs and alignment ------------------------------------

test('the log path argument works in either position alongside --daily', () => {
  const log = writeLog(FLOW_1_TO_4);
  const before = runStats(['--daily', log]).stdout;
  const after = runStats([log, '--daily']).stdout;
  assert.equal(before, after);
  assert.ok(before.includes(dailyRow('total', 1, 1, 0, 0)));
});

test('a missing or empty log prints zeros in both modes, and LOG_FILE is honoured', () => {
  const missing = path.join(os.tmpdir(), 'tc-definitely-missing.log');
  const empty = writeLog([]);
  const zeros = plainReport({});
  for (const log of [missing, empty]) {
    const plain = runStats([log]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, zeros);
    const daily = runStats(['--daily', log]);
    assert.equal(daily.status, 0, daily.stderr);
    assert.equal(
      daily.stdout,
      [DAILY_HEADER, dailyColumnsLine(), dailyRow('total', 0, 0, 0, 0)].join('\n') + '\n'
    );
  }
  const viaEnv = runStats([], { LOG_FILE: writeLog(FLOW_1_TO_4.slice(0, 2)) });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.ok(viaEnv.stdout.includes(visitorLine('a', 1, 0)), 'LOG_FILE is honoured');
});

test('output is aligned plain text with a header line and no em dash', () => {
  const log = writeLog(MIXED);
  for (const args of [[log], ['--daily', log]]) {
    const out = runStats(args).stdout;
    const lines = out.trimEnd().split('\n');
    assert.ok(lines.length > 1, 'header plus rows');
    assert.ok(/[a-z]/i.test(lines[0]) && !/\d{4}-\d{2}-\d{2}/.test(lines[0]),
      'the first line is a header, not data: ' + lines[0]);
    assert.ok(!out.includes(EM_DASH), 'no em dash in the output');
  }
  // Rows of the same kind are the same length, so columns line up.
  const plain = runStats([log]).stdout.split('\n');
  for (const prefix of ['page a:  visitors=', 'page a:  copies=', 'page a:  direct views=', 'page a:  bot views=', 'page a:  services clicks=', 'page a:  enquiries=']) {
    const twin = prefix.replace('page a', 'page b');
    const rowA = plain.find((l) => l.startsWith(prefix));
    const rowB = plain.find((l) => l.startsWith(twin));
    assert.ok(rowA && rowB, prefix);
    assert.equal(rowA.length, rowB.length, 'aligned: ' + prefix);
  }
  const daily = runStats(['--daily', log]).stdout.trimEnd().split('\n').slice(1);
  const widths = new Set(daily.map((l) => l.length));
  assert.equal(widths.size, 1, 'every daily row has the same width: ' + [...widths]);
});

test('no em dash in stats.sh or this test file', () => {
  for (const f of ['stats.sh', path.join('test', 'stats.test.js')]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!text.includes(EM_DASH), 'U+2014 em dash found in ' + f);
  }
});
