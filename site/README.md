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
<ISO-8601 UTC timestamp> <a|b> <view|copy|outbound> <split|direct>
```

For example:

```
2026-11-21T20:50:22.609Z a view split
2026-11-21T20:50:22.634Z b copy direct
2026-11-21T20:50:22.667Z a outbound split
```

- `view` is logged by the server whenever an HTML page is served.
- `copy` is sent by the tracker when any Copy button is pressed
  (`#copy` on page A, the `data-copy` buttons on page B).
- `outbound` is sent by the tracker when a counted outbound link is followed
  (left or middle click).

The fourth field records how the page was reached: `split` for a page served
at `/` (the A/B split), `direct` for a page served at `/a/` or `/b/`. The
server decides it at serve time and injects it as a `data-via` attribute on
the tracker script tag, so a visitor cannot get it wrong; the tracker echoes
it back with `copy` and `outbound` events. `POST /e` accepts only the
literals `split` and `direct` for `via`; a request with any other value is
rejected, and a request with no `via` at all (a tracker from before the
marker existed) is counted as `split`, matching how legacy log lines are
read. Legacy three-field lines (written before the fourth field existed) are
read as `split` by `stats.sh`.

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
The log path comes from the first argument, else `$LOG_FILE`, else
`/data/events.log`. A missing or empty log prints zeros; malformed lines are
ignored.

```sh
# On the host:
sh stats.sh ./data/events.log

# Inside the running container:
docker exec turkeycode-site sh /app/stats.sh
```

The A/B comparison is computed from `split` lines only, so only visitors who
were randomly assigned a page at `/` are compared. Legacy three-field lines
count as `split`. Output, per page: views, copies, outbound, and engagement
share, which is (copies + outbound) / views as a percentage with one decimal
(0.0% when there are no views). After the comparison, one line per page
reports the number of `direct` views (pages opened at `/a/` or `/b/`),
labelled as not part of the comparison:

```
page a: views=12 copies=3 outbound=2 engagement=41.7%
page b: views=14 copies=5 outbound=1 engagement=42.9%
page a: direct views=4 (not part of the comparison)
page b: direct views=7 (not part of the comparison)
```

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
flows, input validation on `/e` (bad values, oversized bodies, newline
injection), byte-identity of page A, and `stats.sh` output.
