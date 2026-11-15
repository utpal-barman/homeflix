'use strict';
// HomeFlix: control server (loopback) + TV server (LAN). See docs/ARCHITECTURE.md.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const { resolvePaths } = require('./paths');
const { ConfigStore, validatePatch } = require('./config');
const { detectTools } = require('./tools');
const { Library } = require('./library');
const { Media, placeholderSvg } = require('./media');
const { Jobs } = require('./jobs');
const { ProgressStore } = require('./progress');
const { NetInfo, isPrivateAddress, isLoopback, stripMapped, listAddresses } = require('./netinfo');
const { srtToVtt } = require('./subs');
const { qrSvg } = require('./qr');
const { STATIC_MIME, extOf, kindOf, mimeOf } = require('./formats');
const util = require('./util');
const { sendJson, sendError, sendEmpty, sendFile, readJsonBody, HttpError, run, isInside, sanitiseName } = util;

const VERSION = require('../package.json').version;
const DEFAULT_CONTROL_PORT = 7788;
const PORT_TRIES = 20;
const CLIENT_TTL_MS = 2 * 60 * 1000;
const ID_RE = /^[0-9a-f]{12}$/;
const LOCAL_HOSTS = { 'localhost': 1, '127.0.0.1': 1, '[::1]': 1 };

function missingPage(what) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HomeFlix</title>' +
    '<style>html,body{height:100%;margin:0}body{background:#0b0a0f;color:#f4f1ea;font-family:-apple-system,"SF Pro Display","Helvetica Neue","Segoe UI",Roboto,Arial,sans-serif;display:table;width:100%}' +
    'div{display:table-cell;vertical-align:middle;text-align:center;padding:24px}h1{font-size:28px;font-weight:800;letter-spacing:6px;margin:0 0 20px}h1 span{color:#ffb454}p{color:#a39fb0;font-size:18px;line-height:1.5;margin:8px 0}</style></head>' +
    '<body><div><h1>HOME<span>FLIX</span></h1><p>HomeFlix is running, but its ' + what + ' files are missing.</p>' +
    '<p>Download HomeFlix again and replace the whole folder, then open it once more.</p></div></body></html>';
}

// Split and validate a request path. Returns null for anything suspicious.
function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl[0] !== '/') return null;
  const qi = rawUrl.indexOf('?');
  const rawPath = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch (e) { return null; }
  if (decoded.indexOf('\0') !== -1 || decoded.indexOf('\\') !== -1) return null;
  if (/%(2e|2f|5c|00)/i.test(decoded)) return null; // double-encoded dots and slashes
  const parts = decoded.split('/').slice(1);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..' || parts[i] === '.') return null;
    if (parts[i] === '' && i < parts.length - 1) return null; // "//": never a real address here
  }
  return {
    pathname: decoded,
    segments: parts.filter(function (s) { return s !== ''; }),
    query: new URLSearchParams(qi === -1 ? '' : rawUrl.slice(qi + 1))
  };
}

// Wait for a promise, but no longer than `ms` (the work carries on in the background).
function within(promise, ms) {
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, ms);
    const done = function () { clearTimeout(timer); resolve(); };
    Promise.resolve(promise).then(done, done);
  });
}

function listen(handler, port, host) {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on('connection', function (s) { sockets.add(s); s.on('close', function () { sockets.delete(s); }); });
    server.once('error', reject);
    server.listen(port, host, function () {
      server.removeListener('error', reject);
      server.on('error', function () {});
      resolve({
        server: server,
        port: server.address().port,
        close: function () {
          return new Promise(function (done) {
            server.close(function () { done(); });
            sockets.forEach(function (s) { s.destroy(); });
          });
        }
      });
    });
  });
}

function createApp(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const log = opts.log || function () {};
  const paths = resolvePaths(env);
  const tools = opts.tools || detectTools(env);
  const config = new ConfigStore(paths);
  const progress = new ProgressStore(paths.progressFile);
  const library = new Library({ paths: paths, tools: tools, getConfig: function () { return config.get(); }, log: log });
  const media = new Media({ tools: tools, cacheDir: paths.cacheDir });
  const jobs = new Jobs({ tools: tools, library: library, getConfig: function () { return config.get(); }, log: log });
  const net = new NetInfo();
  const tvHost = opts.tvHost || env.HOMEFLIX_BIND || '0.0.0.0';
  const clients = new Map();

  let control = null;         // { server, port, close }
  let tv = null;
  let tvStarting = null;
  let tvError = null;
  let firstScan = null;
  let closed = false;
  let qrCache = { url: null, svg: null };
  let picker = null;

  // ---- things that touch the Mac's UI (replaceable in tests) -----------------

  const ui = Object.assign({
    async trash(file) {
      if (paths.trashDir) { // HOMEFLIX_HOME is set: keep away from the real Trash
        await fsp.mkdir(paths.trashDir, { recursive: true });
        await fsp.rename(file, util.uniquePath(paths.trashDir, path.basename(file)));
        return true;
      }
      const r = await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', '--', file], { timeout: 20000 });
      if (r.code === 0 && !fs.existsSync(file)) return true;
      try { // Finder would not do it (for example the permission prompt was declined): move it ourselves
        const dir = path.join(os.homedir(), '.Trash');
        await fsp.rename(file, util.uniquePath(dir, path.basename(file)));
        return true;
      } catch (e) {
        return false;
      }
    },
    async reveal(target, isFile) {
      const r = await run('/usr/bin/open', isFile ? ['-R', target] : [target], { timeout: 10000 });
      return r.code === 0;
    },
    async chooseFolder() {
      const r = await run('/usr/bin/osascript', ['-e', 'tell me to activate', '-e', 'return POSIX path of (choose folder with prompt "Choose a folder for HomeFlix")'], { timeout: 10 * 60 * 1000 });
      const out = r.stdout.trim();
      if (r.code !== 0 || !out) return null;
      return out.length > 1 ? out.replace(/\/+$/, '') : out;
    }
  }, opts.ui || {});

  // ---- status ----------------------------------------------------------------

  function activeClients() {
    const now = Date.now(), out = [];
    clients.forEach(function (c, addr) {
      if (now - c.lastSeen > CLIENT_TTL_MS) clients.delete(addr);
      else out.push({ address: addr, lastSeen: c.lastSeen, userAgent: c.userAgent });
    });
    out.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
    return out;
  }

  async function status() {
    const cfg = config.get();
    if (!net.lastRefresh) await within(net.refresh(), 1500);
    else net.refresh();
    const addrs = listAddresses();
    const port = tv ? tv.port : cfg.port;
    const address = addrs.length ? addrs[0].address : null;
    const url = address ? 'http://' + address + ':' + port : null;
    const altUrls = addrs.slice(1).map(function (a) { return 'http://' + a.address + ':' + port; });
    if (address && net.localHostName) altUrls.push('http://' + net.localHostName + '.local:' + port);
    if (url && qrCache.url !== url) {
      try { qrCache = { url: url, svg: qrSvg(url) }; } catch (e) { qrCache = { url: url, svg: null }; }
    }
    return {
      name: cfg.name, version: VERSION,
      running: !!tv, port: port,
      address: address, url: url, altUrls: altUrls,
      wifiName: net.wifiName,
      qrSvg: url ? qrCache.svg : null,
      config: config.public(),
      counts: library.counts(),
      tools: { ffmpeg: !!tools.ffmpeg, sips: !!tools.sips },
      scanning: library.scanning,
      clients: tv ? activeClients() : [],
      error: tvError || library.error || null
    };
  }

  // ---- TV server -------------------------------------------------------------

  function startTv() {
    if (tv) return Promise.resolve();
    if (tvStarting) return tvStarting;
    tvStarting = (async function () {
      const base = config.get().port;
      let got = null;
      for (let i = 0; i <= PORT_TRIES && !got; i++) {
        const port = base + i;
        if (port > 65535) break;
        if (control && port === control.port) continue;
        try {
          got = await listen(wrap(handleTv), port, tvHost);
        } catch (e) {
          if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
            tvError = 'HomeFlix could not start the TV server. Close HomeFlix, open it again and switch it on once more.';
            throw new HttpError(500, 'start_failed', tvError);
          }
        }
      }
      if (!got) {
        tvError = 'Port ' + base + ' and the ' + PORT_TRIES + ' after it are all being used by other apps. Choose a different port in Settings (for example 8888), then switch on again.';
        throw new HttpError(409, 'port_in_use', tvError);
      }
      if (closed) { await got.close(); return; }
      tv = got;
      tvError = null;
      log('tv server on port ' + tv.port);
    })();
    const p = tvStarting;
    const clear = function () { if (tvStarting === p) tvStarting = null; };
    p.then(clear, clear);
    return p;
  }

  async function stopTv() {
    if (tvStarting) { try { await tvStarting; } catch (e) { /* nothing to stop */ } }
    const t = tv;
    tv = null;
    clients.clear();
    if (t) await t.close();
  }

  // ---- request plumbing --------------------------------------------------------

  function wrap(handler) {
    return function (req, res) {
      Promise.resolve().then(function () { return handler(req, res); }).catch(function (e) {
        if (e instanceof HttpError) return sendError(req, res, e.status, e.code, e.message);
        log('request failed: ' + (e && e.stack || e));
        if (res.headersSent) return res.destroy();
        sendError(req, res, 500, 'server_error', 'Something went wrong inside HomeFlix. Try again. If it keeps happening, close HomeFlix and open it again.');
      });
    };
  }

  function notFound(req, res) {
    sendError(req, res, 404, 'not_found', 'HomeFlix could not find that. It may have been moved or deleted.');
  }

  function wrongMethod(req, res, allow) {
    sendError(req, res, 405, 'method_not_allowed', 'HomeFlix cannot do that here.', { Allow: allow });
  }

  function isRead(req) { return req.method === 'GET' || req.method === 'HEAD'; }

  async function record(id) {
    if (!ID_RE.test(id)) return null;
    if (firstScan) await firstScan;
    return library.get(id);
  }

  function serveStatic(req, res, root, segments, what) {
    const plain = function (status, text) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD');
    if (segments.some(function (s) { return s.startsWith('.'); })) return plain(404, 'Not found');
    let file = path.join.apply(path, [root].concat(segments));
    if (!isInside(root, file)) return plain(404, 'Not found');
    let st = null;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); }
      if (!st.isFile()) throw new Error('not a file');
      if (!isInside(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('outside');
    } catch (e) {
      const last = segments.length ? segments[segments.length - 1] : '';
      if (last.indexOf('.') !== -1) return plain(404, 'Not found');
      // Page-like address: hand over the app itself (it routes with #hashes).
      file = path.join(root, 'index.html');
      try { st = fs.statSync(file); if (!st.isFile()) throw new Error('missing'); } catch (e2) {
        const html = Buffer.from(missingPage(what));
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
    }
    sendFile(req, res, file, { stat: st, type: STATIC_MIME[extOf(path.basename(file))] || 'application/octet-stream', cache: 'no-cache' });
  }

  // ---- media endpoints (both servers) ------------------------------------------

  // Returns true when the request was a media endpoint (handled or rejected).
  async function handleMedia(req, res, u) {
    const seg = u.segments;
    const p = '/' + seg.join('/');

    if (p === '/api/ping') {
      if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD'), true;
      return sendJson(req, res, 200, { ok: true, name: config.get().name, version: VERSION }), true;
    }

    if (p === '/api/library') {
      if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD'), true;
      if (firstScan) await firstScan;
      return sendJson(req, res, 200, library.snapshot(config.get().name, VERSION, progress)), true;
    }

    if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'progress') {
      if (req.method !== 'PUT' && req.method !== 'DELETE') return wrongMethod(req, res, 'PUT, DELETE'), true;
      const rec = await record(seg[2]);
      if (!rec || rec.kind !== 'video') return req.resume(), notFound(req, res), true;
      if (req.method === 'DELETE') { req.resume(); progress.clear(rec.id); return sendEmpty(res, 204), true; }
      const body = await readJsonBody(req, 16 * 1024);
      const position = body.position, duration = body.duration;
      if (typeof position !== 'number' || !isFinite(position) || position < 0 ||
          (duration !== undefined && duration !== null && (typeof duration !== 'number' || !isFinite(duration) || duration < 0))) {
        throw new HttpError(400, 'bad_request', 'HomeFlix could not save your place in this video.');
      }
      progress.set(rec.id, position, duration > 0 ? duration : (rec.duration || 0));
      return sendEmpty(res, 204), true;
    }

    if (seg.length === 2 && (seg[0] === 'media' || seg[0] === 'thumb' || seg[0] === 'photo' || seg[0] === 'subs')) {
      if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD'), true;
      let id = seg[1];
      if (seg[0] === 'subs') {
        if (!/\.vtt$/.test(id)) return notFound(req, res), true;
        id = id.slice(0, -4);
      }
      const rec = await record(id);
      if (!rec) return notFound(req, res), true;

      if (seg[0] === 'media') {
        return sendFile(req, res, rec.path, { type: mimeOf(rec.ext), cache: 'no-cache' }), true;
      }

      if (seg[0] === 'thumb') {
        const file = await media.thumb(rec);
        if (file) return sendFile(req, res, file, { type: 'image/jpeg', cache: 'max-age=86400' }), true;
        const svg = Buffer.from(placeholderSvg(rec));
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': svg.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : svg), true;
      }

      if (seg[0] === 'photo') {
        if (rec.kind !== 'photo') return notFound(req, res), true;
        let w = parseInt(u.query.get('w'), 10);
        if (!(w > 0)) w = 1920;
        w = Math.max(320, Math.min(3840, w));
        const out = await media.photo(rec, w);
        if (!out) return sendError(req, res, 415, 'cannot_convert', 'This photo is in a format the TV cannot show, and it could not be converted on this Mac.'), true;
        return sendFile(req, res, out.file, { type: out.type, cache: out.original ? 'no-cache' : 'max-age=86400' }), true;
      }

      // subs
      if (!rec.subsPath) return notFound(req, res), true;
      let buf;
      try {
        const st = await fsp.stat(rec.subsPath);
        if (st.size > 8 * 1024 * 1024) throw new Error('too big');
        buf = await fsp.readFile(rec.subsPath);
      } catch (e) { return notFound(req, res), true; }
      const vtt = /\.srt$/i.test(rec.subsPath) ? Buffer.from(srtToVtt(buf)) : buf;
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': vtt.length, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : vtt), true;
    }

    return false;
  }

  // ---- TV server handler -------------------------------------------------------

  async function handleTv(req, res) {
    const remote = req.socket.remoteAddress || '';
    if (!isPrivateAddress(remote)) {
      req.resume();
      return sendError(req, res, 403, 'forbidden', 'HomeFlix only works on your home network. Connect this device to the same Wi-Fi as the Mac.');
    }
    if (!isLoopback(remote)) {
      clients.set(stripMapped(remote), { lastSeen: Date.now(), userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });
    }
    const u = parseUrl(req.url);
    if (!u) { req.resume(); return sendError(req, res, 400, 'bad_path', 'That address is not valid.'); }
    if (await handleMedia(req, res, u)) return;
    req.resume();
    if (u.segments[0] === 'api') return notFound(req, res);
    if (u.segments[0] === 'shared') return serveStatic(req, res, path.join(paths.webRoot, 'shared'), u.segments.slice(1), 'shared');
    return serveStatic(req, res, path.join(paths.webRoot, 'tv'), u.segments, 'TV app');
  }

  // ---- control server handler --------------------------------------------------

  function hostOf(value) {
    const h = String(value || '').toLowerCase();
    return h.replace(/:\d+$/, '');
  }

  async function handleControl(req, res) {
    // Only this Mac's own browser may talk to the control server (blocks other sites and DNS tricks).
    if (!LOCAL_HOSTS[hostOf(req.headers.host)]) {
      req.resume();
      return sendError(req, res, 403, 'forbidden', 'Open the HomeFlix control panel at http://localhost:' + (control ? control.port : DEFAULT_CONTROL_PORT) + ' on this Mac.');
    }
    if (!isRead(req) && req.headers.origin !== undefined) {
      let ok = false;
      try { ok = !!LOCAL_HOSTS[new URL(req.headers.origin).hostname.toLowerCase()]; } catch (e) { ok = false; }
      if (!ok) {
        req.resume();
        return sendError(req, res, 403, 'forbidden', 'Only the HomeFlix control panel on this Mac can change things.');
      }
    }
    const u = parseUrl(req.url);
    if (!u) { req.resume(); return sendError(req, res, 400, 'bad_path', 'That address is not valid.'); }
    if (await handleMedia(req, res, u)) return;
    const seg = u.segments;
    if (seg[0] === 'api') return handleAdmin(req, res, u);
    req.resume();
    if (seg[0] === 'shared') return serveStatic(req, res, path.join(paths.webRoot, 'shared'), seg.slice(1), 'shared');
    if (seg[0] === 'tv') {
      if (seg.length === 1 && !u.pathname.endsWith('/')) { res.writeHead(302, { Location: '/tv/', 'Cache-Control': 'no-cache' }); return res.end(); }
      return serveStatic(req, res, path.join(paths.webRoot, 'tv'), seg.slice(1), 'TV app');
    }
    if (seg.length === 1 && seg[0] === 'favicon.ico' && !fs.existsSync(path.join(paths.webRoot, 'admin', 'favicon.ico'))) {
      return serveStatic(req, res, path.join(paths.webRoot, 'shared'), ['logo.svg'], 'shared');
    }
    return serveStatic(req, res, path.join(paths.webRoot, 'admin'), seg, 'control panel');
  }

  async function handleAdmin(req, res, u) {
    const seg = u.segments;
    const p = '/' + seg.join('/');
    const m = req.method;

    if (p === '/api/upload') {
      if (m !== 'POST') return req.resume(), wrongMethod(req, res, 'POST');
      return handleUpload(req, res, u);
    }

    if (p === '/api/status') {
      req.resume();
      if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD');
      return sendJson(req, res, 200, await status());
    }

    if (p === '/api/server/start' || p === '/api/server/stop' || p === '/api/rescan') {
      req.resume();
      if (m !== 'POST') return wrongMethod(req, res, 'POST');
      if (p === '/api/server/start') await startTv();
      else if (p === '/api/server/stop') await stopTv();
      else await within(library.scan(), 8000);
      return sendJson(req, res, 200, await status());
    }

    if (p === '/api/config') {
      if (m !== 'PUT') return req.resume(), wrongMethod(req, res, 'PUT');
      const body = await readJsonBody(req);
      const result = validatePatch(body, { controlPort: control ? control.port : 0 });
      if (result.error) throw new HttpError(400, result.code, result.error);
      const before = config.public();
      const after = config.update(result.value);
      const foldersChanged = before.libraryFolder !== after.libraryFolder || before.extraFolders.join('\n') !== after.extraFolders.join('\n');
      if (foldersChanged) {
        library.watch();
        await within(library.scan(), 8000);
      }
      if (before.port !== after.port) {
        tvError = null;
        if (tv) {
          await stopTv();
          try { await startTv(); } catch (e) { /* reported in status.error, running: false */ }
        }
      }
      return sendJson(req, res, 200, await status());
    }

    if (p === '/api/folders/choose') {
      req.resume();
      if (m !== 'POST') return wrongMethod(req, res, 'POST');
      if (!picker) {
        picker = Promise.resolve().then(function () { return ui.chooseFolder(); });
        const clear = function () { picker = null; };
        picker.then(clear, clear);
      }
      let chosen = null;
      try { chosen = await picker; } catch (e) { chosen = null; }
      return sendJson(req, res, 200, chosen ? { path: chosen } : { cancelled: true });
    }

    if (p === '/api/folders/reveal') {
      if (m !== 'POST') return req.resume(), wrongMethod(req, res, 'POST');
      const body = await readJsonBody(req);
      let target = null, isFile = false;
      if (typeof body.id === 'string') {
        const rec = await record(body.id);
        if (!rec) return notFound(req, res);
        target = rec.path; isFile = true;
      } else if (typeof body.path === 'string') {
        const cfg = config.get();
        const wanted = path.resolve(body.path);
        if (wanted !== cfg.libraryFolder && cfg.extraFolders.indexOf(wanted) === -1) {
          throw new HttpError(400, 'not_a_library_folder', 'HomeFlix can only open folders that are part of your library.');
        }
        target = wanted;
      } else {
        throw new HttpError(400, 'bad_request', 'HomeFlix did not know which folder to open.');
      }
      if (!fs.existsSync(target)) throw new HttpError(404, 'not_found', 'That folder or file is no longer there. It may have been moved or deleted.');
      const ok = await ui.reveal(target, isFile);
      if (!ok) throw new HttpError(500, 'reveal_failed', 'Finder could not be opened. Open Finder yourself and go to ' + target + '.');
      return sendEmpty(res, 204);
    }

    if (p === '/api/jobs') {
      req.resume();
      if (!isRead(req)) return wrongMethod(req, res, 'GET, HEAD');
      return sendJson(req, res, 200, { jobs: jobs.list() });
    }

    if (seg.length === 3 && seg[1] === 'jobs') {
      req.resume();
      if (m !== 'DELETE') return wrongMethod(req, res, 'DELETE');
      if (!jobs.remove(seg[2])) return notFound(req, res);
      return sendEmpty(res, 204);
    }

    if (seg.length === 3 && seg[1] === 'items') {
      req.resume();
      if (m !== 'DELETE') return wrongMethod(req, res, 'DELETE');
      const rec = await record(seg[2]);
      if (!rec) return notFound(req, res);
      if (!rec.writable || !isInside(config.get().libraryFolder, rec.path)) {
        throw new HttpError(403, 'read_only', 'This file lives in one of your extra folders, which HomeFlix never changes. Delete it in Finder instead.');
      }
      if (fs.existsSync(rec.path)) {
        let ok = false;
        try { ok = await ui.trash(rec.path); } catch (e) { ok = false; }
        if (!ok) throw new HttpError(500, 'trash_failed', 'HomeFlix could not move this file to the Trash. Use "Show in Finder" and move it to the Trash there.');
      }
      progress.clear(rec.id);
      media.forget(rec);
      library.remove(rec.id);
      return sendEmpty(res, 204);
    }

    if (seg.length === 4 && seg[1] === 'items' && seg[3] === 'convert') {
      req.resume();
      if (m !== 'POST') return wrongMethod(req, res, 'POST');
      const rec = await record(seg[2]);
      if (!rec) return notFound(req, res);
      if (rec.kind !== 'video') throw new HttpError(400, 'not_a_video', 'Only videos can be converted.');
      if (!tools.ffmpeg) throw new HttpError(501, 'no_ffmpeg', 'Converting needs a free helper called ffmpeg, which is not installed on this Mac. See Help for how to add it.');
      if (!fs.existsSync(rec.path)) return notFound(req, res);
      return sendJson(req, res, 202, { job: jobs.public(jobs.add(rec)) });
    }

    req.resume();
    return notFound(req, res);
  }

  // ---- upload ------------------------------------------------------------------

  async function handleUpload(req, res, u) {
    const refuse = function (status, code, message) { req.resume(); sendError(req, res, status, code, message); };
    const name = sanitiseName(u.query.get('name'));
    if (!name) return refuse(400, 'bad_name', 'That file needs a name. Rename it on your Mac and try again.');
    const ext = extOf(name);
    if (!ext || !kindOf(ext)) {
      return refuse(415, 'unsupported_type', (ext ? '.' + ext + ' files' : 'Files without an ending like .mp4') + ' are not supported. HomeFlix takes videos (MP4, MOV, MKV and more) and photos (JPG, PNG, HEIC and more).');
    }
    let collection = '';
    const rawCollection = u.query.get('collection');
    if (rawCollection !== null && rawCollection.trim() !== '') {
      collection = sanitiseName(rawCollection);
      if (!collection) return refuse(400, 'bad_name', 'That collection name cannot be used. Try a simple name like "Holidays".');
    }
    const lib = config.get().libraryFolder;
    try {
      if (!fs.statSync(lib).isDirectory()) throw new Error('not a folder');
    } catch (e) {
      return refuse(500, 'no_library_folder', 'Your library folder could not be found, so there is nowhere to put this file. Choose a library folder in Folders first.');
    }
    const declared = parseInt(req.headers['content-length'], 10);
    if (declared > 0 && fsp.statfs) {
      try {
        const s = await fsp.statfs(lib);
        if (declared > s.bavail * s.bsize) return refuse(507, 'disk_full', 'There is not enough free space on your Mac for this file. Free up some space and try again.');
      } catch (e) { /* cannot tell: let the copy decide */ }
    }
    const destDir = collection ? path.join(lib, collection) : lib;
    if (!isInside(lib, destDir)) return refuse(400, 'bad_name', 'That collection name cannot be used. Try a simple name like "Holidays".');
    const tmp = path.join(destDir, '.homeflix-upload-' + crypto.randomBytes(8).toString('hex') + '.part');
    const removeTmp = function () { fs.unlink(tmp, function () {}); };
    try {
      await fsp.mkdir(destDir, { recursive: true });
    } catch (e) {
      return refuse(500, 'upload_failed', 'HomeFlix could not write to your library folder. Check that you are allowed to save files there.');
    }
    let received = 0;
    req.on('data', function (c) { received += c.length; });
    try {
      await new Promise(function (resolve, reject) {
        pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' }), function (err) { if (err) reject(err); else resolve(); });
      });
    } catch (e) {
      removeTmp();
      if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) return refuse(507, 'disk_full', 'Your Mac ran out of space while copying this file. Free up some space and try again.');
      if (res.destroyed || req.destroyed || (e && (e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET'))) return res.destroy(); // upload cancelled
      return refuse(500, 'upload_failed', 'The file could not be copied into your library. Try again.');
    }
    if (received === 0) {
      removeTmp();
      return sendError(req, res, 400, 'empty_file', 'That file is empty, so there is nothing to add.');
    }
    // Move into place without ever overwriting: "name.mp4", then "name (2).mp4", ...
    let final = null;
    for (let tries = 0; tries < 50 && !final; tries++) {
      const candidate = util.uniquePath(destDir, name);
      try {
        await fsp.link(tmp, candidate);
        removeTmp();
        final = candidate;
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        try { if (!fs.existsSync(candidate)) { await fsp.rename(tmp, candidate); final = candidate; } } catch (e2) { break; }
      }
    }
    if (!final) {
      removeTmp();
      return sendError(req, res, 500, 'upload_failed', 'The file could not be saved into your library. Try again.');
    }
    const rec = await library.addFile(final);
    if (!rec) return sendError(req, res, 500, 'upload_failed', 'The file was copied but HomeFlix could not read it back. Press Rescan.');
    sendJson(req, res, 201, { item: library.toItem(rec, progress) });
  }

  // ---- lifecycle ---------------------------------------------------------------

  async function start() {
    const wanted = opts.controlPort === undefined || opts.controlPort === null ? DEFAULT_CONTROL_PORT : opts.controlPort;
    for (let i = 0; i <= (wanted === 0 ? 0 : PORT_TRIES) && !control; i++) {
      try {
        control = await listen(wrap(handleControl), wanted === 0 ? 0 : wanted + i, '127.0.0.1');
      } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      }
    }
    if (!control) {
      const err = new Error('HomeFlix could not start because ports ' + wanted + ' to ' + (wanted + PORT_TRIES) + ' are all in use. Restart your Mac and try again.');
      err.code = 'NO_PORT';
      throw err;
    }
    control.server.requestTimeout = 0; // uploads of big files take a while
    firstScan = library.scan();
    library.watch();
    net.refresh(true);
    if (opts.serve || config.get().autoStart) {
      try { await startTv(); } catch (e) { /* shown in status.error */ }
    }
    return app;
  }

  async function close() {
    if (closed) return;
    closed = true;
    library.close();
    jobs.close();
    progress.flush();
    const waits = [];
    if (tvStarting) { try { await tvStarting; } catch (e) { /* ignore */ } }
    if (tv) { waits.push(tv.close()); tv = null; }
    if (control) { waits.push(control.close()); }
    await Promise.all(waits);
    util.killAllChildren();
  }

  const app = {
    version: VERSION, paths: paths, tools: tools, config: config, library: library, progress: progress, jobs: jobs, media: media,
    start: start, close: close, status: status, startTv: startTv, stopTv: stopTv,
    get controlPort() { return control ? control.port : null; },
    get tvPort() { return tv ? tv.port : null; },
    get running() { return !!tv; },
    _handleTv: handleTv, _clients: clients
  };
  return app;
}

module.exports = { createApp, parseUrl, DEFAULT_CONTROL_PORT, VERSION };
