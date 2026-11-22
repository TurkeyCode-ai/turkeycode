'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const LOG_FILE = process.env.LOG_FILE || '/data/events.log';
const CONTACT_FILE = process.env.CONTACT_FILE || '/data/contact.jsonl';
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

// Page A's file on disk is the reference site plus the services block and
// the Professional services footer link; its tracker is injected here, at
// serve time only. Page B carries the script tag in its own file; only the
// data-via marker is injected into that tag.
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

// The contact pages are served the same to every visitor: no cookie is ever
// set or advanced, no Vary: Cookie, and no view line is logged.
const CONTACT_TEMPLATE = load('contact/index.html').toString('utf8');
const CONTACT_THANKS = load('contact/thanks/index.html');
const CONTACT_BUSY = load('contact/try-again.html');

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
try {
  fs.mkdirSync(path.dirname(CONTACT_FILE), { recursive: true });
} catch (err) {
  // If the directory cannot be created, appends will fail quietly; serving continues.
}

// page, event, via and novelty are always validated literals ('a'/'b'/'-',
// 'view'/'copy'/'outbound'/'services'/'enquiry', 'split'/'direct'/'bot'/'-',
// 'first'/'repeat'/'-') before this is called; no client-supplied text
// reaches the log.
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
// POST /e?page=<a|b>&event=<copy|outbound|services>&via=<split|direct>, or the
// same fields in a small body (urlencoded or JSON). A missing via defaults to
// 'split' (lines from trackers that predate the marker belong to the split,
// matching how legacy three-field log lines are read); a present but invalid
// via is rejected. Anything else invalid is rejected and never logged.
// A split event from a visitor whose cookie is a or b is that visitor's first
// action: it is logged 'first' and the response moves the cookie to a1 or b1.
// Every other event (cookie a1/b1, no valid cookie, or a direct event) is
// logged 'repeat' and the response is cookie-free. The one exception is
// 'services' (a contact link followed on page A or B): its first/repeat is
// judged from the cookie exactly as for copy and outbound, but the response
// NEVER sets or advances tc_ab, so a later copy or outbound is still that
// visitor's first action. Nothing here ever blocks the visitor: the response
// is written immediately after validation and the log append stays
// fire-and-forget, so sendBeacon/keepalive sends still work.
const EVENT_BODY_LIMIT = 256;
const EVENT_PAGES = new Set(['a', 'b']);
const EVENT_KINDS = new Set(['copy', 'outbound', 'services']);
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
    // the cookie to a1/b1. Direct events never touch the cookie, and a
    // services event never does either: it is judged first/repeat like copy
    // and outbound but must not use up the visitor's first action, so the
    // cookie stays on a/b and a later copy or outbound still logs 'first'.
    const state = cookieState(req);
    let novelty = 'repeat';
    let setCookie = null;
    if (via !== 'direct' && state && !state.acted) {
      novelty = 'first';
      if (event !== 'services') setCookie = splitCookie(state.page + '1');
    }
    // Log the canonical literals, never the raw input.
    logEvent(
      page === 'a' ? 'a' : 'b',
      event === 'copy' ? 'copy' : event === 'outbound' ? 'outbound' : 'services',
      via === 'direct' ? 'direct' : 'split',
      novelty === 'first' ? 'first' : 'repeat'
    );
    endEvent(res, 204, setCookie);
  });
}

// --- Contact page -------------------------------------------------------------
// GET /contact/ renders the form, POST /contact handles it, /contact/thanks/
// confirms. These responses never set a cookie, never send Vary: Cookie and
// never log a view; the only log line is a fixed-literal 'enquiry' event when
// a valid submission is saved. The CSP gains form-action 'self'.
const CONTACT_CSP = CSP + "; form-action 'self'";
const CONTACT_BODY_LIMIT = 20480;
const CONTACT_FIELDS = ['name', 'email', 'company', 'description', 'timeline'];

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Token replacement via split/join so a submitted '$&' can never be
// interpreted as a String.replace substitution pattern.
function fill(html, token, value) {
  return html.split(token).join(value);
}

function renderContact(values, errors) {
  let html = CONTACT_TEMPLATE;
  for (const f of CONTACT_FIELDS) {
    const token = f.toUpperCase();
    const err = errors[f];
    html = fill(html, '__' + token + '_VALUE__', values[f] ? escapeHtml(values[f]) : '');
    html = fill(
      html,
      '__' + token + '_ARIA__',
      err ? ' aria-describedby="err-' + f + '" aria-invalid="true"' : ''
    );
    html = fill(
      html,
      '__' + token + '_ERROR__',
      err ? '<p class="field-error" id="err-' + f + '">' + escapeHtml(err) + '</p>' : ''
    );
  }
  return Buffer.from(html);
}

const CONTACT_EMPTY = renderContact(
  { name: '', email: '', company: '', description: '', timeline: '' },
  {}
);

// A plausible address: exactly one @, a non-empty local part, a domain with a
// dot that is not its first or last character, and no whitespace anywhere.
function plausibleEmail(email) {
  if (/\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function validateContact(v) {
  const errors = {};
  if (!v.name) errors.name = 'Please enter your name.';
  else if (v.name.length > 200) errors.name = 'Please keep this under 200 characters.';
  if (!v.email) errors.email = 'Please enter an email address like name@example.com.';
  else if (v.email.length > 254) errors.email = 'Please keep this under 254 characters.';
  else if (!plausibleEmail(v.email)) {
    errors.email = 'Please enter an email address like name@example.com.';
  }
  if (v.company.length > 200) errors.company = 'Please keep this under 200 characters.';
  if (!v.description) errors.description = 'Please say what you want built.';
  else if (v.description.length > 5000) {
    errors.description = 'Please keep this under 5000 characters.';
  }
  if (v.timeline.length > 200) errors.timeline = 'Please keep this under 200 characters.';
  return Object.keys(errors).length ? errors : null;
}

// --- Contact rate limit ------------------------------------------------------
// In-memory sliding windows; only valid, non-honeypot submissions count, so a
// visitor fixing form errors is never locked out by their own retries. The
// address map lives only in this process, is pruned on every check, and is
// never written to disk or logged. X-Forwarded-For is deliberately not
// trusted; the socket's remote address is the identity.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_PER_ADDRESS = 3;
const RATE_GLOBAL = 20;
const rateByAddress = new Map();
const rateGlobal = [];

function pruneRate(arr, now) {
  while (arr.length && arr[0] <= now - RATE_WINDOW_MS) arr.shift();
}

function rateLimitAllows(addr, now = Date.now()) {
  pruneRate(rateGlobal, now);
  for (const [key, arr] of rateByAddress) {
    pruneRate(arr, now);
    if (!arr.length) rateByAddress.delete(key);
  }
  const mine = rateByAddress.get(addr);
  if (mine && mine.length >= RATE_PER_ADDRESS) return false;
  return rateGlobal.length < RATE_GLOBAL;
}

function rateLimitRecord(addr, now = Date.now()) {
  let arr = rateByAddress.get(addr);
  if (!arr) {
    arr = [];
    rateByAddress.set(addr, arr);
  }
  arr.push(now);
  rateGlobal.push(now);
}

// --- Contact storage ---------------------------------------------------------
// One JSON object per line, appended in call order on a promise chain (like
// logEvent). The file is opened append-only with mode 0600 and chmod'd on
// every append, so a file created earlier with a wider mode is tightened.
let contactChain = Promise.resolve();
function saveEnquiry(record) {
  const next = contactChain.then(async () => {
    const line = JSON.stringify(record) + '\n';
    const handle = await fs.promises.open(CONTACT_FILE, 'a', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(line, 'utf8');
    } finally {
      await handle.close();
    }
  });
  contactChain = next.catch(() => {});
  return next;
}

// --- SendGrid ------------------------------------------------------------------
// One request per saved enquiry, only when all three env vars are non-empty.
// The key and addresses are read from process.env at request time and are
// never written to disk or logged; on failure exactly one fixed console line
// carries the status and nothing else.
async function sendEnquiryEmail(v) {
  const key = process.env.SENDGRID_API_KEY;
  const to = process.env.CONTACT_TO;
  const from = process.env.CONTACT_FROM;
  if (!key || !to || !from) return false;
  const url = process.env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send';
  // Control characters (CR, LF and friends) are removed so the name can never
  // inject headers or break the subject across lines.
  const subject = ('TurkeyCode enquiry from ' + v.name).replace(/[\u0000-\u001f\u007f]/g, '');
  const text =
    'Name: ' + v.name + '\n' +
    'Email: ' + v.email + '\n' +
    'Company: ' + (v.company || '-') + '\n' +
    'Timeline: ' + (v.timeline || '-') + '\n' +
    '\nWhat they want built:\n' + v.description + '\n';
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from },
    reply_to: { email: v.email },
    subject,
    content: [{ type: 'text/plain', value: text }],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 200 && res.status < 300) return true;
    console.log('contact: email failed, status ' + res.status);
    return false;
  } catch (err) {
    console.log('contact: email failed, status network-error');
    return false;
  }
}

// --- Contact responses ---------------------------------------------------------
function serveContactHtml(req, res, body, status) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CONTACT_CSP,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function redirectThanks(res) {
  res.writeHead(303, {
    'Location': '/contact/thanks/',
    'Content-Length': 0,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function contactTooLarge(res) {
  const body = 'Payload Too Large\n';
  res.writeHead(413, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleContactPost(req, res) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > CONTACT_BODY_LIMIT) {
    contactTooLarge(res);
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > CONTACT_BODY_LIMIT) {
      finished = true;
      contactTooLarge(res);
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
    let params;
    try {
      params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      params = new URLSearchParams('');
    }
    const field = (name) => (params.get(name) || '').trim();
    const values = {
      name: field('name'),
      email: field('email'),
      company: field('company'),
      description: field('description'),
      timeline: field('timeline'),
    };
    // Honeypot: people never see the field, so anything in it is a bot.
    // Answer exactly like a success and save, email and log nothing.
    if (field('website')) return redirectThanks(res);
    const errors = validateContact(values);
    if (errors) return serveContactHtml(req, res, renderContact(values, errors), 200);
    const addr = req.socket.remoteAddress || '-';
    if (!rateLimitAllows(addr)) return serveContactHtml(req, res, CONTACT_BUSY, 429);
    rateLimitRecord(addr);
    // The page attribution is read from the cookie but the cookie is never
    // set or advanced here, and nothing from the form reaches the log.
    const state = cookieState(req);
    const page = state ? state.page : '-';
    (async () => {
      const emailSent = await sendEnquiryEmail(values);
      try {
        await saveEnquiry({
          time: new Date().toISOString(),
          name: values.name,
          email: values.email,
          company: values.company,
          description: values.description,
          timeline: values.timeline,
          emailSent,
        });
      } catch (err) {
        // The visitor is thanked even if the disk write failed.
      }
      logEvent(page, 'enquiry', '-', '-');
      redirectThanks(res);
    })();
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

  // Contact routes come before the global GET/HEAD check: POST /contact is
  // the form handler (the form's action), everything else redirects or 405s.
  if (pathname === '/contact') {
    if (req.method === 'POST') return handleContactPost(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(301, { Location: '/contact/', 'Content-Length': 0 });
      return res.end();
    }
    return methodNotAllowed(req, res, 'GET, HEAD, POST');
  }
  if (pathname === '/contact/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req, res, 'GET, HEAD');
    }
    return serveContactHtml(req, res, CONTACT_EMPTY, 200);
  }
  if (pathname === '/contact/thanks') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req, res, 'GET, HEAD');
    }
    res.writeHead(301, { Location: '/contact/thanks/', 'Content-Length': 0 });
    return res.end();
  }
  if (pathname === '/contact/thanks/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req, res, 'GET, HEAD');
    }
    return serveContactHtml(req, res, CONTACT_THANKS, 200);
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

// When run directly (the only way it is deployed) the server listens; when
// required, the rate limiter internals are exposed for unit-level checks
// (the global cap cannot be exercised over loopback, where every request
// shares one address and the per-address cap fires first).
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('turkeycode site listening on ' + HOST + ':' + PORT);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  rateLimitAllows,
  rateLimitRecord,
  RATE_PER_ADDRESS,
  RATE_GLOBAL,
  RATE_WINDOW_MS,
};
