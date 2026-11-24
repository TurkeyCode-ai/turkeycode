/**
 * Screenshots that cannot be trusted as evidence about the code.
 *
 * Seen on a client front end once visual QA could sign in: the review failed a
 * phase three times over (a) a capture named "workflows" that had landed on
 * the Contacts page, and (b) a Library page covered in "Failed to load" toasts
 * because the local backend had no data for it. Neither is something a fix
 * session can change in the project being built, so neither may gate a phase.
 *
 * The capture step writes a manifest (capture-N.json) saying, for each file,
 * which route it asked for, where the browser ended up, and how many backend
 * errors it saw while the page loaded. Everything here is pure so the rules
 * can be tested without a browser.
 */

export interface CaptureRecord {
  file: string;
  /** The route the capture asked for, e.g. "/workflows". */
  route?: string;
  /** Where the browser was when the screenshot was taken. */
  finalUrl?: string;
  /** Responses with status >= 500, plus failed fetch/XHR requests, while loading. */
  serverErrors?: number;
}

/** Parse a capture manifest; anything unreadable is an empty list. */
export function parseCaptureManifest(json: string | null): CaptureRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.captures) ? parsed.captures : [];
    return list.filter(
      (r: unknown): r is CaptureRecord => !!r && typeof (r as CaptureRecord).file === 'string'
    );
  } catch {
    return [];
  }
}

/** Path a route or URL points at, without origin, query or trailing slash. A "#/x" route keeps its hash. */
export function pagePath(routeOrUrl: string | undefined): string | null {
  if (!routeOrUrl) return null;
  let path = routeOrUrl.trim();
  const hashRoute = /#\//.test(path);
  try {
    const url = new URL(path, 'http://x');
    path = url.pathname + (hashRoute ? url.hash : '');
  } catch {
    path = path.replace(/[?#].*$/, '');
  }
  path = path.replace(/\/+$/, '');
  return (path || '/').toLowerCase();
}

export interface CaptureProblemOptions {
  /** The backend is not part of the project being built (a front-end-only build). */
  backendIsOutside?: boolean;
}

/**
 * file -> why its screenshot says nothing about the code.
 *
 * - It landed on another capture's page: the browser ended somewhere other
 *   than the route asked for, and that somewhere is a page another capture
 *   asked for on purpose. (A plain redirect to a page nobody asked for is left
 *   alone: the redirect itself may be the defect.)
 * - The backend failed while it loaded, on a build that does not include the
 *   backend. On a full-stack build a 500 may be the very bug, so it still gates.
 */
export function findCaptureProblems(
  records: CaptureRecord[],
  options: CaptureProblemOptions = {}
): Record<string, string> {
  const problems: Record<string, string> = {};
  const wanted = new Set(records.map(r => pagePath(r.route)).filter((p): p is string => !!p));
  for (const record of records) {
    const asked = pagePath(record.route);
    const landed = pagePath(record.finalUrl);
    if (asked && landed && asked !== landed && wanted.has(landed)) {
      problems[record.file] = `the capture asked for ${asked} but landed on ${landed}`;
      continue;
    }
    if (options.backendIsOutside && (record.serverErrors ?? 0) > 0) {
      problems[record.file] =
        `the backend failed ${record.serverErrors} time(s) while this page loaded, and the backend is not part of this build`;
    }
  }
  return problems;
}

/** Captured files a finding names, in its location or its description. */
export function filesNamedIn(
  finding: { description?: string; location?: string },
  capturedFiles: string[]
): string[] {
  const text = `${finding.location || ''} ${finding.description || ''}`;
  return capturedFiles.filter(file => {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_-])`).test(text);
  });
}

/**
 * Why a finding rests only on untrustworthy screenshots, or null when it does
 * not. A finding that names no file, or names at least one sound file, stands.
 */
export function captureProblemFor(
  finding: { description?: string; location?: string },
  capturedFiles: string[],
  problems: Record<string, string>
): string | null {
  const named = filesNamedIn(finding, capturedFiles);
  if (named.length === 0) return null;
  if (!named.every(file => problems[file])) return null;
  return problems[named[0]];
}
