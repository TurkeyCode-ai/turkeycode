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
// tag in its own file, so it is served as-is.
const TRACKER = load('t.js');

function withTracker(html, page) {
  const tag = Buffer.from('<script src="/t.js" data-page="' + page + '"></script>\n');
  const marker = Buffer.from('</body>');
  const idx = html.lastIndexOf(marker);
  if (idx === -1) return Buffer.concat([html, tag]);
  return Buffer.concat([html.subarray(0, idx), tag, html.subarray(idx)]);
}

const SERVED = {
  a: withTracker(PAGES.a, 'a'),
  b: PAGES.b,
};

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

// page and event are always validated literals ('a'/'b', 'view'/'copy'/
// 'outbound') before this is called; no client-supplied text reaches the log.
function logEvent(page, event) {
  const line = new Date().toISOString() + ' ' + page + ' ' + event + '\n';
  fs.appendFile(LOG_FILE, line, () => {});
}

// --- Cookie handling --------------------------------------------------------
function assignedPage(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      if (value === 'a' || value === 'b') return value;
      return null; // invalid value: treat as unassigned
    }
  }
  return null;
}

function splitCookie(page) {
  return (
    COOKIE_NAME + '=' + page +
    '; Max-Age=' + COOKIE_MAX_AGE +
    '; Path=/; SameSite=Lax; HttpOnly'
  );
}

// --- Responses --------------------------------------------------------------
function serveHtml(req, res, page, setCookie) {
  const body = SERVED[page];
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
  if (!req.headers.range) logEvent(page, 'view');
}

// --- Event endpoint ----------------------------------------------------------
// POST /e?page=<a|b>&event=<copy|outbound>, or the same pair in a small body
// (urlencoded or JSON). Anything else is rejected and never logged. The
// response is always cookie-free.
const EVENT_BODY_LIMIT = 256;
const EVENT_PAGES = new Set(['a', 'b']);
const EVENT_KINDS = new Set(['copy', 'outbound']);

function endEvent(res, status) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status !== 204) headers['Content-Length'] = 0;
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
        return { page: obj.page, event: obj.event };
      }
    } catch (err) {
      return {};
    }
    return {};
  }
  try {
    const params = new URLSearchParams(text);
    return { page: params.get('page'), event: params.get('event') };
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
    if (!EVENT_PAGES.has(page) || !EVENT_KINDS.has(event)) {
      return endEvent(res, 400);
    }
    // Log the canonical literals, never the raw input.
    logEvent(page === 'a' ? 'a' : 'b', event === 'copy' ? 'copy' : 'outbound');
    endEvent(res, 204);
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

  if (pathname === '/') {
    let page = assignedPage(req);
    let setCookie = false;
    if (!page) {
      page = crypto.randomInt(2) === 0 ? 'a' : 'b';
      setCookie = true;
    }
    return serveHtml(req, res, page, setCookie);
  }

  if (pathname === '/a' || pathname === '/b') {
    res.writeHead(301, { Location: pathname + '/', 'Content-Length': 0 });
    return res.end();
  }

  if (pathname === '/a/') return serveHtml(req, res, 'a', false);
  if (pathname === '/b/') return serveHtml(req, res, 'b', false);

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
