# turkeycode.ai landing site (A/B split)

A zero-dependency Node.js server that serves two variants of the turkeycode.ai
landing page, splits first-time visitors 50/50 with a single cookie, and counts
views, Copy-button clicks and outbound link follows in a plain text log. No
analytics service, no database, no client storage.

## Routes

| Route | What it serves |
| --- | --- |
| `/` | Page A or page B, picked once per visitor via the `tc_ab` cookie |
| `/a/` | Page A directly (no cookie read or set) |
| `/b/` | Page B directly (no cookie read or set) |
| `/t.js` | The tracker script |
| `POST /e` | The event endpoint (copy and outbound beacons) |
| `/how-it-was-tested/` | The testing write-up, served to everyone the same; visits are not counted (no cookie, no event log line) |

Video and poster assets are served under `/a/`, `/b/` and at the root, with
HTTP Range support.

## Build and run with Docker

```sh
docker build -t turkeycode-site .

# Default port 3000, log persisted to a host directory:
docker run -d --name turkeycode-site \
  -p 3000:3000 \
  -v "$PWD/data":/data \
  turkeycode-site

# Custom port via -e PORT:
docker run -d --name turkeycode-site \
  -e PORT=8080 \
  -p 8080:8080 \
  -v "$PWD/data":/data \
  turkeycode-site
```

The container runs as the non-root `node` user and exits promptly on
`docker stop` (the server handles SIGTERM). `/data` is declared as a volume;
mount a host directory or a named volume there so the event log survives
container restarts:

```sh
docker volume create tcdata
docker run -d --name turkeycode-site -p 3000:3000 -v tcdata:/data turkeycode-site
```

A named volume picks up the right ownership automatically. If you bind mount
a host directory instead, it must be writable by uid 1000 (the `node` user),
for example `chown 1000 data` or `chmod 777 data`; otherwise events are
silently dropped (serving never fails because of logging).

Without Docker: `PORT=3000 LOG_FILE=./events.log node server.js`.

## Event log

Events are appended to `$LOG_FILE` (default `/data/events.log`), one line per
event, built only from server-side whitelisted values:

```
<ISO-8601 UTC timestamp> <a|b> <view|copy|outbound> <split|direct|bot> <first|repeat>
```

For example:

```
2026-11-21T20:50:22.609Z a view split first
2026-11-21T20:50:22.634Z b copy direct repeat
2026-11-21T20:50:22.667Z a outbound split repeat
2026-11-21T20:50:22.702Z b view bot repeat
```

- `view` is logged by the server whenever an HTML page is served.
- `copy` is sent by the tracker when any Copy button is pressed
  (`#copy` on page A, the `data-copy` buttons on page B).
- `outbound` is sent by the tracker when a counted outbound link is followed
  (left or middle click).

The fourth field records how the page was reached: `split` for a page served
at `/` (the A/B split), `direct` for a page served at `/a/` or `/b/`, and
`bot` for a view by a known crawler (see below). The server decides it at
serve time and injects it as a `data-via` attribute on the tracker script
tag, so a visitor cannot get it wrong; the tracker echoes it back with `copy`
and `outbound` events. `POST /e` accepts only the literals `split` and
`direct` for `via`; a request with any other value is rejected, and a request
with no `via` at all (a tracker from before the marker existed) is counted as
`split`. Legacy three-field lines (written before the fourth field existed)
and legacy four-field lines (written before the fifth field existed) carry no
`first|repeat` field, so `stats.sh` leaves them out of the visitor figures
and reports their views on one labelled line (see Stats below).

The fifth field records whether the line is that visitor's first: a `view` at
`/` is `first` at the moment of assignment (no valid cookie yet), and a
`copy` or `outbound` event is `first` only when it is the first action of any
kind by that visitor. The single `tc_ab` cookie carries the state: `a` or `b`
means assigned with no event logged yet, `a1` or `b1` means the first event
has been logged (the server advances the cookie on the response that logs
it). Any other cookie value is treated as no cookie at all. Direct and bot
lines are always `repeat`.

### Crawlers

Requests whose `User-Agent` is missing, empty, or contains a known crawler
token (`Googlebot`, `bingbot`, `curl`, `Wget`, and friends, plus anything
containing `bot`, `crawler` or `spider`, all case-insensitive) are still
served a page (A or B at random at `/`) but never get a cookie, and their
views are logged with reach `bot`, keeping them out of the A/B comparison.
The list lives in one place in `server.js` (`CRAWLER_TOKENS`). The
`User-Agent` value itself is never logged or printed.

### What counts as outbound

Only these targets are counted:

- `https://github.com/TurkeyCode-ai/turkeycode`, including sub-paths and
  fragments such as `#readme`, `#quick-start` and `/issues`.
- `https://www.npmjs.com/package/turkeycode`.

The org page `https://github.com/TurkeyCode-ai` and `https://turkeycode.ai`
are deliberately NOT counted. The source material was ambiguous about whether
the bare org link should count as a GitHub outbound click; we resolved it by
counting only the repository itself (and its sub-paths), since the measurement
goal is interest in the product, not the org profile.

## Stats

`stats.sh` is POSIX sh + awk and runs on macOS and in the Alpine container.
It has two forms:

```sh
# Per page visitors, actions and reference counts:
sh stats.sh [logfile]

# One row per UTC day, plus a totals row:
sh stats.sh --daily [logfile]

# Inside the running container:
docker exec turkeycode-site sh /app/stats.sh
docker exec turkeycode-site sh /app/stats.sh --daily
```

The log path is the first non-flag argument (in either position), else
`$LOG_FILE`, else `/data/events.log`. A missing or empty log prints zeros;
malformed lines are ignored.

The comparison is computed from five-field `split` lines only, so only
visitors who were randomly assigned a page at `/` are compared. Per page:

- visitors: the number of `view split first` lines, which is the number of
  people assigned to that page.
- acted: the number of `first` split `copy` or `outbound` lines, which is
  the number of those visitors whose first action has been logged.
- conversion: acted / visitors as a percentage with one decimal (0.0% when
  there are no visitors).

Under that, per page, the total split `copy` and `outbound` event counts are
printed for reference; a visitor who copies three times appears three times
there but only once in acted. Then one line per page reports `direct` views
(pages opened at `/a/` or `/b/`) and one line per page reports `bot` views,
each labelled as not part of the comparison. Legacy three- and four-field
lines, written before visitor counting began, are left out of all of the
figures above; their views are reported on the final labelled line:

```
Visitors per page from split lines; acted = first copy or outbound; conversion = acted / visitors
page a:  visitors=      2  acted=      1  conversion=  50.0%
page b:  visitors=      2  acted=      1  conversion=  50.0%
page a:  copies=        2  outbound=   0  (split event totals, for reference)
page b:  copies=        0  outbound=   1  (split event totals, for reference)
page a:  direct views=  0  (not part of the comparison)
page b:  direct views=  1  (not part of the comparison)
page a:  bot views=     1  (not part of the comparison)
page b:  bot views=     1  (not part of the comparison)
views logged before visitor counting began: 3
```

`--daily` prints one row per UTC calendar day (taken from the timestamp date)
that has any split line, oldest first, with visitors, acted and conversion
for each page, and a final `total` row that matches the plain report:

```
Split visitors per UTC day; acted = first copy or outbound; the total row matches plain stats.sh
day           a visitors  a acted  a conv  b visitors  b acted  b conv
2026-11-20             1        1  100.0%           1        0    0.0%
2026-11-21             1        0    0.0%           1        1  100.0%
total                  2        1   50.0%           2        1   50.0%
```

### What the counting cannot do

The counting rests on one cookie and on the User-Agent header, so two things
must be said plainly: a visitor who blocks cookies is counted as new on every
visit, and a crawler that pretends to be a browser is counted as a visitor.

## How page A is instrumented

`site/a/index.html` must stay byte-identical to the original site
(`reference/current-site/index.html`), so the tracker is injected at serve
time only: the server inserts one tag,
`<script src="/t.js" data-page="a" data-via="split|direct"></script>`, just
before `</body>` when it serves `/` (variant A) and `/a/`. The file on disk
is never modified. Page B includes `<script src="/t.js"></script>` in its own
file and carries a `data-page="b"` marker on `<body>`; the server rewrites
that one script tag at serve time to add the same `data-via` attribute. All
four variants (split and direct, for A and B) are prebuilt buffers created at
startup; no request does any string work.

The tracker uses `navigator.sendBeacon` with a `fetch(..., {keepalive: true})`
fallback. It never awaits the send, swallows all errors, and never prevents
the default action, so copying and navigation work even when `/e` is blocked
or failing. It sets no cookies and uses no storage APIs.

## A note on "up to 3 QA attempts per phase"

Page B says each phase gets up to 3 QA attempts. The TurkeyCode source
contains a conflicting constant, `MAX_QA_ATTEMPTS = 5`, but it is only used by
a code path the default run never takes; the default phase loop calls the fast
QA runner, which caps at 3 attempts. The page states 3 because that is what
actually happens on the default run path.

## Tests

```sh
npm test
```

Runs the `node --test` suite (built-in runner and assertions, zero
dependencies). The tests start the server on a random free port with a
temporary log file and cover the A/B split flows, the copy and outbound event
flows, crawler detection and first/repeat marking, input validation on `/e`
(bad values, oversized bodies, newline injection), byte-identity of page A,
and `stats.sh` output in both forms against fixture logs (`test/stats.test.js`).
