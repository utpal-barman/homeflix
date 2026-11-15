/* HomeFlix TV app. ES5 only: runs on old Tizen / webOS / Android TV browsers. */
(function () {
  'use strict';
  var D = document, W = window;
  var S = { lib: null, sig: '', tab: 'home', ov: null, dirty: false, imgs: [], rem: 16, reduce: false, col: {}, colNames: [], byId: {} };
  var KEY = { 37: 'l', 38: 'u', 39: 'r', 40: 'd', 13: 'ok', 8: 'back', 27: 'back', 461: 'back', 10009: 'back',
    415: 'play', 19: 'pause', 10252: 'pp', 32: 'pp', 413: 'stop', 417: 'ff', 412: 'rw' };
  var ICON = {
    play: 'M7 4v16l13-8z', pause: 'M6 4h4.5v16H6zM13.5 4H18v16h-4.5z',
    rw: 'M11.5 18V6L3 12zM21 18V6l-8.5 6z', ff: 'M12.5 6v12l8.5-6zM3 6v12l8.5-6z',
    re: 'M5 5h2.5v14H5zM9 12l10 7V5z', prev: 'M15.5 4l-8 8 8 8 1.6-1.6L10.7 12l6.4-6.4z', next: 'M8.5 4l8 8-8 8-1.6-1.6L13.3 12 6.9 5.6z'
  };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var cur = null, page, view, vid, dlg = null, G = null, pollT = 0, lazyT = 0, cdT = 0, lastMove = 0;
  var P = { on: false, it: null, target: null, sn: 0 };
  var V = { on: false, list: [], i: 0, top: 0, play: false, timer: 0, uiT: 0 };

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

  function req(method, url, body, cb) {
    var x = new XMLHttpRequest(), done = false, t;
    function fin(err, res) { if (!done) { done = true; clearTimeout(t); if (cb) { cb(err, res); } } }
    try {
      x.open(method, url, true);
      x.onreadystatechange = function () {
        var r = null;
        if (x.readyState !== 4) { return; }
        if (x.status >= 200 && x.status < 300) {
          if (x.responseText) { try { r = JSON.parse(x.responseText); } catch (e) { fin('bad'); return; } }
          fin(null, r);
        } else { fin(x.status || 'net'); }
      };
      t = setTimeout(function () { fin('timeout'); try { x.abort(); } catch (e) {} }, 10000);
      if (body) { x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(body)); } else { x.send(null); }
    } catch (e2) { fin('net'); }
  }

  /* ---------- focus and spatial navigation ----------
     A zone is an element whose direct children are the focusable (.f) items.
     _row zones are single lines with focus memory; others wrap like a grid. */
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
  function reveal(el, jump) {
    var z = el.parentNode, H = page.clientHeight, t, st;
    if (!contains(page, el)) { return; }
    if (z._top) { tween(page, 'scrollTop', 0, jump); return; }
    if (z._row) {
      tween(z, 'scrollLeft', el.offsetLeft - 6 * S.rem, jump);
      tween(page, 'scrollTop', z.parentNode.offsetTop - 7 * S.rem, jump);
    } else {
      /* grids scroll only as far as needed to keep the focused tile inside a comfortable band */
      t = el.offsetTop; st = page._to != null ? page._to : page.scrollTop;
      if (t - st < 9 * S.rem) { st = t < 16 * S.rem ? 0 : t - 9 * S.rem; }
      else if (t + el.offsetHeight - st > H - 6 * S.rem) { st = t + el.offsetHeight - H + 6 * S.rem; }
      tween(page, 'scrollTop', st, jump);
    }
  }
  function focus(el, still, jump) {
    if (!el) { return; }
    if (cur && cur !== el) { rmC(cur, 'focus'); }
    cur = el; addC(el, 'focus');
    el.parentNode._mem = el;
    if (el._cap) { txt($('pcap'), typeof el._cap === 'function' ? el._cap() : el._cap); }
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
    if (!cur || !contains(scope(), cur)) { focus(defFocus()); return; }
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
  function defFocus() {
    var zs = zones(scope()), i;
    for (i = 0; i < zs.length; i++) { if (zs[i].id !== 'tabs') { return zs[i]._mem && isF(zs[i]._mem) ? zs[i]._mem : edge(zs[i]); } }
    return $('t-' + S.tab);
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
    if (cur) { rmC(cur, 'focus'); }
    cur = null;
    focus(t || defFocus(), false, true);
  }

  /* ---------- lazy images: load near the viewport, unload far away ---------- */
  function lazy() {
    var H = page.clientHeight, Wd = page.clientWidth, m = H * 0.5, i, im, r, near;
    if (S.ov) { return; }
    for (i = 0; i < S.imgs.length; i++) {
      im = S.imgs[i];
      r = im.parentNode.getBoundingClientRect();
      near = r.bottom > -m && r.top < H + m && r.right > -Wd * 0.4 && r.left < Wd * 1.4;
      if (near && !im._on) { im._on = 1; im.src = im._src; }
      else if (!near && im._on) { im._on = 0; im.removeAttribute('src'); rmC(im, 'on'); }
    }
    if (G && page.scrollTop + H * 2.5 > page.scrollHeight) { gridMore(); }
  }
  function lazySoon() { if (!lazyT) { lazyT = setTimeout(function () { lazyT = 0; lazy(); }, 140); } }
  function art(it, cls, src) {
    var a = h('div', cls), im = D.createElement('img');
    im.className = 'im'; im.alt = ''; im._src = src || it.thumb;
    im.onload = function () { addC(im, 'on'); };
    im.onerror = function () { rmC(im, 'on'); };
    a.appendChild(im); S.imgs.push(im);
    return a;
  }

  /* ---------- library ---------- */
  function signature(l) {
    var a = l.videos.concat(l.photos), s = [l.name, a.length], i, p;
    for (i = 0; i < a.length; i++) { p = a[i].progress; s.push(a[i].id + a[i].mtime + a[i].playable + (p ? Math.round(p.position) : '')); }
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
        ['Check that the Mac is awake, HomeFlix is switched on, and this TV is on the same Wi-Fi.'], 'off', 'Try now', load);
      cur = null; focus(defFocus(), true);
    }
    st = $('cd');
    function tick() {
      if (st) { txt(st, n > 0 ? 'Trying again in ' + plural(n, 'second') : 'Trying now…'); }
      if (n-- <= 0) { clearInterval(cdT); load(); }
    }
    tick(); cdT = setInterval(tick, 1000);
  }

  /* ---------- browse screens ---------- */
  function sub(it) {
    var p = it.progress;
    if (p && p.duration) { return span(p.duration - p.position) + ' left'; }
    return it.collection;
  }
  function card(it, list, big, th) {
    var c, a, p, b, r;
    if (it.kind === 'photo') {
      r = it.width && it.height ? it.width / it.height : 1.34;
      c = art(it, 'tile f');
      c.style.width = (th * Math.max(0.7, Math.min(1.8, r))).toFixed(2) + 'rem';
    } else {
      c = h('div', 'card f' + (big ? ' big' : ''));
      a = art(it, 'art'); p = it.progress;
      if (p && p.duration) { b = h('div', 'bar'); b.appendChild(h('i')).style.width = Math.min(100, p.position / p.duration * 100) + '%'; a.appendChild(b); }
      if (it.playable === 'no') { a.appendChild(h('span', 'tag', 'Can\'t play on TV')); }
      else if (it.duration) { a.appendChild(h('span', 'dur', clock(it.duration))); }
      c.appendChild(a); c.appendChild(h('div', 'ttl', it.title)); c.appendChild(h('div', 'sub', sub(it)));
    }
    c._id = it.id;
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
  function row(key, title, items, big, tab) {
    var sec = h('div', 'row'), tr = h('div', 'track zone'), i, m, n = Math.min(items.length, 24);
    sec.appendChild(h('h2', 'rt', title));
    tr._key = key; tr._row = 1; tr.onscroll = lazySoon;
    for (i = 0; i < n; i++) { tr.appendChild(card(items[i], items, big, 11.25)); }
    if (items.length > n) {
      m = h('div', 'card f more'); m.appendChild(h('div', 'art', 'See all ' + items.length));
      m._id = 'more'; m._act = function () { showTab(tab); };
      tr.appendChild(m);
    }
    tr.appendChild(h('i', 'end'));
    sec.appendChild(tr);
    return sec;
  }
  function hero(it) {
    var he = h('div', 'hero'), bg = h('div', 'hbg'), tx = h('div', 'htx'), z = h('div', 'hbtn zone'), p = it.progress, vdo = it.kind === 'video', m, b, t;
    bg.style.backgroundImage = 'url(' + it.thumb + ')';
    he.appendChild(bg); he.appendChild(h('div', 'hsh'));
    he.appendChild(art(it, 'hscr', vdo ? it.thumb : '/photo/' + it.id + '?w=960'));
    tx.appendChild(h('div', 'mic', p ? 'Continue watching' : vdo ? 'Newest video' : 'Newest photo'));
    t = h('h1', it.title.length > 34 ? 'long' : '', it.title); tx.appendChild(t);
    m = h('div', 'hmeta');
    if (p && p.duration) { m.appendChild(h('span', 'left', span(p.duration - p.position) + ' left')); }
    m.appendChild(h('span', '', it.collection));
    if (vdo && it.duration) { m.appendChild(h('span', '', span(it.duration))); }
    if (!vdo) { m.appendChild(h('span', '', day(it.mtime))); }
    tx.appendChild(m);
    if (p && p.duration) { b = h('div', 'hbar'); b.appendChild(h('i')).style.width = (p.position / p.duration * 100) + '%'; tx.appendChild(b); }
    z._key = 'hero'; z._row = 1; z._top = 1;
    if (!vdo) { z.appendChild(button('View photo', 'play', function () { openItem(it, S.lib.photos); }, true)); }
    else if (p && it.playable !== 'no') {
      z.appendChild(button('Resume', 'play', function () { startPlayer(it, p.position); }, true, 'play'));
      z.appendChild(button('Start over', 'restart', function () { startPlayer(it, 0); }));
    } else { z.appendChild(button('Play', 'play', function () { playFlow(it); }, true, 'play')); }
    tx.appendChild(z); he.appendChild(tx);
    return he;
  }
  function renderHome() {
    var l = S.lib, f = l.continueWatching[0], i, c, items, name;
    for (i = 0; !f && i < l.videos.length; i++) { if (l.videos[i].playable !== 'no') { f = l.videos[i]; } }
    f = f || l.videos[0] || l.photos[0];
    view.appendChild(hero(f));
    if (l.continueWatching.length) { view.appendChild(row('cw', 'Continue watching', l.continueWatching, true, 'videos')); }
    if (l.recent.length) { view.appendChild(row('recent', 'Recently added', l.recent, false, 'videos')); }
    for (i = 0; i < S.colNames.length; i++) {
      name = S.colNames[i]; c = S.col[name]; items = c.v.concat(c.p);
      view.appendChild(row('c:' + name, name, items, false, c.v.length ? 'videos' : 'photos'));
    }
    if (l.photos.length) { view.appendChild(row('photos', 'Photos', l.photos, false, 'photos')); }
  }
  function gridMore() {
    var n = 0, bl, t;
    if (!G) { return false; }
    while (n < 48 && G.b < G.blocks.length) {
      bl = G.blocks[G.b];
      if (!G.el) {
        if (bl.title) { t = h('h2', 'rt gh', bl.title); t.appendChild(h('small', '', plural(bl.items.length, 'photo'))); view.appendChild(t); }
        G.el = h('div', 'grid zone'); G.el._key = 'g:' + bl.title; view.appendChild(G.el);
      }
      if (G.i < bl.items.length) { G.el.appendChild(card(bl.items[G.i++], bl.list, false, 13)); n++; G.n++; }
      else { G.b++; G.i = 0; G.el = null; }
    }
    if (n) { lazySoon(); }
    return n > 0;
  }
  function renderGrid(photos) {
    var l = S.lib, items = photos ? l.photos : l.videos, t, i, c, all = [];
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
    if (!photos) { G.blocks.push({ title: '', items: items, list: items }); }
    else {
      for (i = 0; i < S.colNames.length; i++) { c = S.col[S.colNames[i]].p; if (c.length) { all = all.concat(c); G.blocks.push({ title: S.colNames[i], items: c, list: all }); } }
      for (i = 0; i < G.blocks.length; i++) { G.blocks[i].list = all; }
    }
    gridMore();
  }
  function state(label, title, lines, pic, btn, fn) {
    var s = h('div', 'state'), tx = h('div', 'tx'), p = h('div', 'pic'), i, z;
    G = null; S.imgs = []; view.innerHTML = '';
    /* a laptop and a TV; the link between them is lit when connected */
    p.innerHTML = '<svg viewBox="0 0 320 180"><path d="M20 70h84v54H20zM10 130h104v8H10z M196 40h114v78H196zM232 128h42v8h-42z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>' +
      (pic === 'off' ? '<path class="lit" d="M124 96h14M150 96h8M172 96h14M149 84l14 24M163 84l-14 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
        : '<path class="lit" d="M124 96h14M148 96h14M172 96h14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>') + '</svg>';
    s.appendChild(p);
    tx.appendChild(h('div', 'mic', label)); tx.appendChild(h('h1', '', title));
    for (i = 0; i < lines.length; i++) { tx.appendChild(h('p', '', lines[i])); }
    p = h('p', 'dim'); p.id = 'cd'; tx.appendChild(p);
    if (btn) { z = h('div', 'hbtn zone'); z._row = 1; z._top = 1; z._key = 'state'; z.appendChild(button(btn, 'b', fn, true)); tx.appendChild(z); }
    s.appendChild(tx); view.appendChild(s);
  }
  function render(keep) {
    var l = S.lib, n = G ? G.n : 0, i, tabs = ['home', 'videos', 'photos'];
    if (!l) { return; }
    for (i = 0; i < 3; i++) { setC($('t-' + tabs[i]), 'act', tabs[i] === S.tab); }
    $('tabs')._mem = $('t-' + S.tab);
    S.dirty = false; S.imgs = []; G = null; view.innerHTML = '';
    if (!l.videos.length && !l.photos.length) {
      state(l.name || 'HomeFlix', 'Nothing to watch yet',
        ['On your Mac, open HomeFlix and drag videos or photos into the Library.', 'They will appear here by themselves. There is no need to reload this page.'], 'on');
      txt($('cd'), 'Looking for new videos and photos every few seconds.');
    } else if (S.tab === 'home') { renderHome(); }
    else { renderGrid(S.tab === 'photos'); while (keep && G && G.n < n && gridMore()) { /* re-grow to where the user was */ } }
    if (keep) { restore(keep); } else { if (cur) { rmC(cur, 'focus'); } cur = null; page.scrollTop = 0; page._to = 0; focus(defFocus(), false, true); }
    lazy();
  }
  function setHash(hs) { if (location.hash !== hs) { location.hash = hs; } }
  function stateHash() { return S.ov === 'player' ? '#/play/' + P.it.id : S.ov === 'viewer' ? '#/photo/' + V.list[V.i].id : '#/' + S.tab; }
  function showTab(name) {
    S.tab = name; setHash('#/' + name);
    render(null);
    if (name === 'home') { load(); }
  }
  function route() {
    var m = /^#\/(\w+)(?:\/(\w+))?/.exec(location.hash) || [], it = S.byId[m[2]];
    if (!S.lib) { return; }
    if (dlg) { closeDlg(); }
    if (S.ov === 'player') { closePlayer(); } else if (S.ov === 'viewer') { closeViewer(); }
    if (m[1] === 'play' && it && it.kind === 'video') { playFlow(it); }
    else if (m[1] === 'photo' && it && it.kind === 'photo') { openItem(it, S.lib.photos); }
    else if ((m[1] === 'videos' || m[1] === 'photos' || m[1] === 'home') && m[1] !== S.tab) { S.tab = m[1]; render(null); }
  }
  function openItem(it, list) { if (it.kind === 'photo') { openViewer(it, list); } else { playFlow(it); } }
  function browseKey(a) {
    var hb;
    if (a === 'back') {
      if (S.tab !== 'home') { showTab('home'); return; }
      hb = defFocus();
      if (hb && hb !== cur) { focus(hb); }
      return;
    }
    if (a === 'ok' || a === 'play' || a === 'pp') { if (cur && contains(page, cur)) { activate(cur); } else { focus(defFocus()); } return; }
    if (a.length === 1) { move(a); }
  }

  /* ---------- dialog ---------- */
  function dialog(o) {
    var d = $('dlg'), box = h('div', 'box'), z = h('div', 'hbtn zone'), i;
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
    if (cur) { rmC(cur, 'focus'); } cur = null;
    if (p && contains(D.body, p)) { focus(p, true); }
  }
  function dlgKey(a) {
    var b = dlg.back;
    if (a === 'back') { closeDlg(); if (b) { b(); } }
    else if (a === 'ok') { activate(cur); }
    else if (a === 'l' || a === 'r') { move(a); }
  }

  /* ---------- player ---------- */
  function playFlow(it) {
    var p = it.progress;
    if (it.playable === 'no') {
      dialog({ label: 'Can\'t play on this TV', title: it.title,
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
    var tr, pr;
    if (!P.on) { P.ret = snap(); }
    P.on = true; P.it = it; P.resume = pos || 0; P.target = null; P.sn = 0; P.started = false;
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
    vid.src = it.src;
    try { vid.load(); pr = vid.play(); if (pr && pr.then) { pr.then(function () {}, function () {}); } } catch (e) {}
    draw(P.resume);
    clearInterval(P.saveT);
    P.saveT = setInterval(function () { if (!vid.paused) { save(); } }, 10000);
    if (cur) { rmC(cur, 'focus'); } cur = null;
    $('pbtns')._mem = $('b-pp');
    /* free decoded thumbnails while a video plays; the screen is rebuilt on the way back */
    for (tr = 0; tr < S.imgs.length; tr++) { if (S.imgs[tr]._on) { S.imgs[tr]._on = 0; S.imgs[tr].removeAttribute('src'); } }
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
    P.on = false; P.done = false; P.it = null;
    clearInterval(P.saveT); clearTimeout(P.osdT); clearTimeout(P.seekT);
    try { vid.pause(); } catch (e) {}
    while (vid.firstChild) { vid.removeChild(vid.firstChild); }
    vid.removeAttribute('src');
    try { vid.load(); } catch (e2) {}
    $('player').className = 'layer';
    S.ov = null; rmC(page, 'off');
    setHash('#/' + S.tab);
    render(P.ret);
    load();
  }
  function draw(t) {
    var d = dur(), f = d ? Math.max(0, Math.min(1, t / d)) * 100 : 0;
    $('pfill').style.width = f + '%'; $('pknob').style.left = f + '%'; $('ptip').style.left = Math.max(2.6, Math.min(97.4, f)) + '%';
    txt($('pcur'), clock(t)); txt($('prem'), d ? '-' + clock(d - t) : '');
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
    /* holding the key accelerates: 10s steps, then 30s, 60s, 2 min */
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
    var it = P.it, c = vid.error ? vid.error.code : 0, at = vid.currentTime || P.resume || 0, msg;
    if (!P.on || !it) { return; }
    function show(m) {
      if (!P.on || P.it !== it) { return; }
      rmC($('player'), 'busy');
      dialog({ label: 'Playback problem', title: P.started ? 'This video stopped playing' : 'This video won\'t play', lines: [m, c !== 2 ? it.note : null],
        btns: [['Try again', function () { startPlayer(it, at); }], ['Back', closePlayer]], back: closePlayer });
    }
    if (c === 1) { return; }
    if (c === 3) { msg = 'The TV could not read part of this video. The file may be damaged, or it uses a format this TV does not support. On your Mac, open HomeFlix and choose Convert for this video.'; }
    else { msg = 'This TV can\'t play this video file (.' + it.ext + '). It may use a format the TV does not support, or the file may be damaged. On your Mac, open HomeFlix and check this video. Converting it to MP4 usually fixes it.'; }
    if (at > 1) { save(at); }
    /* an unreachable Mac also shows up as "unsupported", so check the connection before blaming the file */
    req('GET', '/api/ping', null, function (err) {
      show(err || c === 2 ? 'The connection to your Mac dropped. Check that the Mac is awake and on the same Wi-Fi as this TV, then try again.' : msg);
    });
  }
  function initPlayer() {
    var pp = $('b-pp'), bar = $('pbar');
    function on(ev, fn) { vid.addEventListener(ev, fn, false); }
    function btn(id, icon, cap, fn) { var b = $(id); if (icon) { b.innerHTML = svg(icon); } b._cap = cap; b._act = fn; }
    $('pbz')._row = 1; $('pbtns')._row = 1;
    bar._cap = 'Left and right skip 10 seconds. Hold to go faster.';
    bar._act = toggle;
    btn('b-rw', 'rw', 'Back 10 seconds', function () { seek(-1); P.sn = 0; });
    btn('b-ff', 'ff', 'Forward 10 seconds', function () { seek(1); P.sn = 0; });
    btn('b-pp', 'pause', function () { return vid.paused ? 'Play' : 'Pause'; }, toggle);
    btn('b-re', 're', 'Start over', function () { P.target = 0; commit(); });
    btn('b-cc', '', function () { return P.subs ? 'Subtitles are on' : 'Subtitles are off'; }, function () {
      P.subs = !P.subs; applySubs(); txt($('pcap'), $('b-cc')._cap());
      try { W.localStorage.setItem('hf-subs', P.subs ? '1' : '0'); } catch (e) {}
    });
    try { P.subs = W.localStorage.getItem('hf-subs') !== '0'; } catch (e) { P.subs = true; }
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
    vid.onclick = function () { if (hasC($('player'), 'osd')) { toggle(); } osd(); };
    bar.onclick = function (e) {
      var r = bar.getBoundingClientRect(), d = dur();
      if (d) { P.target = Math.max(0, Math.min(d - 2, (e.clientX - r.left) / r.width * d)); commit(); }
    };
  }

  /* ---------- photo viewer: two cross-fading layers, current +/- 1 preloaded ---------- */
  function purl(it) { return '/photo/' + it.id + '?w=' + S.pw; }
  function openViewer(it, list) {
    var i, ph = [];
    for (i = 0; i < list.length; i++) { if (list[i].kind === 'photo') { ph.push(list[i]); } }
    V.list = ph; V.i = 0;
    for (i = 0; i < ph.length; i++) { if (ph[i] === it) { V.i = i; } }
    V.on = true; V.play = false; V.top = 0; V.ret = cur;
    S.ov = 'viewer'; addC(page, 'off'); $('viewer').className = 'layer on';
    vShow(V.i); vUi();
  }
  function vUi() {
    addC($('viewer'), 'ui');
    clearTimeout(V.uiT);
    V.uiT = setTimeout(function () { rmC($('viewer'), 'ui'); }, 3000);
  }
  function vShow(i) {
    var it = V.list[i], im = new Image(), el = $('viewer'), bar = $('vbar'), m = $('vmeta');
    V.i = i; V.load = im;
    clearTimeout(V.timer);
    setHash('#/photo/' + it.id);
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
      if (!ok) { txt($('vmsg'), 'This photo could not be loaded. Press right for the next one.'); }
      b.style.backgroundImage = ok ? 'url(' + im.src + ')' : 'none';
      addC(b, 'on'); rmC(a, 'on'); V.top = V.top ? 0 : 1;
      setTimeout(function () { if (!hasC(a, 'on')) { a.style.backgroundImage = 'none'; } }, 700);
      /* keep only the neighbours warm */
      V.pn = V.list[i + 1] ? new Image() : null; if (V.pn) { V.pn.src = purl(V.list[i + 1]); }
      V.pp = V.list[i - 1] ? new Image() : null; if (V.pp) { V.pp.src = purl(V.list[i - 1]); }
      if (V.play) {
        bar.offsetWidth; addC(bar, 'run');
        V.timer = setTimeout(function () { vShow((V.i + 1) % V.list.length); }, 5000);
      }
    }
    im.onload = function () { done(true); };
    im.onerror = function () { done(false); };
    im.src = purl(it);
  }
  function vStep(d) { var n = V.i + d; if (n >= 0 && n < V.list.length) { vShow(n); } else { vUi(); } }
  function vSlide(on) {
    V.play = on; setC($('viewer'), 'ss', on);
    clearTimeout(V.timer); rmC($('vbar'), 'run');
    txt($('vhint'), on ? 'OK pauses the slideshow.' : 'OK starts the slideshow. Up shows details.');
    if (on && !V.load) { $('vbar').offsetWidth; addC($('vbar'), 'run'); V.timer = setTimeout(function () { vShow((V.i + 1) % V.list.length); }, 5000); }
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
    setHash('#/' + S.tab);
    if (S.dirty) { render({ key: V.ret && V.ret.parentNode._key, id: it.id }); return; }
    /* land on the photo that was showing, when it is in the row or grid we came from */
    z = V.ret && contains(page, V.ret) ? V.ret.parentNode : null;
    for (n = z && z.firstChild; n; n = n.nextSibling) { if (isF(n) && n._id === it.id) { t = n; } }
    cur = null; focus(t || (z ? V.ret : defFocus()), false, true); lazy();
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
    var el = $('viewer'), x0 = null;
    $('vprev').innerHTML = svg('prev'); $('vnext').innerHTML = svg('next');
    $('vprev').onclick = function (e) { e.stopPropagation(); vStep(-1); vUi(); };
    $('vnext').onclick = function (e) { e.stopPropagation(); vStep(1); vUi(); };
    el.onclick = function () { if (hasC(el, 'ui')) { vSlide(!V.play); } else { vUi(); } };
    el.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, false);
    el.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - x0;
      if (x0 != null && Math.abs(dx) > 60) { vStep(dx < 0 ? 1 : -1); e.preventDefault(); }
      x0 = null;
    }, false);
  }

  /* ---------- input ---------- */
  function onKey(e) {
    var a = KEY[e.keyCode];
    if (!a || e.ctrlKey || e.metaKey || e.altKey) { return; }
    e.preventDefault();
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
  function resize() {
    var w = W.innerWidth || D.documentElement.clientWidth, px = w * (W.devicePixelRatio || 1);
    S.rem = Math.max(8, w / 120);
    D.documentElement.style.fontSize = S.rem + 'px';
    S.pw = px > 2000 ? 2560 : px > 1300 ? 1920 : 1280;
    lazySoon();
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
    resize(); initPlayer(); initViewer(); clock12();
    setInterval(clock12, 20000);
    W.addEventListener('resize', resize, false);
    D.addEventListener('keydown', onKey, false);
    D.addEventListener('keyup', function (e) {
      var a = KEY[e.keyCode];
      if (P.on && P.target != null && (a === 'l' || a === 'r' || a === 'ff' || a === 'rw')) { P.sn = 0; clearTimeout(P.seekT); P.seekT = setTimeout(commit, 250); }
    }, false);
    D.addEventListener('click', function (e) {
      var f = fOf(e.target);
      if (f && contains(scope(), f)) { focus(f, true); activate(f); }
    }, false);
    /* pointer remotes: hovering moves focus, but only on a real pointer move, never on scroll */
    D.addEventListener('mousemove', function (e) {
      var t = now(), f;
      if (S.ov === 'player') { osd(); } else if (S.ov === 'viewer') { vUi(); }
      if (t - lastMove < 60) { return; }
      lastMove = t; f = fOf(e.target);
      if (f && f !== cur && contains(scope(), f)) { focus(f, true); }
    }, false);
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
