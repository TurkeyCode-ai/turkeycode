'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const LOG_FILE = process.env.LOG_FILE || '/data/events.log';
const SITE_DIR = path.join(__dirname, 'site');
const COOKIE_NAME = 'tc_ab';
const COOKIE_MAX_AGE = 2592000; // 30 days

// All content is loaded into memory at startup. Nothing is read from
// reference/ and no request path ever touches the filesystem.
function load(rel) {
  return fs.readFileSync(path.join(SITE_DIR, rel));
}

const PAGES = {
  a: load('a/index.html'),
  b: load('b/index.html'),
};

// Page A's file on disk stays byte-identical to the reference site; its
// tracker is injected here, at serve time only. Page B carries the script
// tag in its own file; only the data-via marker is injected into that tag.
const TRACKER = load('t.js');

// How the page was reached is decided by the server at serve time: pages
// served at / are 'split', pages served at /a/ and /b/ are 'direct'. The
// marker rides on the tracker script tag as data-via, so the visitor can
// never get it wrong, and the four variants are prebuilt at startup.
function withTracker(html, page, via) {
  const tag = Buffer.from(
    '<script src="/t.js" data-page="' + page + '" data-via="' + via + '"></script>\n'
  );
  const marker = Buffer.from('</body>');
  const idx = html.lastIndexOf(marker);
  if (idx === -1) return Buffer.concat([html, tag]);
  return Buffer.concat([html.subarray(0, idx), tag, html.subarray(idx)]);
}

// Page B carries '<script src="/t.js"></script>' in its own file; rewrite
// that one tag to carry data-via. No visible wording changes.
function withVia(html, via) {
  const plain = Buffer.from('<script src="/t.js"></script>');
  const tagged = Buffer.from('<script src="/t.js" data-via="' + via + '"></script>');
  const idx = html.indexOf(plain);
  if (idx === -1) return html;
  return Buffer.concat([html.subarray(0, idx), tagged, html.subarray(idx + plain.length)]);
}

const SERVED = {
  split: {
    a: withTracker(PAGES.a, 'a', 'split'),
    b: withVia(PAGES.b, 'split'),
  },
  direct: {
    a: withTracker(PAGES.a, 'a', 'direct'),
    b: withVia(PAGES.b, 'direct'),
  },
};

// The write-up is outside the test: served identically to every visitor,
// with no tracker injected, no cookie and no event log line.
const WRITEUP = load('how-it-was-tested/index.html');

const VIDEO = { a: load('a/turkey.mp4'), b: load('b/turkey.mp4') };
const POSTER = { a: load('a/turkey-poster.jpg'), b: load('b/turkey-poster.jpg') };

// Exact-match asset table: traversal attempts can never resolve to a file.
const ASSETS = {
  '/t.js': { body: TRACKER, type: 'text/javascript; charset=utf-8' },
  '/a/turkey.mp4': { body: VIDEO.a, type: 'video/mp4' },
  '/a/turkey-poster.jpg': { body: POSTER.a, type: 'image/jpeg' },
  '/b/turkey.mp4': { body: VIDEO.b, type: 'video/mp4' },
  '/b/turkey-poster.jpg': { body: POSTER.b, type: 'image/jpeg' },
  '/turkey.mp4': { body: VIDEO.b, type: 'video/mp4' },
  '/turkey-poster.jpg': { body: POSTER.b, type: 'image/jpeg' },
};

// --- Crawler detection --------------------------------------------------------
// The one place crawler detection lives: a request counts as a crawler when
// its User-Agent is missing or empty, or contains any of these tokens. All
// matching is case-insensitive; the generic 'bot', 'crawler' and 'spider'
// entries catch whole families. Extend by adding a token to this list.
// The User-Agent value itself is never logged or printed anywhere.
const CRAWLER_TOKENS = [
  'googlebot',
  'bingbot',
  'duckduckbot',
  'yandexbot',
  'baiduspider',
  'ahrefsbot',
  'semrushbot',
  'gptbot',
  'claudebot',
  'perplexitybot',
  'bytespider',
  'facebookexternalhit',
  'twitterbot',
  'slackbot',
  'discordbot',
  'linkedinbot',
  'uptimerobot',
  'curl',
  'wget',
  'python-requests',
  'go-http-client',
  'headlesschrome',
  'bot',
  'crawler',
  'spider',
];

function isCrawler(req) {
  const ua = req.headers['user-agent'];
  if (!ua || !ua.trim()) return true;
  const lower = ua.toLowerCase();
  for (const token of CRAWLER_TOKENS) {
    if (lower.includes(token)) return true;
  }
  return false;
}

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

// --- View log -------------------------------------------------------------
// One line per HTML view, appended (O_APPEND) in a single write. Errors are
// swallowed: logging must never fail or delay a response. No IP, UA, cookie
// value or URL is ever written, and there is no access log.
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch (err) {
  // If the directory cannot be created, views go uncounted; serving continues.
}

// page, event, via and novelty are always validated literals ('a'/'b',
// 'view'/'copy'/'outbound', 'split'/'direct'/'bot', 'first'/'repeat') before
// this is called; no client-supplied text reaches the log.
// Appends are chained on a promise so lines land in call order; independent
// fs.appendFile calls can complete out of order in the threadpool.
let logChain = Promise.resolve();
function logEvent(page, event, via, novelty) {
  const line =
    new Date().toISOString() + ' ' + page + ' ' + event + ' ' + via + ' ' +
    novelty + '\n';
  logChain = logChain
    .then(() => fs.promises.appendFile(LOG_FILE, line))
    .catch(() => {});
}

// --- Cookie handling --------------------------------------------------------
// The single tc_ab cookie holds exactly one of: a, b (assigned, no copy or
// outbound event logged yet) or a1, b1 (assigned, first event already
// logged). Anything else is treated as no cookie at all.
function cookieState(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      if (value === 'a' || value === 'b') return { page: value, acted: false };
      if (value === 'a1') return { page: 'a', acted: true };
      if (value === 'b1') return { page: 'b', acted: true };
      return null; // invalid value: treat as unassigned
    }
  }
  return null;
}

function splitCookie(value) {
  return (
    COOKIE_NAME + '=' + value +
    '; Max-Age=' + COOKIE_MAX_AGE +
    '; Path=/; SameSite=Lax; HttpOnly'
  );
}

// --- Responses --------------------------------------------------------------
// variant picks the prebuilt markup (the data-via marker on the tracker tag);
// reach is what the view line records ('split', 'direct' or 'bot') and
// novelty its fifth field. A crawler at / gets the split markup but a 'bot'
// line and never a cookie.
function serveHtml(req, res, page, setCookie, variant, reach, novelty) {
  const body = SERVED[variant][page];
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Vary': 'Cookie',
    'Content-Security-Policy': CSP,
  };
  if (setCookie) headers['Set-Cookie'] = splitCookie(page);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
  if (!req.headers.range) logEvent(page, 'view', reach, novelty);
}

// The response never varies (no Vary: Cookie) and nothing is logged.
function serveWriteup(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': WRITEUP.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(WRITEUP);
}

// --- Event endpoint ----------------------------------------------------------
// POST /e?page=<a|b>&event=<copy|outbound>&via=<split|direct>, or the same
// fields in a small body (urlencoded or JSON). A missing via defaults to
// 'split' (lines from trackers that predate the marker belong to the split,
// matching how legacy three-field log lines are read); a present but invalid
// via is rejected. Anything else invalid is rejected and never logged.
// A split event from a visitor whose cookie is a or b is that visitor's first
// action: it is logged 'first' and the response moves the cookie to a1 or b1.
// Every other event (cookie a1/b1, no valid cookie, or a direct event) is
// logged 'repeat' and the response is cookie-free. Nothing here ever blocks
// the visitor: the response is written immediately after validation and the
// log append stays fire-and-forget, so sendBeacon/keepalive sends still work.
const EVENT_BODY_LIMIT = 256;
const EVENT_PAGES = new Set(['a', 'b']);
const EVENT_KINDS = new Set(['copy', 'outbound']);
const EVENT_VIAS = new Set(['split', 'direct']);

function endEvent(res, status, setCookie) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status !== 204) headers['Content-Length'] = 0;
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(status, headers);
  res.end();
}

function parseEventBody(body) {
  const text = body.toString('utf8').trim();
  if (!text) return {};
  if (text[0] === '{') {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        return { page: obj.page, event: obj.event, via: obj.via };
      }
    } catch (err) {
      return {};
    }
    return {};
  }
  try {
    const params = new URLSearchParams(text);
    return {
      page: params.get('page'),
      event: params.get('event'),
      via: params.get('via'),
    };
  } catch (err) {
    return {};
  }
}

function handleEvent(req, res, query) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > EVENT_BODY_LIMIT) {
    endEvent(res, 413);
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > EVENT_BODY_LIMIT) {
      finished = true;
      endEvent(res, 413);
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    finished = true;
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    const fromBody = parseEventBody(Buffer.concat(chunks));
    const page = query.get('page') !== null ? query.get('page') : fromBody.page;
    const event = query.get('event') !== null ? query.get('event') : fromBody.event;
    const rawVia = query.get('via') !== null ? query.get('via') : fromBody.via;
    const via = rawVia === null || rawVia === undefined ? 'split' : rawVia;
    if (!EVENT_PAGES.has(page) || !EVENT_KINDS.has(event) || !EVENT_VIAS.has(via)) {
      return endEvent(res, 400);
    }
    // First or repeat is decided by the cookie alone: a split event from a
    // visitor still on a/b is their first action, and the response advances
    // the cookie to a1/b1. Direct events never touch the cookie.
    const state = cookieState(req);
    let novelty = 'repeat';
    let setCookie = null;
    if (via !== 'direct' && state && !state.acted) {
      novelty = 'first';
      setCookie = splitCookie(state.page + '1');
    }
    // Log the canonical literals, never the raw input.
    logEvent(
      page === 'a' ? 'a' : 'b',
      event === 'copy' ? 'copy' : 'outbound',
      via === 'direct' ? 'direct' : 'split',
      novelty === 'first' ? 'first' : 'repeat'
    );
    endEvent(res, 204, setCookie);
  });
}

function serveAsset(req, res, asset) {
  const total = asset.body.length;
  const base = {
    'Content-Type': asset.type,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start;
      let end;
      if (m[1] === '') {
        const suffix = Number(m[2]);
        if (suffix === 0) return send416(res, req, total);
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (start >= total || start > end) return send416(res, req, total);
      const chunk = asset.body.subarray(start, end + 1);
      res.writeHead(206, Object.assign({}, base, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Content-Length': chunk.length,
      }));
      if (req.method === 'HEAD') return res.end();
      return res.end(chunk);
    }
    // A malformed Range header falls through to a full 200 response.
  }
  res.writeHead(200, Object.assign({}, base, { 'Content-Length': total }));
  if (req.method === 'HEAD') return res.end();
  res.end(asset.body);
}

function send416(res, req, total) {
  res.writeHead(416, {
    'Content-Range': 'bytes */' + total,
    'Content-Length': 0,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

function methodNotAllowed(req, res, allow) {
  const body = 'Method Not Allowed\n';
  res.writeHead(405, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Allow': allow,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function notFound(req, res) {
  const body = 'Not Found\n';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

// --- Router -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  let parsed;
  let pathname;
  try {
    parsed = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(parsed.pathname);
  } catch (err) {
    return notFound(req, res);
  }

  if (pathname === '/e') {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    return handleEvent(req, res, parsed.searchParams);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(req, res, 'GET, HEAD');
  }

  // Crawlers are left out of the comparison: still served a page (A or B at
  // random at /), never given a cookie, and logged with reach 'bot'.
  const crawler = isCrawler(req);

  if (pathname === '/') {
    if (crawler) {
      const page = crypto.randomInt(2) === 0 ? 'a' : 'b';
      return serveHtml(req, res, page, false, 'split', 'bot', 'repeat');
    }
    const state = cookieState(req);
    if (state) {
      return serveHtml(req, res, state.page, false, 'split', 'split', 'repeat');
    }
    const page = crypto.randomInt(2) === 0 ? 'a' : 'b';
    return serveHtml(req, res, page, true, 'split', 'split', 'first');
  }

  if (pathname === '/a' || pathname === '/b') {
    res.writeHead(301, { Location: pathname + '/', 'Content-Length': 0 });
    return res.end();
  }

  if (pathname === '/a/' || pathname === '/b/') {
    const page = pathname === '/a/' ? 'a' : 'b';
    const reach = crawler ? 'bot' : 'direct';
    return serveHtml(req, res, page, false, 'direct', reach, 'repeat');
  }

  if (pathname === '/how-it-was-tested') {
    res.writeHead(301, { Location: '/how-it-was-tested/', 'Content-Length': 0 });
    return res.end();
  }
  if (pathname === '/how-it-was-tested/') return serveWriteup(req, res);

  const asset = ASSETS[pathname];
  if (asset) return serveAsset(req, res, asset);

  return notFound(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('turkeycode site listening on ' + HOST + ':' + PORT);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
