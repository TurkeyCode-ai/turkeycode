/* turkeycode site tracker: counts Copy clicks, outbound link follows and
   contact link follows (the 'services' event).
   No cookies, no storage, never blocks or cancels the user's action. */
(function () {
  'use strict';

  var doc = document;

  var page = null;
  if (doc.documentElement && doc.documentElement.getAttribute('data-page')) {
    page = doc.documentElement.getAttribute('data-page');
  }
  if (!page && doc.body && doc.body.getAttribute('data-page')) {
    page = doc.body.getAttribute('data-page');
  }
  if (!page && doc.currentScript && doc.currentScript.getAttribute('data-page')) {
    page = doc.currentScript.getAttribute('data-page');
  }
  if (page !== 'a' && page !== 'b') return;

  /* How the page was reached ('split' for /, 'direct' for /a/ and /b/) is
     decided by the server and injected on this script tag as data-via. If
     the marker is somehow missing, the event is sent without it and the
     server counts it as split. */
  var via = null;
  if (doc.currentScript && doc.currentScript.getAttribute('data-via')) {
    via = doc.currentScript.getAttribute('data-via');
  }
  if (!via) {
    var tags = doc.querySelectorAll('script[data-via]');
    if (tags.length) via = tags[0].getAttribute('data-via');
  }
  if (via !== 'split' && via !== 'direct') via = null;

  function send(event) {
    var url = '/e?page=' + page + '&event=' + event + (via ? '&via=' + via : '');
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch (err) { /* fall through to fetch */ }
    try {
      fetch(url, { method: 'POST', keepalive: true, credentials: 'omit' })
        .catch(function () {});
    } catch (err) { /* counting must never break the page */ }
  }

  function copyButton(node) {
    while (node && node !== doc) {
      if (node.nodeType === 1 && node.tagName === 'BUTTON' &&
          (node.id === 'copy' || node.hasAttribute('data-copy'))) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function anchorHref(node) {
    while (node && node !== doc) {
      if (node.nodeType === 1 && node.tagName === 'A' &&
          node.getAttribute('href')) {
        return node.href;
      }
      node = node.parentNode;
    }
    return null;
  }

  /* Counted outbound targets:
     - https://github.com/TurkeyCode-ai/turkeycode and any sub-path or fragment
     - https://www.npmjs.com/package/turkeycode
     Explicitly NOT counted: the org page github.com/TurkeyCode-ai and
     turkeycode.ai itself. */
  function isCountedOutbound(href) {
    var u;
    try {
      u = new URL(href, doc.baseURI);
    } catch (err) {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'github.com') {
      var p = u.pathname.replace(/\/+$/, '');
      return p === '/TurkeyCode-ai/turkeycode' ||
        p.indexOf('/TurkeyCode-ai/turkeycode/') === 0;
    }
    if (u.hostname === 'www.npmjs.com') {
      return u.pathname.replace(/\/+$/, '') === '/package/turkeycode';
    }
    return false;
  }

  /* A same-origin link to the contact page counts as a 'services' event.
     Only '/contact' and '/contact/' on this origin match; nothing else. */
  function isContactLink(href) {
    var u;
    try {
      u = new URL(href, doc.baseURI);
    } catch (err) {
      return false;
    }
    if (u.origin !== new URL(doc.baseURI).origin) return false;
    return u.pathname === '/contact' || u.pathname === '/contact/';
  }

  function handle(e) {
    /* One physical activation fires either click (primary button, keyboard)
       or auxclick (middle button), never both, so nothing double counts. */
    if (e.type === 'click' && typeof e.button === 'number' && e.button !== 0) return;
    if (e.type === 'auxclick' && e.button !== 1) return;

    if (e.type === 'click' && copyButton(e.target)) {
      send('copy');
      return;
    }
    var href = anchorHref(e.target);
    if (!href) return;
    if (isContactLink(href)) {
      send('services');
      return;
    }
    if (isCountedOutbound(href)) send('outbound');
  }

  doc.addEventListener('click', handle, true);
  doc.addEventListener('auxclick', handle, true);
})();
