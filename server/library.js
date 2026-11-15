'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { extOf, kindOf, playability } = require('./formats');
const { run, limiter, isInside, writeFileAtomicSync } = require('./util');
const { folderProblem } = require('./config');
const { jpegOrientation } = require('./exif');

const MAX_DEPTH = 12;
const SKIP_DIR = /\.(photoslibrary|app|bundle|fcpbundle|imovielibrary|tvlibrary|musiclibrary)$/i;

// Our own half-written files (see upload and convert). Left behind only when HomeFlix was killed.
const TEMP_FILE = /^\.homeflix-(upload-[0-9a-f]+\.part|convert-[0-9a-f]+\.mp4)$/;
const TEMP_STALE_MS = 10 * 60 * 1000;

// A temp file nobody has written to for a while cannot belong to a running upload or conversion.
function removeIfStale(file, maxAgeMs) {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > (maxAgeMs === undefined ? TEMP_STALE_MS : maxAgeMs)) { fs.unlinkSync(file); return true; }
  } catch (e) { /* already gone */ }
  return false;
}

function idFor(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

function titleFor(file) {
  const i = file.lastIndexOf('.');
  const base = i > 0 ? file.slice(0, i) : file;
  return base.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim() || base;
}

class Library {
  constructor(opts) {
    this.paths = opts.paths;
    this.tools = opts.tools;
    this.getConfig = opts.getConfig;
    this.log = opts.log || function () {};
    this.index = new Map();          // id -> record
    this.generatedAt = Date.now();
    this.error = null;               // plain-language problem with a folder
    this.scanning = false;
    this.scanPromise = null;         // resolves when the folder walk of the current scan is done
    this.idlePromise = Promise.resolve();
    this.rescanQueued = false;
    this.closed = false;
    this.watchers = new Map();       // folder -> fs.FSWatcher
    this.watchTimer = null;
    this.recheckTimer = null;
    this.recheckMs = opts.recheckMs || 15000;
    this.onChange = opts.onChange || function () {};
    this.probeCacheFile = path.join(this.paths.cacheDir, 'index.json');
    this.probeCache = new Map();     // path -> { mtime, size, meta }
    this.probeLimit = limiter(2);
    this.loadProbeCache();
  }

  roots() {
    const cfg = this.getConfig();
    const out = [{ dir: cfg.libraryFolder, writable: true }];
    (cfg.extraFolders || []).forEach(function (d) {
      if (d !== cfg.libraryFolder) out.push({ dir: d, writable: false });
    });
    return out;
  }

  loadProbeCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.probeCacheFile, 'utf8'));
      if (raw && raw.v === 1 && raw.files) {
        Object.keys(raw.files).forEach((p) => { this.probeCache.set(p, raw.files[p]); });
      }
    } catch (e) { /* no cache yet */ }
  }

  saveProbeCache() {
    const files = {};
    this.index.forEach((rec) => {
      const c = this.probeCache.get(rec.path);
      if (c) files[rec.path] = c;
    });
    try { writeFileAtomicSync(this.probeCacheFile, JSON.stringify({ v: 1, files: files })); } catch (e) { /* cache is optional */ }
  }

  get(id) { return this.index.get(id) || null; }

  // ---- scanning ------------------------------------------------------------

  // Start (or join) a scan. The returned promise resolves once the folders have been walked
  // and the index swapped in; durations and sizes keep filling in afterwards (see whenIdle()).
  scan() {
    if (this.closed) return Promise.resolve();
    if (this.scanning) {
      this.rescanQueued = true;
      return this.scanPromise;
    }
    this.scanning = true;
    let walked;
    this.scanPromise = new Promise(function (resolve) { walked = resolve; });
    this.idlePromise = this.runScan(walked).catch((e) => {
      this.log('scan failed: ' + (e && e.message));
      walked();
    }).then(() => {
      this.scanning = false;
      if (this.rescanQueued && !this.closed) {
        this.rescanQueued = false;
        this.scan();
        return this.idlePromise;
      }
    });
    return this.scanPromise;
  }

  whenIdle() {
    const p = this.idlePromise;
    return p.then(() => (this.idlePromise === p ? undefined : this.whenIdle()));
  }

  async runScan(walked) {
    const roots = this.roots();
    const next = new Map();
    const problems = [];
    for (const root of roots) {
      const problem = folderProblem(root.dir);
      if (problem) {
        if (root.writable) {
          problems.unshift(problem === 'missing'
            ? 'Your library folder "' + root.dir + '" could not be found. Choose a library folder in Folders, or reconnect the drive it is on.'
            : 'HomeFlix cannot read your library folder "' + root.dir + '". Choose another folder in Folders, or allow access in System Settings > Privacy & Security > Files and Folders.');
        } else {
          problems.push('The extra folder "' + root.dir + '" could not be opened, so its videos and photos are hidden. Reconnect the drive it is on, or remove it in Folders.');
        }
        continue;
      }
      try {
        await this.walk(root, next);
      } catch (e) {
        problems.push('HomeFlix had trouble reading "' + root.dir + '". Check that the folder still exists, then press Rescan.');
      }
    }
    const pending = [];
    next.forEach((rec) => {
      const cached = this.probeCache.get(rec.path);
      if (cached && cached.mtime === rec.mtime && cached.size === rec.size && cached.meta) this.applyMeta(rec, cached.meta);
      else { this.applyMeta(rec, null); pending.push(rec); }
    });
    this.index = next;
    this.error = problems.length ? problems[0] : null;
    this.generatedAt = Date.now();
    walked();
    this.onChange();
    if (pending.length) {
      await this.probeAll(pending);
      this.generatedAt = Date.now();
      this.saveProbeCache();
      this.onChange();
    }
  }

  async walk(root, out) {
    const realRoot = await fsp.realpath(root.dir);
    const rootName = path.basename(root.dir) || root.dir;
    const seen = new Set();
    const self = this;
    async function visit(dir, depth) {
      let real;
      try { real = await fsp.realpath(dir); } catch (e) { return; }
      if (seen.has(real)) return;
      seen.add(real);
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (depth === 0) throw e; return; }
      const names = new Map();
      entries.forEach(function (e) { names.set(e.name.toLowerCase(), e.name); });
      for (const e of entries) {
        if (self.closed) return;
        if (e.name.startsWith('.')) {
          if (root.writable && e.isFile() && TEMP_FILE.test(e.name)) removeIfStale(path.join(dir, e.name));
          continue;
        }
        const p = path.join(dir, e.name);
        let isDir = e.isDirectory(), isFile = e.isFile(), st = null;
        if (e.isSymbolicLink()) {
          try {
            const target = await fsp.realpath(p);
            if (!isInside(realRoot, target)) continue; // never follow links out of the folder
            st = await fsp.stat(p);
            isDir = st.isDirectory(); isFile = st.isFile();
          } catch (err) { continue; }
        }
        if (isDir) {
          if (depth < MAX_DEPTH && !SKIP_DIR.test(e.name)) await visit(p, depth + 1);
          continue;
        }
        if (!isFile) continue;
        const ext = extOf(e.name);
        const kind = kindOf(ext);
        if (!kind) continue;
        if (!st) { try { st = await fsp.stat(p); } catch (err) { continue; } }
        const rec = self.makeRecord(p, root, rootName, st, names);
        if (!out.has(rec.id)) out.set(rec.id, rec);
      }
    }
    await visit(root.dir, 0);
  }

  makeRecord(p, root, rootName, st, siblingNames) {
    const file = path.basename(p);
    const ext = extOf(file);
    const kind = kindOf(ext);
    const dir = path.dirname(p);
    const rel = path.relative(root.dir, p).split(path.sep);
    const base = file.slice(0, file.length - ext.length - 1).toLowerCase();
    let subsPath = null;
    if (kind === 'video' && siblingNames) {
      const vtt = siblingNames.get(base + '.vtt'), srt = siblingNames.get(base + '.srt');
      for (const name of [vtt, srt]) {
        if (!name || subsPath) continue;
        const candidate = path.join(dir, name);
        try {
          // a subtitle "file" that is really a link to somewhere outside the folder does not count
          if (fs.statSync(candidate).isFile() && isInside(fs.realpathSync(root.dir), fs.realpathSync(candidate))) subsPath = candidate;
        } catch (e) { /* unreadable: no subtitles */ }
      }
    }
    return {
      id: idFor(p), kind: kind, title: titleFor(file), file: file,
      collection: rel.length > 1 ? rel[0] : rootName,
      ext: ext, size: st.size, mtime: Math.round(st.mtimeMs),
      duration: null, width: null, height: null,
      playable: 'yes', note: null,
      hasSubs: !!subsPath, writable: !!root.writable,
      path: p, dir: dir, subsPath: subsPath, meta: null
    };
  }

  applyMeta(rec, meta) {
    rec.meta = meta;
    if (meta) {
      rec.duration = typeof meta.duration === 'number' ? meta.duration : null;
      rec.width = meta.width || null;
      rec.height = meta.height || null;
    }
    if (rec.kind === 'video') {
      const p = playability(rec.ext, meta);
      rec.playable = p.playable;
      rec.note = p.note;
    } else {
      rec.playable = 'yes';
      rec.note = null;
    }
  }

  // ---- probing (duration, size, codecs) ------------------------------------

  remember(rec, meta) {
    this.applyMeta(rec, meta);
    this.probeCache.set(rec.path, { mtime: rec.mtime, size: rec.size, meta: meta });
  }

  async probeAll(recs) {
    const videos = recs.filter(function (r) { return r.kind === 'video'; });
    const photos = recs.filter(function (r) { return r.kind === 'photo'; });
    const jobs = [];
    if (this.tools.ffprobe) {
      videos.forEach((rec) => {
        jobs.push(this.probeLimit(async () => {
          if (this.closed) return;
          this.remember(rec, await this.probeVideo(rec.path));
        }));
      });
    }
    if (this.tools.sips) {
      for (let i = 0; i < photos.length; i += 40) {
        const batch = photos.slice(i, i + 40);
        jobs.push(this.probeLimit(async () => {
          if (this.closed) return;
          const dims = await this.probePhotos(batch.map(function (r) { return r.path; }));
          batch.forEach((rec) => { this.remember(rec, dims.get(rec.path) || {}); });
        }));
      }
    }
    await Promise.all(jobs);
  }

  async probeVideo(file) {
    const r = await run(this.tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const meta = {};
    if (r.code !== 0) return meta;
    try {
      const j = JSON.parse(r.stdout);
      const d = j.format && parseFloat(j.format.duration);
      if (d > 0) meta.duration = Math.round(d * 100) / 100;
      const streams = j.streams || [];
      const v = streams.find(function (s) { return s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic); });
      const a = streams.find(function (s) { return s.codec_type === 'audio'; });
      if (v) {
        meta.vcodec = v.codec_name || null;
        let w = v.width || null, h = v.height || null;
        const rot = Math.abs(parseInt((v.tags && v.tags.rotate) || ((v.side_data_list || []).find(function (s) { return s.rotation !== undefined; }) || {}).rotation || 0, 10));
        if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
        meta.width = w; meta.height = h;
        if (!meta.duration && parseFloat(v.duration) > 0) meta.duration = Math.round(parseFloat(v.duration) * 100) / 100;
      }
      if (a) meta.acodec = a.codec_name || null;
    } catch (e) { /* unreadable file: leave unknown */ }
    return meta;
  }

  // sips prints "<path>\n  pixelWidth: N\n  pixelHeight: N" per file.
  async probePhotos(files) {
    const out = new Map(), byName = new Map();
    const r = await run(this.tools.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight'].concat(files), { timeout: 60000 });
    let current = null;
    r.stdout.split('\n').forEach(function (line) {
      const m = /^\s+pixel(Width|Height):\s*(\d+)/.exec(line);
      if (m) {
        if (current) current[m[1] === 'Width' ? 'width' : 'height'] = parseInt(m[2], 10);
      } else if (line.startsWith('/')) {
        current = {};
        byName.set(line.trimEnd().normalize('NFC'), current);
      }
    });
    // sips prints names in decomposed Unicode ("e" + accent), the file system may store them composed.
    files.forEach(function (file) {
      const meta = byName.get(file.normalize('NFC'));
      if (meta) out.set(file, meta);
    });
    out.forEach(function (meta, file) {
      // Phone photos are often stored sideways with a "rotate me" flag: report the upright size.
      if (/\.jpe?g$/i.test(file) && meta.width && meta.height && jpegOrientation(file) >= 5) {
        const t = meta.width; meta.width = meta.height; meta.height = t;
      }
    });
    return out;
  }

  // ---- single-file changes (upload, convert, delete) -----------------------

  rootFor(file) {
    const roots = this.roots();
    for (const r of roots) if (isInside(r.dir, file)) return r;
    return null;
  }

  async addFile(file) {
    const root = this.rootFor(file);
    if (!root) return null;
    const st = await fsp.stat(file);
    let names = null;
    try {
      names = new Map();
      (await fsp.readdir(path.dirname(file))).forEach(function (n) { names.set(n.toLowerCase(), n); });
    } catch (e) { names = null; }
    const rec = this.makeRecord(file, root, path.basename(root.dir) || root.dir, st, names);
    if (!rec.kind) return null;
    this.applyMeta(rec, null);
    try {
      if (rec.kind === 'video' && this.tools.ffprobe) this.remember(rec, await this.probeVideo(file));
      else if (rec.kind === 'photo' && this.tools.sips) this.remember(rec, (await this.probePhotos([file])).get(file) || {});
    } catch (e) { /* details stay unknown */ }
    this.index.set(rec.id, rec);
    this.generatedAt = Date.now();
    this.onChange();
    return rec;
  }

  remove(id) {
    const rec = this.index.get(id);
    if (!rec) return;
    this.index.delete(id);
    this.probeCache.delete(rec.path);
    this.generatedAt = Date.now();
    this.onChange();
  }

  // ---- serving ---------------------------------------------------------------

  // The real location of a file we are about to send, or a reason not to send it.
  // Checked on every request: a file swapped for a link to somewhere else must never be served.
  async resolveInside(file) {
    let real;
    try {
      real = await fsp.realpath(file);
      if (!(await fsp.stat(real)).isFile()) return { problem: 'missing' };
    } catch (e) {
      return { problem: 'missing' };
    }
    for (const root of this.roots()) {
      try {
        if (isInside(await fsp.realpath(root.dir), real)) return { file: real };
      } catch (e) { /* that folder is gone */ }
    }
    return { problem: 'outside' };
  }

  // ---- watching ------------------------------------------------------------

  // Watch every folder that exists right now, and keep checking for folders that
  // appear later (a drive plugged back in) or disappear.
  watch() {
    this.unwatch();
    if (this.closed) return;
    this.syncWatchers(false);
    this.recheckTimer = setInterval(() => this.syncWatchers(true), this.recheckMs);
    if (this.recheckTimer.unref) this.recheckTimer.unref();
  }

  syncWatchers(rescanOnChange) {
    if (this.closed) return;
    let changed = false;
    const wanted = new Set(this.roots().map(function (r) { return r.dir; }));
    this.watchers.forEach((w, dir) => {
      if (!wanted.has(dir) || folderProblem(dir)) {
        try { w.close(); } catch (e) { /* ignore */ }
        this.watchers.delete(dir);
        changed = true;
      }
    });
    wanted.forEach((dir) => {
      if (this.watchers.has(dir) || folderProblem(dir)) return;
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (event, filename) => {
          if (filename) {
            const parts = String(filename).split(path.sep);
            if (parts.some(function (s) { return s.startsWith('.'); })) return; // our own temp files, .DS_Store
          }
          this.scheduleScan();
        });
        w.on('error', () => {
          try { w.close(); } catch (e) { /* ignore */ }
          if (this.watchers.get(dir) === w) this.watchers.delete(dir);
          this.scheduleScan();
        });
        this.watchers.set(dir, w);
        changed = true;
      } catch (e) { /* tried again on the next check */ }
    });
    if (changed && rescanOnChange) this.scan();
  }

  scheduleScan() {
    if (this.closed) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => { this.watchTimer = null; this.scan(); }, 1000);
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  unwatch() {
    this.watchers.forEach(function (w) { try { w.close(); } catch (e) { /* ignore */ } });
    this.watchers.clear();
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null; }
    if (this.recheckTimer) { clearInterval(this.recheckTimer); this.recheckTimer = null; }
  }

  close() {
    this.closed = true;
    this.unwatch();
  }

  // ---- views ---------------------------------------------------------------

  counts() {
    let videos = 0, photos = 0, bytes = 0;
    this.index.forEach(function (r) { if (r.kind === 'video') videos++; else photos++; bytes += r.size; });
    return { videos: videos, photos: photos, bytes: bytes };
  }

  toItem(rec, progress) {
    return {
      id: rec.id, kind: rec.kind, title: rec.title, file: rec.file, collection: rec.collection,
      ext: rec.ext, size: rec.size, mtime: rec.mtime,
      duration: rec.kind === 'video' ? rec.duration : null,
      width: rec.width, height: rec.height,
      playable: rec.playable, note: rec.note, hasSubs: rec.hasSubs, writable: rec.writable,
      src: '/media/' + rec.id, thumb: '/thumb/' + rec.id + '?v=' + rec.mtime,
      progress: rec.kind === 'video' && progress ? progress.get(rec.id) : null
    };
  }

  snapshot(name, version, progress) {
    const all = [];
    this.index.forEach((rec) => { all.push(this.toItem(rec, progress)); });
    all.sort(function (a, b) { return b.mtime - a.mtime || a.title.localeCompare(b.title) || a.id.localeCompare(b.id); });
    const videos = all.filter(function (i) { return i.kind === 'video'; });
    const photos = all.filter(function (i) { return i.kind === 'photo'; });
    const byName = new Map();
    all.forEach(function (i) {
      let c = byName.get(i.collection);
      if (!c) { c = { name: i.collection, videos: 0, photos: 0 }; byName.set(i.collection, c); }
      if (i.kind === 'video') c.videos++; else c.photos++;
    });
    const collections = Array.from(byName.values()).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
    const continueWatching = videos.filter(function (i) { return i.progress; })
      .sort(function (a, b) { return b.progress.updatedAt - a.progress.updatedAt; }).slice(0, 20);
    return {
      name: name, version: version, generatedAt: this.generatedAt,
      videos: videos, photos: photos, collections: collections,
      continueWatching: continueWatching, recent: all.slice(0, 20)
    };
  }
}

module.exports = { Library, idFor, titleFor, TEMP_FILE, removeIfStale };
