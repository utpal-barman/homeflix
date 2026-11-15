/* HomeFlix TV app. ES5 only: runs on old Tizen / webOS / Android TV browsers,
   and adapts to phones and tablets (touch, narrow portrait screens). */
(function () {
  'use strict';
  var D = document, W = window, HTML = D.documentElement;
  var S = { lib: null, sig: '', tab: 'home', ov: null, dirty: false, imgs: [], rem: 16, reduce: false, touch: false, compact: false, col: {}, colNames: [], byId: {} };
  var KEY = { 37: 'l', 38: 'u', 39: 'r', 40: 'd', 13: 'ok', 8: 'back', 27: 'back', 461: 'back', 10009: 'back',
    415: 'play', 19: 'pause', 10252: 'pp', 32: 'pp', 413: 'stop', 417: 'ff', 412: 'rw' };
  var ICON = {
    play: 'M7 4v16l13-8z', pause: 'M6 4h4.5v16H6zM13.5 4H18v16h-4.5z',
    rw: 'M11.5 18V6L3 12zM21 18V6l-8.5 6z', ff: 'M12.5 6v12l8.5-6zM3 6v12l8.5-6z',
    re: 'M5 5h2.5v14H5zM9 12l10 7V5z', prev: 'M15.5 4l-8 8 8 8 1.6-1.6L10.7 12l6.4-6.4z', next: 'M8.5 4l8 8-8 8-1.6-1.6L13.3 12 6.9 5.6z',
    x: 'M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z'
  };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var cur = null, page, view, vid, dlg = null, G = null, B = null, pollT = 0, lazyT = 0, lateT = 0, cdT = 0, bbT = 0, rsT = 0, lastMove = 0, lastWheel = 0;
  var P = { on: false, it: null, target: null, sn: 0 };
  var V = { on: false, list: [], i: 0, top: 0, play: false, timer: 0, uiT: 0, n: 0 };

  /* ---------- small helpers ---------- */
  function $(id) { return D.getElementById(id); }
  function h(tag, cls, txt) {
    var e = D.createElement(tag);
    if (cls) { e.className = cls; }
    if (txt != null) { e.appendChild(D.createTextNode(txt)); }
    return e;
  }
  function hasC(e, c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  function addC(e, c) { if (!hasC(e, c)) { e.className = e.className ? e.className + ' ' + c : c; } }
  function rmC(e, c) { e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, ''); }
  function setC(e, c, on) { if (on) { addC(e, c); } else { rmC(e, c); } }
  function txt(e, s) { e.textContent = s; }
  function svg(name) { return '<svg viewBox="0 0 24 24"><path d="' + ICON[name] + '"/></svg>'; }
  function now() { return +new Date(); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(s) {
    s = Math.max(0, Math.floor(s || 0));
    var hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return (hh ? hh + ':' + pad(m) : m) + ':' + pad(s % 60);
  }
  function span(s) {
    var m = Math.round(s / 60);
    if (s < 60) { return Math.max(1, Math.round(s)) + ' sec'; }
    if (m < 60) { return m + ' min'; }
    return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  function bytes(n) {
    if (n >= 1073741824) { return (n / 1073741824).toFixed(1) + ' GB'; }
    if (n >= 1048576) { return Math.round(n / 1048576) + ' MB'; }
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function day(ms) { var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function contains(a, b) { while (b) { if (b === a) { return true; } b = b.parentNode; } return false; }
  function aspect(it) { return it.width && it.height ? Math.max(0.6, Math.min(2.2, it.width / it.height)) : 1.4; }
  /* thumb may or may not already carry a query (?v=mtime); w picks 480 / 960 / 1280 */
  function thumb(it, w) { var t = it.thumb; return w ? t + (t.indexOf('?') < 0 ? '?' : '&') + 'w=' + w : t; }

  function req(method, url, body, cb) {
    var x = new XMLHttpRequest(), done = false, t;
    function fin(err, res) { if (!done) { done = true; clearTimeout(t); if (cb) { cb(err, res); } } }
    try {
      x.open(method, url, true);
      x.onreadystatechange = function () {
        var r = null;
        if (x.readyState !== 4) { return; }
        if (x.status >= 200 && x.status < 300) {
          if (x.responseText && method === 'GET') { try { r = JSON.parse(x.responseText); } catch (e) { fin('bad'); return; } }
          fin(null, r);
        } else { fin(x.status || 'net'); }
      };
      t = setTimeout(function () { fin('timeout'); try { x.abort(); } catch (e) {} }, 10000);
      if (body) { x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(body)); } else { x.send(null); }
    } catch (e2) { fin('net'); }
  }

  /* ---------- focus and spatial navigation ----------
     A zone is an element whose direct children are the focusable (.f) items.
     _row zones are single lines with focus memory; others wrap like a grid.
     Exactly one element carries the focus class at any time: always go through focus() / drop(). */
  function isF(n) { return n && n.nodeType === 1 && hasC(n, 'f') && n.offsetWidth > 0; }
  function sib(n, fwd) { do { n = fwd ? n.nextSibling : n.previousSibling; } while (n && !isF(n)); return n; }
  function edge(z, last) { var n = last ? z.lastChild : z.firstChild; return isF(n) ? n : (n ? sib(n, !last) : null); }
  function scope() { return dlg ? $('dlg') : S.ov === 'player' ? $('player') : page; }
  function zones(sc) {
    var q = sc.querySelectorAll('.zone'), o = [], i;
    for (i = 0; i < q.length; i++) { if (q[i].offsetHeight > 0 && edge(q[i])) { o.push(q[i]); } }
    return o;
  }
  function cx(el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; }
  function inLine(start, fwd, x) {
    var top = start.offsetTop, n = start, best = null, bd = 1e9, d;
    while (n && (n.nodeType !== 1 || n.offsetTop === top)) {
      if (isF(n)) { d = Math.abs(n.offsetLeft + n.offsetWidth / 2 - x); if (d < bd) { bd = d; best = n; } }
      n = fwd ? n.nextSibling : n.previousSibling;
    }
    return best;
  }
  function tween(el, prop, to, jump) {
    var from = el[prop], t0 = now();
    to = Math.max(0, Math.round(to)); el._to = to;
    if (el._tw) { clearInterval(el._tw); el._tw = 0; }
    if (jump || S.reduce || Math.abs(to - from) < 2) { el[prop] = to; lazySoon(); return; }
    el._tw = setInterval(function () {
      var p = (now() - t0) / 220;
      if (p >= 1) { p = 1; clearInterval(el._tw); el._tw = 0; lazySoon(); }
      el[prop] = from + (to - from) * (1 - Math.pow(1 - p, 3));
    }, 16);
  }
  /* move an element with a transform; CSS supplies the transition, jump skips it */
  function slide(el, x, y, jump) {
    var v = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)', s = el.style;
    if (jump) { s.webkitTransition = s.transition = 'none'; }
    s.webkitTransform = v; s.transform = v;
    if (jump) { el.offsetWidth; s.webkitTransition = s.transition = ''; }
  }
  function reveal(el, jump) {
    var z = el.parentNode, H = page.clientHeight, t, st, p;
    if (z._home) {
      /* the row slides so the focused card sits in the fixed slot at the left margin,
         and the stack of rows slides so this row sits right under the billboard */
      slide(z, z.firstChild.offsetLeft - el.offsetLeft, 0, jump);
      p = sib(el, false);
      if (z._gone && z._gone !== p) { rmC(z._gone, 'gone'); }
      if (p) { addC(p, 'gone'); }
      z._gone = p;
      if (S.compact) {
        /* narrow screens: Home is a scrolling page, so bring the row into view instead of sliding the stack */
        t = z._idx ? z._sec.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - H * 0.3 : 0;
        tween(page, 'scrollTop', t, jump);
      } else { slide(z._rows, 0, -z._sec.offsetTop, jump); }
      clearTimeout(lateT); lateT = setTimeout(lazy, 320); lazySoon();
      return;
    }
    if (z._top) { tween(page, 'scrollTop', 0, jump); return; }
    if (z._bbz) { tween(page, 'scrollTop', 0, jump); return; }
    if (!z._grid) { return; }
    /* grids scroll only as far as needed to keep the focused tile inside a comfortable band */
    t = el.offsetTop; st = page._to != null ? page._to : page.scrollTop;
    if (t - st < 9 * S.rem) { st = t < 20 * S.rem ? 0 : t - 9 * S.rem; }
    else if (t + el.offsetHeight - st > H - 6 * S.rem) { st = t + el.offsetHeight - H + 6 * S.rem; }
    tween(page, 'scrollTop', st, jump);
  }
  function drop() { if (cur) { rmC(cur, 'focus'); } cur = null; }
  function focus(el, still, jump) {
    var z;
    if (!el) { return; }
    if (cur && cur !== el) { rmC(cur, 'focus'); }
    cur = el; addC(el, 'focus');
    z = el.parentNode; z._mem = el;
    if (el._cap) { txt($('pcap'), typeof el._cap === 'function' ? el._cap() : el._cap); }
    if (S.ov || dlg) { return; }
    setC(D.body, 'deep', !!z._home && z._idx > 0 && !S.compact);
    if (S.touch) { return; }
    if (z._home && el._it) { bbSet(el._it, el._list, jump); }
    if (!still) { reveal(el, jump); }
  }
  function enter(z, down, x) {
    var t;
    if (z._row) { t = (z._mem && z._mem.parentNode === z && isF(z._mem)) ? z._mem : edge(z); }
    else { t = inLine(edge(z, !down), down, x); }
    focus(t);
  }
  function move(a) {
    var z, n, zs, i, x, down = a === 'd';
    if (!cur || !contains(scope(), cur)) { drop(); focus(defFocus()); return; }
    z = cur.parentNode;
    if (a === 'l' || a === 'r') {
      n = sib(cur, a === 'r');
      if (n && (z._row || n.offsetTop === cur.offsetTop)) { focus(n); }
      return;
    }
    x = cx(cur);
    if (!z._row) {
      n = cur;
      while (n && (n.nodeType !== 1 || n.offsetTop === cur.offsetTop)) { n = down ? n.nextSibling : n.previousSibling; }
      if (n) { focus(inLine(n, down, x)); return; }
    }
    zs = zones(scope());
    for (i = 0; i < zs.length; i++) { if (zs[i] === z) { break; } }
    n = zs[i + (down ? 1 : -1)];
    if (!n && down && gridMore()) { move(a); return; }
    if (n) { enter(n, down, x); }
  }
  function activate(el) { if (el && el._act) { el._act(); } }
  /* where focus starts: the first card (or the only button on a state screen), else the billboard, else the tab */
  function defFocus() {
    var zs = zones(scope()), i, z, alt = null;
    for (i = 0; i < zs.length; i++) {
      z = zs[i];
      if (z.id === 'tabs') { continue; }
      if (z._bbz) { alt = alt || edge(z); continue; }
      return z._mem && z._mem.parentNode === z && isF(z._mem) ? z._mem : edge(z);
    }
    return alt || $('t-' + S.tab);
  }
  function snap() { return cur && contains(page, cur) ? { key: cur.parentNode._key, id: cur._id } : null; }
  function restore(s) {
    var zs = zones(page), i, n, t = null;
    for (i = 0; s && i < zs.length && !t; i++) {
      if (zs[i]._key === s.key) {
        for (n = zs[i].firstChild; n; n = n.nextSibling) { if (isF(n) && n._id === s.id) { t = n; break; } }
        t = t || edge(zs[i]);
      }
    }
    drop();
    focus(t || defFocus(), false, true);
  }

  /* ---------- input mode: decided by what the person actually uses ---------- */
  function setMode(touch) {
    var q, i;
    if (S.touch === touch) { return; }
    S.touch = touch;
    setC(HTML, 'touch', touch); setC(HTML, 'keys', !touch);
    vid.controls = touch;
    if (touch) { rmC(HTML, 'ptr'); clearTimeout(bbT); }
    else {
      q = view.querySelectorAll('.track');
      for (i = 0; i < q.length; i++) { q[i].scrollLeft = 0; }
      if (S.tab === 'home') { page.scrollTop = 0; }
      if (!S.ov && !dlg && S.lib) { drop(); focus(defFocus(), false, true); }
    }
    lazySoon();
  }

  /* ---------- lazy images: load near the viewport, unload far away ---------- */
  function lazy() {
    var H = page.clientHeight, Wd = page.clientWidth, m = H * 0.5, i, im, r, near;
    if (S.ov) { return; }
    for (i = 0; i < S.imgs.length; i++) {
      im = S.imgs[i];
      r = im.parentNode.getBoundingClientRect();
      near = r.bottom > -m && r.top < H + m && r.right > -Wd * 0.3 && r.left < Wd * 1.4;
      if (near && !im._on) { im._on = 1; im.src = im._src; }
      else if (!near && im._on) { im._on = 0; im.removeAttribute('src'); rmC(im, 'on'); }
    }
    if (G && page.scrollTop + H * 2.5 > page.scrollHeight) { gridMore(); }
  }
  function lazySoon() { if (!lazyT) { lazyT = setTimeout(function () { lazyT = 0; lazy(); }, 140); } }
  function art(it, cls) {
    var a = h('div', cls), im = D.createElement('img');
    im.className = 'im'; im.alt = ''; im._src = thumb(it);
    im.onload = function () { addC(im, 'on'); };
    im.onerror = function () { rmC(im, 'on'); };
    a.appendChild(im); S.imgs.push(im);
    return a;
  }

  /* ---------- library ---------- */
  function signature(l) {
    var a = l.videos.concat(l.photos), s = [l.name, a.length], i, x, p;
    for (i = 0; i < a.length; i++) {
      x = a[i]; p = x.progress;
      s.push([x.id, x.mtime, x.playable, x.hasSubs ? 1 : 0, x.duration, x.width, x.height, x.thumb, x.title, x.collection, p ? Math.round(p.position) : ''].join(','));
    }
    return s.join('|');
  }
  function setLib(l) {
    var i, it, c;
    function own(list) { var o = [], j, x; for (j = 0; j < (list || []).length; j++) { x = S.byId[list[j].id]; if (x) { o.push(x); } } return o; }
    l.videos = l.videos || []; l.photos = l.photos || [];
    S.byId = {}; S.col = {}; S.colNames = [];
    for (i = 0; i < l.videos.length + l.photos.length; i++) {
      it = i < l.videos.length ? l.videos[i] : l.photos[i - l.videos.length];
      S.byId[it.id] = it;
      c = S.col[it.collection];
      if (!c) { c = S.col[it.collection] = { v: [], p: [] }; S.colNames.push(it.collection); }
      c[it.kind === 'photo' ? 'p' : 'v'].push(it);
    }
    l.continueWatching = own(l.continueWatching); l.recent = own(l.recent);
    S.lib = l;
    txt($('lname'), l.name || '');
  }
  function load() {
    clearTimeout(pollT);
    if (S.loading) { return; }
    S.loading = true;
    req('GET', '/api/library', null, function (err, l) {
      var s, first = !S.lib;
      S.loading = false;
      if (err || !l || !l.videos) { offline(); return; }
      clearInterval(cdT); rmC($('toast'), 'on'); rmC(D.body, 'bare');
      s = signature(l);
      if (first || s !== S.sig || S.down) {
        S.sig = s; S.down = false; setLib(l);
        if (S.ov) { S.dirty = true; } else { render(snap()); }
        if (first) { route(); }
      }
      pollT = setTimeout(load, l.videos.length + l.photos.length ? 30000 : 5000);
    });
  }
  function offline() {
    var n = 5, st;
    clearInterval(cdT);
    if (S.lib) {
      txt($('toast'), 'Can\'t reach your Mac. Trying again…'); addC($('toast'), 'on');
      pollT = setTimeout(load, 5000);
      return;
    }
    if (!S.down) {
      S.down = true; addC(D.body, 'bare');
      state('Not connected', 'Can\'t reach your Mac',
        ['Check that the Mac is awake, HomeFlix is turned on, and this screen is on the same Wi-Fi.'], 'off', 'Try now', load);
      drop(); focus(defFocus(), true);
    }
    st = $('cd');
    function tick() {
      if (st) { txt(st, n > 0 ? 'Trying again in ' + plural(n, 'second') : 'Trying now…'); }
      if (n-- <= 0) { clearInterval(cdT); load(); }
    }
    tick(); cdT = setInterval(tick, 1000);
  }

  /* ---------- cards ---------- */
  function sub(it) {
    var p = it.progress;
    if (p && p.duration) { return span(p.duration - p.position) + ' left'; }
    return it.collection;
  }
  /* dim: { w, h } in rem. Photos always need both; videos only in grids (rows use the CSS size). */
  function card(it, list, dim) {
    var c, a, p, b;
    if (it.kind === 'photo') {
      c = art(it, 'tile f');
      c.style.width = dim.w.toFixed(3) + 'rem'; c.style.height = dim.h.toFixed(3) + 'rem';
    } else {
      c = h('div', 'card f');
      a = art(it, 'art'); p = it.progress;
      if (dim) { c.style.width = dim.w.toFixed(3) + 'rem'; a.style.height = (dim.w * 0.5625).toFixed(3) + 'rem'; }
      if (p && p.duration) { b = h('div', 'bar'); b.appendChild(h('i')).style.width = Math.min(100, p.position / p.duration * 100) + '%'; a.appendChild(b); }
      if (it.playable === 'no') { a.appendChild(h('span', 'tag', 'Can\'t play on TV')); }
      else if (it.duration) { a.appendChild(h('span', 'dur', clock(it.duration))); }
      c.appendChild(a); c.appendChild(h('div', 'ttl', it.title)); c.appendChild(h('div', 'sub', sub(it)));
    }
    c._id = it.id; c._it = it; c._list = list;
    c._act = function () { openItem(it, list); };
    return c;
  }
  function button(label, id, fn, pri, icon) {
    var b = h('div', 'btn f' + (pri ? ' pri' : ''));
    if (icon) { b.innerHTML = svg(icon); }
    b.appendChild(D.createTextNode(label));
    b._id = id; b._act = fn;
    return b;
  }

  /* ---------- home: billboard ---------- */
  function quality(it) { var m = Math.max(it.width || 0, it.height || 0); return m >= 3800 ? '4K' : m >= 1260 ? 'HD' : ''; }
  function billboard() {
    var bb = h('div', 'bb'), ar = h('div', 'bart');
    B = { l: [h('div', 'bl'), h('div', 'bl')], top: 0, pend: null, tx: h('div'), act: h('div', 'bact zone'), url: '', it: null, list: null, im: null, box: h('div', 'btx') };
    ar.appendChild(B.l[0]); ar.appendChild(B.l[1]); ar.appendChild(h('div', 'bsh'));
    B.act._row = 1; B.act._bbz = 1; B.act._key = 'bb';
    B.box.appendChild(B.tx); B.box.appendChild(B.act);
    bb.appendChild(ar); bb.appendChild(B.box);
    return bb;
  }
  /* the incoming backdrop fades in above the current one, so the picture never dips to black */
  function bbSettle() {
    var p = B.pend;
    if (!p) { return; }
    clearTimeout(p.t); B.pend = null;
    rmC(p.old, 'on'); p.old.style.backgroundImage = 'none';
  }
  function bbImage(it) {
    var url = it.kind === 'photo' ? '/photo/' + it.id + '?w=1280' : thumb(it, 1280), im, b = B;
    if (url === b.url) { return; }
    b.url = url; im = new Image(); b.im = im;
    function done(ok) {
      var a, n;
      if (B !== b || b.im !== im) { return; }
      b.im = null; bbSettle();
      a = b.l[b.top]; n = b.l[1 - b.top];
      n.style.backgroundImage = ok ? 'url("' + url + '")' : 'none';
      a.style.zIndex = 1; n.style.zIndex = 2;
      n.offsetWidth; addC(n, 'on'); b.top = 1 - b.top;
      b.pend = { old: a, t: setTimeout(bbSettle, 300) };
    }
    im.onload = function () { done(true); };
    im.onerror = function () { done(false); };
    im.src = url;
  }
  function bbFill(it, list) {
    var tx = B.tx, act = B.act, p = it.progress, vdo = it.kind === 'video', keep = cur && cur.parentNode === act ? cur._id : null, m, b, q, n;
    B.it = it; B.list = list;
    tx.innerHTML = ''; act.innerHTML = '';
    /* camera file names say nothing: a photo is headlined by its collection */
    n = vdo ? it.title : it.collection;
    tx.appendChild(h('h1', n.length > 30 ? 'long' : '', n));
    m = h('div', 'bmeta');
    if (it.playable === 'no') { m.appendChild(h('span', 'w', 'Can\'t play on TV')); }
    m.appendChild(h('span', '', vdo ? it.collection : it.title));
    if (vdo && it.duration) { m.appendChild(h('span', '', span(it.duration))); }
    q = vdo ? quality(it) : '';
    if (q) { m.appendChild(h('span', 'q', q)); }
    m.appendChild(h('span', '', day(it.mtime)));
    tx.appendChild(m);
    if (p && p.duration) {
      b = h('div', 'bprog'); b.appendChild(h('div', 'hbar')).appendChild(h('i')).style.width = (p.position / p.duration * 100) + '%';
      b.appendChild(D.createTextNode(span(p.duration - p.position) + ' left')); tx.appendChild(b);
    }
    if (!vdo) {
      act.appendChild(button('View photo', 'play', function () { openItem(it, list); }, true));
      if (list.length > 1) { act.appendChild(button('Start slideshow', 'slide', function () { openItem(it, list); vSlide(true); })); }
    } else if (p && it.playable !== 'no') {
      act.appendChild(button('Resume from ' + clock(p.position), 'play', function () { startPlayer(it, p.position); }, true, 'play'));
      act.appendChild(button('Start over', 'restart', function () { startPlayer(it, 0); }));
    } else { act.appendChild(button('Play', 'play', function () { playFlow(it); }, true, 'play')); }
    if (keep) {
      cur = null;
      for (n = act.firstChild; n; n = n.nextSibling) { if (n._id === keep) { focus(n, true); } }
      if (!cur) { focus(act.firstChild, true); }
    }
    rmC(B.box, 'in'); B.box.offsetWidth; addC(B.box, 'in');
    bbImage(it);
  }
  /* follow the focused card after it has rested for a moment; fast scrolling costs nothing */
  function bbSet(it, list, at) {
    clearTimeout(bbT);
    if (!B || B.it === it) { return; }
    if (at) { bbFill(it, list); } else { bbT = setTimeout(function () { if (B && !S.ov) { bbFill(it, list); } }, 260); }
  }

  /* ---------- home: rows ---------- */
  function idKey(items) {
    var a = [], i;
    for (i = 0; i < items.length; i++) { a.push(items[i].id); }
    return a.sort().join(',');
  }
  /* rows in order, leaving out any row that would show exactly the same items as one above it,
     and collection rows when the whole library is a single collection */
  function homeRows() {
    var l = S.lib, out = [], seen = {}, i, name, c;
    function add(key, title, items, tab) {
      var k;
      if (!items.length) { return; }
      k = idKey(items);
      if (seen[k]) { return; }
      seen[k] = 1; out.push({ key: key, title: title, items: items, tab: tab });
    }
    add('cw', 'Continue watching', l.continueWatching, 'videos');
    add('recent', 'Recently added', l.recent, l.videos.length ? 'videos' : 'photos');
    if (S.colNames.length > 1) {
      for (i = 0; i < S.colNames.length; i++) { name = S.colNames[i]; c = S.col[name]; add('c:' + name, name, c.v.concat(c.p), c.v.length ? 'videos' : 'photos'); }
    }
    add('videos', 'Videos', l.videos, 'videos');
    add('photos', 'Photos', l.photos, 'photos');
    return out;
  }
  function row(r, idx, rows) {
    var sec = h('div', 'row'), tr = h('div', 'track'), st = h('div', 'strip zone'), items = r.items, n = Math.min(items.length, 24), th = S.compact ? 13.5 : 12.375, i, m;
    sec.appendChild(h('h2', 'rt', r.title));
    st._key = r.key; st._row = 1; st._home = 1; st._idx = idx; st._rows = rows; st._sec = sec; tr.onscroll = lazySoon;
    for (i = 0; i < n; i++) { st.appendChild(card(items[i], items, items[i].kind === 'photo' ? { h: th, w: th * Math.max(0.7, Math.min(1.8, aspect(items[i]))) } : null)); }
    if (items.length > n) {
      m = h('div', 'card f more'); m.appendChild(h('div', 'art', 'See all ' + items.length));
      m._id = 'more'; m._act = function () { showTab(r.tab); };
      st.appendChild(m);
    }
    st.appendChild(h('i', 'end'));
    tr.appendChild(st); sec.appendChild(tr);
    return sec;
  }
  function renderHome() {
    var rs = homeRows(), home = h('div', 'home'), win = h('div', 'rwin'), rows = h('div', 'rows'), i;
    home.appendChild(billboard());
    for (i = 0; i < rs.length; i++) { rows.appendChild(row(rs[i], i, rows)); }
    win.appendChild(rows); home.appendChild(win); view.appendChild(home);
    bbFill(rs[0].items[0], rs[0].items);
  }

  /* ---------- Videos / Photos grids ---------- */
  /* pack photos into full-width lines at their real aspect ratios; returns one { w, h } per item, in rem */
  function justify(items, avail, target, gap) {
    var out = [], line = [], sum = 0, i, j, hgt;
    for (i = 0; i < items.length; i++) {
      line.push(aspect(items[i])); sum += line[line.length - 1];
      if (sum * target + gap * (line.length - 1) >= avail) {
        hgt = Math.min(target * 1.6, (avail - 0.1 - gap * (line.length - 1)) / sum);
        for (j = 0; j < line.length; j++) { out.push({ w: line[j] * hgt, h: hgt }); }
        line = []; sum = 0;
      }
    }
    for (j = 0; j < line.length; j++) { out.push({ w: line[j] * target, h: target }); }
    return out;
  }
  function gridMore() {
    var n = 0, bl, t;
    if (!G) { return false; }
    while (n < 48 && G.b < G.blocks.length) {
      bl = G.blocks[G.b];
      if (!G.el) {
        if (bl.title) { t = h('h2', 'rt gh', bl.title); t.appendChild(h('small', '', plural(bl.items.length, 'photo'))); view.appendChild(t); }
        G.el = h('div', 'grid zone' + (bl.dims ? ' pg' : '')); G.el._key = 'g:' + bl.title; G.el._grid = 1; view.appendChild(G.el);
      }
      if (G.i < bl.items.length) { G.el.appendChild(card(bl.items[G.i], bl.items, bl.dims ? bl.dims[G.i] : bl.dim)); G.i++; n++; G.n++; }
      else { G.b++; G.i = 0; G.el = null; }
    }
    if (n) { lazySoon(); }
    return n > 0;
  }
  function renderGrid(photos) {
    var l = S.lib, items = photos ? l.photos : l.videos, mg = S.compact ? 1.6 : 6, avail = page.clientWidth / S.rem - 2 * mg, t, i, c, cols, gap;
    if (!items.length) {
      t = h('div', 'mini');
      t.appendChild(h('h2', '', photos ? 'No photos yet' : 'No videos yet'));
      t.appendChild(h('p', '', 'Add some on your Mac in HomeFlix and they will appear here.'));
      view.appendChild(t);
      return;
    }
    t = h('h1', 'gt', photos ? 'Photos' : 'Videos');
    t.appendChild(h('small', '', plural(items.length, photos ? 'photo' : 'video')));
    view.appendChild(t);
    G = { blocks: [], b: 0, i: 0, n: 0, el: null };
    if (!photos) {
      gap = S.compact ? 1 : 1.5; cols = S.compact ? Math.max(2, Math.floor(avail / 19)) : 4;
      G.blocks.push({ title: '', items: items, dim: { w: (avail - 0.05 - gap * (cols - 1)) / cols } });
    } else {
      gap = S.compact ? 0.5 : 0.75;
      for (i = 0; i < S.colNames.length; i++) {
        c = S.col[S.colNames[i]].p;
        if (c.length) { G.blocks.push({ title: S.colNames[i], items: c, dims: justify(c, avail, S.compact ? 11 : 15, gap) }); }
      }
    }
    gridMore();
  }
  function state(label, title, lines, pic, btn, fn) {
    var s = h('div', 'state'), tx = h('div', 'tx'), p = h('div', 'pic'), i, z;
    G = null; B = null; S.imgs = []; view.innerHTML = '';
    /* a laptop and a TV; the link between them is lit when connected */
    p.innerHTML = '<svg viewBox="0 0 320 180"><path d="M20 70h84v54H20zM10 130h104v8H10z M196 40h114v78H196zM232 128h42v8h-42z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>' +
      (pic === 'off' ? '<path class="lit" d="M124 96h14M150 96h8M172 96h14M149 84l14 24M163 84l-14 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
        : '<path class="lit" d="M124 96h14M148 96h14M172 96h14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>') + '</svg>';
    s.appendChild(p);
    tx.appendChild(h('div', 'mic', label)); tx.appendChild(h('h1', '', title));
    for (i = 0; i < lines.length; i++) { tx.appendChild(h('p', '', lines[i])); }
    p = h('p', 'dim'); p.id = 'cd'; tx.appendChild(p);
    if (btn) { z = h('div', 'bact zone'); z._row = 1; z._top = 1; z._key = 'state'; z.appendChild(button(btn, 'b', fn, true)); tx.appendChild(z); }
    s.appendChild(tx); view.appendChild(s);
  }
  function render(keep) {
    var l = S.lib, n = G ? G.n : 0, i, tabs = ['home', 'videos', 'photos'], st = page.scrollTop, sl = {}, q;
    if (!l) { return; }
    for (i = 0; i < 3; i++) { setC($('t-' + tabs[i]), 'act', tabs[i] === S.tab); }
    $('tabs')._mem = $('t-' + S.tab);
    /* fingers keep their place: remember how far each row and the page were scrolled */
    q = view.querySelectorAll('.strip');
    for (i = 0; keep && S.touch && i < q.length; i++) { sl[q[i]._key] = q[i].parentNode.scrollLeft; }
    clearTimeout(bbT);
    S.dirty = false; S.imgs = []; G = null; B = null; view.innerHTML = '';
    rmC(D.body, 'deep');
    if (!l.videos.length && !l.photos.length) {
      state(l.name || 'HomeFlix', 'Nothing to watch yet',
        ['On your Mac, open HomeFlix and drag videos or photos into the Library.', 'They will appear here by themselves. There is no need to reload this page.'], 'on', 'Check now', load);
      txt($('cd'), 'Looking for new videos and photos every few seconds.');
    } else if (S.tab === 'home') { renderHome(); }
    else { renderGrid(S.tab === 'photos'); while (keep && G && G.n < n && gridMore()) { /* re-grow to where the user was */ } }
    if (S.touch) {
      drop();
      q = view.querySelectorAll('.strip');
      for (i = 0; keep && i < q.length; i++) { if (sl[q[i]._key]) { q[i].parentNode.scrollLeft = sl[q[i]._key]; } }
      page.scrollTop = keep ? st : 0;
    } else if (keep) { restore(keep); }
    else { drop(); page.scrollTop = 0; page._to = 0; focus(defFocus(), false, true); }
    lazy();
  }
  /* rep: replace the current history entry, so a TV whose Back button is "history back" is never trapped */
  function setHash(hs, rep) {
    if (location.hash === hs) { return; }
    if (rep) {
      try { if (W.history && W.history.replaceState) { W.history.replaceState(null, '', hs); return; } } catch (e) {}
      location.replace(location.href.split('#')[0] + hs);
    } else { location.hash = hs; }
  }
  function stateHash() { return S.ov === 'player' ? '#/play/' + P.it.id : S.ov === 'viewer' ? '#/photo/' + V.list[V.i].id : '#/' + S.tab; }
  function showTab(name, rep) {
    S.tab = name; setHash('#/' + name, rep);
    render(null);
    if (name === 'home') { load(); }
  }
  function route() {
    var m = /^#\/(\w+)(?:\/(\w+))?/.exec(location.hash) || [], it = S.byId[m[2]], i, list = null;
    if (!S.lib) { return; }
    if (dlg) { closeDlg(); }
    if (S.ov === 'player') { closePlayer(); } else if (S.ov === 'viewer') { closeViewer(); }
    if (m[1] === 'play' && it && it.kind === 'video') { playFlow(it); }
    else if (m[1] === 'photo' && it && it.kind === 'photo') {
      /* reopen among the photos it was last opened with, else its own collection */
      for (i = 0; i < V.list.length; i++) { if (V.list[i] === it) { list = V.list; } }
      openViewer(it, list || S.col[it.collection].p, true);
    }
    else if ((m[1] === 'videos' || m[1] === 'photos' || m[1] === 'home') && m[1] !== S.tab) { S.tab = m[1]; render(null); }
  }
  function openItem(it, list) { if (it.kind === 'photo') { openViewer(it, list); } else { playFlow(it); } }
  function browseKey(a) {
    var t;
    if (a === 'back') {
      if (S.tab !== 'home') { showTab('home', true); return; }
      t = view.querySelector('.strip');
      t = t ? edge(t) : defFocus();
      if (t && t !== cur) { focus(t); }
      return;
    }
    if (a === 'ok' || a === 'play' || a === 'pp') { if (cur && contains(page, cur)) { activate(cur); } else { drop(); focus(defFocus()); } return; }
    if (a.length === 1) { move(a); }
  }

  /* ---------- dialog ---------- */
  function dialog(o) {
    var d = $('dlg'), box = h('div', 'box'), z = h('div', 'bact zone'), i;
    function mk(b) { return button(b[0], b[0], function () { closeDlg(); b[1](); }, i === 0); }
    d.innerHTML = '';
    box.appendChild(h('div', 'mic', o.label)); box.appendChild(h('h2', '', o.title));
    for (i = 0; i < o.lines.length; i++) { if (o.lines[i]) { box.appendChild(h('p', '', o.lines[i])); } }
    z._row = 1;
    for (i = 0; i < o.btns.length; i++) { z.appendChild(mk(o.btns[i])); }
    box.appendChild(z); d.appendChild(box);
    dlg = { prev: cur, back: o.back };
    addC(d, 'on');
    focus(edge(z), true);
  }
  function closeDlg() {
    var p = dlg && dlg.prev;
    if (!dlg) { return; }
    dlg = null; rmC($('dlg'), 'on');
    drop();
    if (p && contains(D.body, p)) { focus(p, true); }
  }
  function dlgBack() { var b = dlg && dlg.back; closeDlg(); if (b) { b(); } }
  function dlgKey(a) {
    if (a === 'back') { dlgBack(); }
    else if (a === 'ok') { activate(cur); }
    else if (a === 'l' || a === 'r') { move(a); }
  }

  /* ---------- player ---------- */
  function playFlow(it) {
    var p = it.progress;
    if (it.playable === 'no') {
      dialog({ label: 'Can\'t play here', title: it.title,
        lines: [it.note || 'TV browsers can\'t play .' + it.ext + ' videos.', 'On your Mac, open HomeFlix, find this video and choose Convert. The new copy will appear here and play normally.'],
        btns: [['OK', function () {}], ['Try anyway', function () { startPlayer(it, 0); }]] });
    } else if (p && p.position > 30) {
      dialog({ label: 'Continue watching', title: it.title,
        lines: ['You stopped at ' + clock(p.position) + (p.duration ? ', with ' + span(p.duration - p.position) + ' left.' : '.')],
        btns: [['Resume from ' + clock(p.position), function () { startPlayer(it, p.position); }], ['Start over', function () { startPlayer(it, 0); }]] });
    } else { startPlayer(it, 0); }
  }
  function dur() { var d = vid.duration; return d && isFinite(d) ? d : (P.it && P.it.duration) || 0; }
  function startPlayer(it, pos) {
    var tr, pr, i;
    if (!P.on) { P.ret = snap(); }
    P.on = true; P.it = it; P.resume = pos || 0; P.target = null; P.sn = 0; P.started = false; P.done = false;
    clearTimeout(bbT);
    S.ov = 'player'; addC(page, 'off'); addC($('player'), 'on'); addC($('player'), 'busy');
    setHash('#/play/' + it.id);
    txt($('pttl'), it.title); txt($('pcol'), it.collection);
    while (vid.firstChild) { vid.removeChild(vid.firstChild); }
    setC($('b-cc'), 'hid', !it.hasSubs);
    if (it.hasSubs) {
      tr = D.createElement('track'); tr.kind = 'subtitles'; tr.label = 'Subtitles'; tr.srclang = 'en'; tr.src = '/subs/' + it.id + '.vtt';
      if (P.subs) { tr.setAttribute('default', ''); }
      vid.appendChild(tr);
    }
    vid.controls = S.touch;
    vid.src = it.src;
    try { vid.load(); pr = vid.play(); if (pr && pr.then) { pr.then(function () {}, function () {}); } } catch (e) {}
    draw(P.resume);
    clearInterval(P.saveT);
    P.saveT = setInterval(function () { if (!vid.paused) { save(); } }, 10000);
    $('pbtns')._mem = $('b-pp');
    /* free decoded thumbnails while a video plays; the screen is rebuilt on the way back */
    for (i = 0; i < S.imgs.length; i++) { if (S.imgs[i]._on) { S.imgs[i]._on = 0; S.imgs[i].removeAttribute('src'); } }
    drop();
    focus($('pbar'), true); osd();
  }
  function applySubs() {
    var t = vid.textTracks, i;
    setC($('b-cc'), 'offx', !P.subs);
    for (i = 0; t && i < t.length; i++) { t[i].mode = P.subs ? 'showing' : 'hidden'; }
  }
  function save(pos) {
    var it = P.it, d = dur(), cw, i;
    if (!it || !d) { return; }
    pos = pos == null ? vid.currentTime : pos;
    if (!P.started && pos < 1) { return; }
    req('PUT', '/api/progress/' + it.id, { position: Math.round(pos * 10) / 10, duration: Math.round(d * 10) / 10 });
    /* mirror the server rule locally so Home is right before the next poll */
    it.progress = (pos < 30 || pos > d * 0.95) ? null : { position: pos, duration: d, updatedAt: now() };
    cw = S.lib.continueWatching;
    for (i = cw.length - 1; i >= 0; i--) { if (cw[i] === it) { cw.splice(i, 1); } }
    if (it.progress) { cw.unshift(it); }
  }
  function closePlayer() {
    if (!P.on) { return; }
    if (!P.done) { save(P.target != null ? P.target : null); }
    P.on = false; P.it = null; P.done = false;
    clearInterval(P.saveT); clearTimeout(P.osdT); clearTimeout(P.seekT);
    try { vid.pause(); } catch (e) {}
    while (vid.firstChild) { vid.removeChild(vid.firstChild); }
    vid.removeAttribute('src');
    try { vid.load(); } catch (e2) {}
    $('player').className = 'layer';
    S.ov = null; rmC(page, 'off');
    setHash('#/' + S.tab, true);
    render(P.ret || { key: '', id: '' });
    load();
  }
  function draw(t) {
    var d = dur(), f = d ? Math.max(0, Math.min(1, t / d)) * 100 : 0;
    $('pfill').style.width = f + '%'; $('pknob').style.left = f + '%'; $('ptip').style.left = Math.max(2.6, Math.min(97.4, f)) + '%';
    txt($('pcur'), clock(t)); txt($('prem'), d ? clock(d - t) + ' left' : '');
    txt($('ptip'), clock(t));
  }
  function osd() {
    addC($('player'), 'osd');
    clearTimeout(P.osdT);
    P.osdT = setTimeout(function () {
      if (!P.on || vid.paused || P.target != null || dlg) { return; }
      rmC($('player'), 'osd');
      if (cur !== $('pbar')) { focus($('pbar'), true); }
    }, 3000);
  }
  function toggle() { var pr; if (vid.paused) { pr = vid.play(); if (pr && pr.then) { pr.then(function () {}, function () {}); } } else { vid.pause(); } }
  function commit() {
    clearTimeout(P.seekT);
    if (P.target == null) { return; }
    try { vid.currentTime = P.target; } catch (e) {}
    P.target = null; rmC($('player'), 'seek'); osd();
  }
  function seek(dir) {
    var d = dur(), step, base;
    if (!d) { return; }
    if (P.sdir !== dir) { P.sn = 0; }
    P.sdir = dir; P.sn++;
    /* holding the key accelerates: 10s steps, then 30s, 60s, 2 min (never more than 1/40 of the video) */
    step = P.sn < 6 ? 10 : P.sn < 14 ? 30 : P.sn < 28 ? 60 : 120;
    step = Math.min(step, Math.max(10, d / 40));
    base = P.target != null ? P.target : vid.currentTime;
    P.target = Math.max(0, Math.min(d - 2, base + dir * step));
    addC($('player'), 'seek'); draw(P.target); osd();
    clearTimeout(P.seekT); P.seekT = setTimeout(commit, 600);
  }
  function playerKey(a) {
    var shown = hasC($('player'), 'osd'), bar = $('pbar');
    if (a === 'back' || a === 'stop') { closePlayer(); return; }
    osd();
    if (a === 'play') { if (vid.paused) { toggle(); } }
    else if (a === 'pause') { if (!vid.paused) { toggle(); } }
    else if (a === 'pp') { toggle(); }
    else if (a === 'ff' || a === 'rw') { seek(a === 'ff' ? 1 : -1); }
    else if (a === 'l' || a === 'r') { if (cur === bar) { seek(a === 'r' ? 1 : -1); } else { move(a); } }
    else if (a === 'ok') { if (cur === bar) { toggle(); } else { activate(cur); } }
    else if (shown) { move(a); }
  }
  function playError() {
    var it = P.it, c = vid.error ? vid.error.code : 0, at = vid.currentTime || P.resume || 0, started = P.started, msg;
    if (!P.on || !it || c === 1) { return; }
    function show(title, m, retry) {
      if (!P.on || P.it !== it) { return; }
      rmC($('player'), 'busy');
      dialog({ label: 'Playback problem', title: title, lines: [m, retry && c !== 2 ? it.note : null],
        btns: retry ? [['Try again', function () { startPlayer(it, at); }], ['Back', closePlayer]] : [['Back', closePlayer]], back: closePlayer });
    }
    if (c === 3) { msg = 'This screen could not read part of this video. The file may be damaged, or it uses a format that does not play here. On your Mac, open HomeFlix and choose Convert for this video.'; }
    else { msg = 'This video file (.' + it.ext + ') does not play here. It may use a format this screen does not support, or the file may be damaged. On your Mac, open HomeFlix and check this video. Converting it to MP4 usually fixes it.'; }
    if (at > 1) { save(at); }
    /* an unreachable Mac or a deleted file also surfaces as "unsupported": rule those out before blaming the format */
    req('GET', '/api/ping', null, function (err) {
      var title = started ? 'This video stopped playing' : 'This video won\'t play';
      if (err) { show(title, 'The connection to your Mac dropped. Check that the Mac is awake and on the same Wi-Fi as this screen, then try again.', true); return; }
      req('HEAD', it.src, null, function (e2) {
        if (e2 === 404 || e2 === 410) { show('This video is no longer on your Mac', 'The file was moved, renamed or deleted after HomeFlix last looked. Go back and pick something else. If it should still be there, check the folder on your Mac.', false); }
        else if (e2 || c === 2) { show(title, 'The connection to your Mac was interrupted while loading this video. Check that the Mac is awake and on the same Wi-Fi, then try again.', true); }
        else { show(title, msg, true); }
      });
    });
  }
  function initPlayer() {
    var pp = $('b-pp'), bar = $('pbar');
    function on(ev, fn) { vid.addEventListener(ev, fn, false); }
    function btn(id, icon, cap, fn) { var b = $(id); if (icon) { b.innerHTML = svg(icon); } b._cap = cap; b._act = fn; }
    $('pbz')._row = 1; $('pbtns')._row = 1;
    bar._cap = ''; bar._act = toggle;
    btn('b-rw', 'rw', 'Back 10 seconds', function () { seek(-1); P.sn = 0; });
    btn('b-ff', 'ff', 'Forward 10 seconds', function () { seek(1); P.sn = 0; });
    btn('b-pp', 'pause', function () { return vid.paused ? 'Play' : 'Pause'; }, toggle);
    btn('b-re', 're', 'Start over', function () { P.target = 0; commit(); });
    btn('b-cc', '', function () { return P.subs ? 'Subtitles are on' : 'Subtitles are off'; }, function () {
      P.subs = !P.subs; applySubs(); txt($('pcap'), $('b-cc')._cap());
      try { W.localStorage.setItem('hf-subs', P.subs ? '1' : '0'); } catch (e) {}
    });
    try { P.subs = W.localStorage.getItem('hf-subs') !== '0'; } catch (e) { P.subs = true; }
    $('pclose').innerHTML = svg('prev'); $('pclose').onclick = closePlayer;
    on('loadedmetadata', function () {
      if (P.resume > 0) { try { vid.currentTime = P.resume; } catch (e) {} }
      applySubs(); draw(P.resume);
    });
    on('timeupdate', function () { if (P.on && P.target == null) { draw(vid.currentTime); } });
    on('playing', function () {
      rmC($('player'), 'busy'); P.started = true;
      if (P.resume > 0 && vid.currentTime < P.resume - 5) { try { vid.currentTime = P.resume; } catch (e) {} }
      P.resume = 0; pp.innerHTML = svg('pause'); if (cur === pp) { txt($('pcap'), 'Pause'); } osd();
    });
    on('pause', function () { if (!P.on) { return; } pp.innerHTML = svg('play'); if (cur === pp) { txt($('pcap'), 'Play'); } save(); osd(); });
    on('waiting', function () { if (P.on) { addC($('player'), 'busy'); } });
    on('seeking', function () { if (P.on) { addC($('player'), 'busy'); } });
    on('seeked', function () { rmC($('player'), 'busy'); });
    on('canplay', function () { rmC($('player'), 'busy'); });
    on('ended', function () { if (P.on) { save(dur()); P.done = true; closePlayer(); } });
    on('error', playError);
    vid.onclick = function () { if (S.touch) { return; } if (hasC($('player'), 'osd')) { toggle(); } osd(); };
    bar.onclick = function (e) {
      var r = bar.getBoundingClientRect(), d = dur();
      if (d) { P.target = Math.max(0, Math.min(d - 2, (e.clientX - r.left) / r.width * d)); commit(); }
    };
  }

  /* ---------- photo viewer: two cross-fading layers, current +/- 1 preloaded ---------- */
  function purl(it) { return '/photo/' + it.id + '?w=' + S.pw; }
  function openViewer(it, list, rep) {
    var i, ph = [];
    for (i = 0; i < list.length; i++) { if (list[i].kind === 'photo') { ph.push(list[i]); } }
    V.list = ph; V.i = 0;
    for (i = 0; i < ph.length; i++) { if (ph[i] === it) { V.i = i; } }
    V.on = true; V.play = false; V.top = 0; V.ret = cur; V.first = !rep;
    clearTimeout(bbT);
    S.ov = 'viewer'; addC(page, 'off'); $('viewer').className = 'layer on';
    vHint(); vShow(V.i); vUi();
  }
  function vHint() {
    txt($('vhint'), V.play ? 'OK pauses the slideshow.' : 'OK starts the slideshow. Up shows details.');
    txt($('vssb'), V.play ? 'Pause slideshow' : 'Slideshow');
  }
  function vUi(stay) {
    addC($('viewer'), 'ui');
    clearTimeout(V.uiT);
    if (!stay) { V.uiT = setTimeout(function () { rmC($('viewer'), 'ui'); }, 3500); }
  }
  function vNext() { V.timer = setTimeout(function () { vShow((V.i + 1) % V.list.length); }, 5000); }
  function vShow(i) {
    var it = V.list[i], im = new Image(), el = $('viewer'), bar = $('vbar'), m = $('vmeta');
    V.i = i; V.load = im;
    clearTimeout(V.timer);
    /* one history entry for the whole viewer: stepping through photos replaces it */
    setHash('#/photo/' + it.id, !V.first); V.first = false;
    txt($('vpos'), (i + 1) + ' / ' + V.list.length);
    txt($('vttl'), it.title);
    m.innerHTML = '';
    m.appendChild(h('span', '', it.collection)); m.appendChild(h('span', '', day(it.mtime)));
    if (it.width && it.height) { m.appendChild(h('span', '', it.width + ' × ' + it.height)); }
    m.appendChild(h('span', '', bytes(it.size)));
    addC(el, 'busy'); rmC(el, 'verr'); rmC(bar, 'run');
    function done(ok) {
      var a = $(V.top ? 'vb' : 'va'), b = $(V.top ? 'va' : 'vb');
      if (!V.on || V.load !== im) { return; }
      V.load = null; rmC(el, 'busy'); setC(el, 'verr', !ok);
      if (!ok) { txt($('vmsg'), 'This photo could not be loaded. It may have been moved or deleted on your Mac.'); }
      b.className = 'vl'; b.style.backgroundImage = ok ? 'url("' + im.src + '")' : 'none';
      b.offsetWidth;
      /* a slow drift during the slideshow, alternating direction; skipped when motion is reduced */
      b.className = 'vl on' + (V.play && !S.reduce ? (V.n++ % 2 ? ' kb kb2' : ' kb') : '');
      rmC(a, 'on'); V.top = V.top ? 0 : 1;
      setTimeout(function () { if (!hasC(a, 'on')) { a.style.backgroundImage = 'none'; a.className = 'vl'; } }, 700);
      /* keep only the neighbours warm */
      V.pn = V.list[i + 1] ? new Image() : null; if (V.pn) { V.pn.src = purl(V.list[i + 1]); }
      V.pp = V.list[i - 1] ? new Image() : null; if (V.pp) { V.pp.src = purl(V.list[i - 1]); }
      if (V.play) { bar.offsetWidth; addC(bar, 'run'); vNext(); }
    }
    im.onload = function () { done(true); };
    im.onerror = function () { done(false); };
    im.src = purl(it);
  }
  function vStep(d) { var n = V.i + d; if (n >= 0 && n < V.list.length) { vShow(n); } else { vUi(); } }
  function vSlide(on) {
    if (!V.on) { return; }
    V.play = on && V.list.length > 1; setC($('viewer'), 'ss', V.play);
    clearTimeout(V.timer); rmC($('vbar'), 'run');
    vHint();
    if (V.play && !V.load) {
      $('vbar').offsetWidth; addC($('vbar'), 'run'); vNext();
      if (!S.reduce) { addC($(V.top ? 'vb' : 'va'), 'kb'); }
    }
    vUi();
  }
  function closeViewer() {
    var it = V.list[V.i], z, n, t = null;
    if (!V.on) { return; }
    V.on = false; V.load = V.pn = V.pp = null;
    clearTimeout(V.timer); clearTimeout(V.uiT);
    $('va').style.backgroundImage = 'none'; $('vb').style.backgroundImage = 'none';
    $('va').className = $('vb').className = 'vl';
    $('viewer').className = 'layer';
    S.ov = null; rmC(page, 'off');
    setHash('#/' + S.tab, true);
    if (S.dirty) { render({ key: V.ret && V.ret.parentNode ? V.ret.parentNode._key : '', id: it.id }); return; }
    /* land on the photo that was showing, when it is in the row or grid we came from */
    z = V.ret && contains(page, V.ret) ? V.ret.parentNode : null;
    for (n = z && z.firstChild; n; n = n.nextSibling) { if (isF(n) && n._id === it.id) { t = n; } }
    t = t || (z ? V.ret : defFocus());
    if (S.touch) { drop(); } else { focus(t, false, true); }
    lazy();
  }
  function viewerKey(a) {
    if (a === 'back' || a === 'stop') { closeViewer(); }
    else if (a === 'l' || a === 'rw') { vStep(-1); }
    else if (a === 'r' || a === 'ff') { vStep(1); }
    else if (a === 'ok' || a === 'pp') { vSlide(!V.play); }
    else if (a === 'play') { vSlide(true); }
    else if (a === 'pause') { vSlide(false); }
    else if (a === 'u') { addC($('viewer'), 'info'); }
    else if (a === 'd') { rmC($('viewer'), 'info'); }
  }
  function initViewer() {
    var el = $('viewer'), x0 = null, y0 = 0, swiped = 0;
    function tap(id, fn) { $(id).onclick = function (e) { e.stopPropagation(); fn(); }; }
    $('vprev').innerHTML = svg('prev'); $('vnext').innerHTML = svg('next'); $('vclose').innerHTML = svg('x');
    tap('vprev', function () { vStep(-1); vUi(); });
    tap('vnext', function () { vStep(1); vUi(); });
    tap('vclose', closeViewer);
    tap('vssb', function () { vSlide(!V.play); });
    /* a tap or click shows or hides the controls; swiping moves between photos */
    el.onclick = function () { if (now() - swiped < 400) { return; } if (hasC(el, 'ui')) { clearTimeout(V.uiT); rmC(el, 'ui'); } else { vUi(S.touch && !V.play); } };
    el.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, false);
    el.addEventListener('touchend', function (e) {
      var dx, dy;
      if (x0 == null) { return; }
      dx = e.changedTouches[0].clientX - x0; dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = now(); vStep(dx < 0 ? 1 : -1); }
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 2) { swiped = now(); closeViewer(); }
    }, false);
  }

  /* ---------- input ---------- */
  function onKey(e) {
    var a = KEY[e.keyCode];
    if (!a || e.ctrlKey || e.metaKey || e.altKey) { return; }
    e.preventDefault();
    rmC(HTML, 'ptr');
    if (S.touch) { setMode(false); if (!S.ov && !dlg && a !== 'back') { return; } }
    if (dlg) { dlgKey(a); }
    else if (S.ov === 'player') { playerKey(a); }
    else if (S.ov === 'viewer') { viewerKey(a); }
    else { browseKey(a); }
  }
  function fOf(n) { while (n && n !== D.body) { if (n.nodeType === 1 && hasC(n, 'f')) { return n; } n = n.parentNode; } return null; }
  function clock12() {
    var d = new Date(), hh = d.getHours();
    txt($('clock'), (hh % 12 || 12) + ':' + pad(d.getMinutes()) + (hh < 12 ? ' am' : ' pm'));
  }
  /* narrow or portrait screens get the stacked layout; everything else is laid out like a TV */
  function measure() {
    var w = W.innerWidth || HTML.clientWidth, hgt = W.innerHeight || HTML.clientHeight, px = w * (W.devicePixelRatio || 1);
    var compact = w < 700 || (w < 1000 && hgt > w), rem = compact ? Math.max(8, Math.min(14, w / 39)) : Math.max(8, w / 120);
    var changed = compact !== S.compact || Math.abs(rem - S.rem) > 0.01;
    S.compact = compact; S.rem = rem;
    setC(HTML, 'compact', compact);
    HTML.style.fontSize = rem + 'px';
    S.pw = px > 2000 ? 2560 : px > 1300 ? 1920 : 1280;
    return changed;
  }
  function init() {
    var tabs = ['home', 'videos', 'photos'], keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'], i, m;
    function tab(n) { var t = $('t-' + n); t._id = n; t._act = function () { showTab(n); }; }
    page = $('page'); view = $('view'); vid = $('vid');
    for (i = 0; i < 3; i++) { tab(tabs[i]); }
    $('tabs')._row = 1; $('tabs')._top = 1; $('tabs')._key = 'nav';
    m = /^#\/(home|videos|photos)/.exec(location.hash);
    if (m) { S.tab = m[1]; }
    try { S.reduce = W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    try { for (i = 0; i < keys.length; i++) { W.tizen.tvinputdevice.registerKey(keys[i]); } } catch (e2) {}
    measure(); initPlayer(); initViewer(); clock12();
    /* a narrow portrait screen is a phone until a key says otherwise; anything TV-shaped starts with visible focus */
    setMode(S.compact);
    setInterval(clock12, 20000);
    W.addEventListener('resize', function () {
      clearTimeout(rsT);
      rsT = setTimeout(function () { if (measure() && S.lib && !S.ov) { render(snap() || { key: '', id: '' }); } else if (S.ov) { S.dirty = true; } lazySoon(); }, 150);
    }, false);
    D.addEventListener('keydown', onKey, false);
    D.addEventListener('keyup', function (e) {
      var a = KEY[e.keyCode];
      if (P.on && P.target != null && (a === 'l' || a === 'r' || a === 'ff' || a === 'rw')) { P.sn = 0; clearTimeout(P.seekT); P.seekT = setTimeout(commit, 250); }
    }, false);
    D.addEventListener('touchstart', function () { S.lastTouch = now(); setMode(true); }, false);
    D.addEventListener('click', function (e) {
      var f = fOf(e.target);
      if (dlg && e.target === $('dlg')) { dlgBack(); return; }
      if (f && contains(scope(), f)) { if (!S.touch) { focus(f, true); } activate(f); }
    }, false);
    /* pointer remotes and mice: hovering moves focus, but only on a real pointer move, never on scroll or a tap */
    D.addEventListener('mousemove', function (e) {
      var t = now(), f;
      if (S.touch || t - (S.lastTouch || 0) < 1000 || (e.clientX === S.mx && e.clientY === S.my)) { return; }
      S.mx = e.clientX; S.my = e.clientY;
      addC(HTML, 'ptr');
      if (S.ov === 'player') { osd(); } else if (S.ov === 'viewer') { vUi(); }
      if (t - lastMove < 60) { return; }
      lastMove = t; f = fOf(e.target);
      if (f && f !== cur && contains(scope(), f)) { focus(f, true); }
    }, false);
    /* Home has no native scrolling under a remote, so the wheel steps between rows */
    D.addEventListener('wheel', function (e) {
      var t = now(), ax = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (S.touch || S.ov || dlg || S.tab !== 'home' || !B) { return; }
      e.preventDefault();
      if (t - lastWheel < 260) { return; }
      lastWheel = t;
      move(ax ? (e.deltaX > 0 ? 'r' : 'l') : (e.deltaY > 0 ? 'd' : 'u'));
    }, { passive: false });
    page.addEventListener('scroll', lazySoon, false);
    W.addEventListener('hashchange', function () {
      /* our own hash updates already match the app state; only outside changes are routed */
      if (location.hash !== stateHash()) { route(); }
    }, false);
    W.addEventListener('pagehide', function () { if (P.on) { save(); } }, false);
    D.addEventListener('visibilitychange', function () { if (D.hidden && P.on) { save(); } else if (!D.hidden && !S.ov) { load(); } }, false);
    load();
  }
  init();
}());
