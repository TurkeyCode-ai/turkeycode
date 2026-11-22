'use strict';

// The exact phase-2 additions to the three pages: the services block, its
// CSS and the Professional services footer links. Tests subtract these from
// the files on disk to prove nothing else changed since the stored fixtures
// (reference/current-site/index.html for page A, b-before-services.html and
// writeup-before-services.html in this directory for page B and the
// write-up).

const SERVICES_CSS =
  '  .services-cta { border-top: var(--edge); background: var(--paper); padding: 26px 0; }\n' +
  '  .services-cta h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: 0.04em; }\n' +
  '  .services-cta p { margin: 0; font-size: 16px; max-width: 640px; }\n' +
  '  .services-cta p + p { margin-top: 10px; }\n' +
  '  .services-cta a { font-weight: 700; text-underline-offset: 3px; }\n' +
  '  .services-cta a:hover, .services-cta a:focus-visible { color: var(--rust); }\n' +
  '\n';

const SERVICES_BLOCK =
  '<section class="services-cta">\n' +
  '  <div class="wrap">\n' +
  '    <h2>Want it built for you?</h2>\n' +
  "    <p>TurkeyCode's maker takes on client builds.</p>\n" +
  '    <p><a href="/contact/">Get in touch</a></p>\n' +
  '  </div>\n' +
  '</section>\n' +
  '\n';

const FOOTER_LINK_A =
  ' &nbsp;/&nbsp; <a href="/contact/">Professional services</a>';
const FOOTER_LINK_B =
  '    <p><a href="/contact/">Professional services</a></p>\n';
const FOOTER_LINK_WRITEUP =
  ' · <a href="/contact/">Professional services</a>';

// The SDD-phase additions: one About SDD footer link per page, after the
// Professional services link, with the anchor itself identical everywhere.
const FOOTER_LINK_SDD_A =
  ' &nbsp;/&nbsp; <a href="/sdd/">About SDD</a>';
const FOOTER_LINK_SDD_B =
  '    <p><a href="/sdd/">About SDD</a></p>\n';
const FOOTER_LINK_SDD_WRITEUP =
  ' · <a href="/sdd/">About SDD</a>';

// Remove each chunk from html, throwing unless it appears exactly once.
function strip(html, chunks) {
  for (const chunk of chunks) {
    const first = html.indexOf(chunk);
    if (first === -1) {
      throw new Error('chunk missing: ' + JSON.stringify(chunk.slice(0, 60)));
    }
    if (html.indexOf(chunk, first + 1) !== -1) {
      throw new Error('chunk not unique: ' + JSON.stringify(chunk.slice(0, 60)));
    }
    html = html.slice(0, first) + html.slice(first + chunk.length);
  }
  return html;
}

module.exports = {
  SERVICES_CSS,
  SERVICES_BLOCK,
  FOOTER_LINK_A,
  FOOTER_LINK_B,
  FOOTER_LINK_WRITEUP,
  FOOTER_LINK_SDD_A,
  FOOTER_LINK_SDD_B,
  FOOTER_LINK_SDD_WRITEUP,
  strip,
};
