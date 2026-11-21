/* turkeycode site tracker: counts Copy clicks and outbound link follows.
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

  function send(event) {
    var url = '/e?page=' + page + '&event=' + event;
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
    if (href && isCountedOutbound(href)) send('outbound');
  }

  doc.addEventListener('click', handle, true);
  doc.addEventListener('auxclick', handle, true);
})();
