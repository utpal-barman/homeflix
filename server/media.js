'use strict';
// Lazy, cached thumbnails and resized photos.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { run, limiter } = require('./util');
const { PHOTO } = require('./formats');
const { jpegOrientation, resetJpegOrientation } = require('./exif');

const THUMB_SIZES = [480, 960, 1280];
const PHOTO_WIDTHS = [640, 1280, 1920, 2560, 3840];
const QUICKLOOK_TIMEOUT_MS = 5000;
const RETRY_AFTER_MS = 10 * 60 * 1000;

function exists(file) {
  try { return fs.statSync(file).size > 0; } catch (e) { return false; }
}

function placeholderSvg(rec) {
  const video = !rec || rec.kind === 'video';
  const label = rec && rec.ext ? String(rec.ext).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  const icon = video
    ? '<circle cx="240" cy="122" r="34" fill="none" stroke="#ffb454" stroke-width="4"/><path d="M230 104l30 18-30 18z" fill="#ffb454"/>'
    : '<rect x="200" y="92" width="80" height="60" rx="8" fill="none" stroke="#ffb454" stroke-width="4"/><circle cx="222" cy="112" r="6" fill="#ffb454"/><path d="M206 146l22-22 14 14 12-10 20 18z" fill="#ffb454"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" width="480" height="270">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#211e2b"/><stop offset="1" stop-color="#15131c"/></linearGradient>' +
    '<radialGradient id="b" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffb454" stop-opacity="0.18"/><stop offset="1" stop-color="#ffb454" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="480" height="270" fill="url(#g)"/><rect width="480" height="270" fill="url(#b)"/>' + icon +
    (label ? '<text x="240" y="196" text-anchor="middle" font-family="-apple-system, \'Helvetica Neue\', \'Segoe UI\', Roboto, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="3" fill="#a39fb0">' + label + '</text>' : '') +
    '</svg>';
}

class Media {
  constructor(opts) {
    this.tools = opts.tools;
    this.cacheDir = opts.cacheDir;
    this.thumbDir = path.join(opts.cacheDir, 'thumbs');
    this.photoDir = path.join(opts.cacheDir, 'photos');
    this.tmpDir = path.join(opts.cacheDir, 'tmp');
    this.thumbLimit = limiter(2);   // contract: at most 2 thumbnail jobs at once
    this.photoLimit = limiter(2);
    this.quickLookLimit = limiter(1);
    this.inflight = new Map();      // cache file -> promise
    this.failed = new Map();        // cache file -> time of last failure
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true }); // leftovers from a crash
      [this.thumbDir, this.photoDir, this.tmpDir].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
    } catch (e) { /* caching is optional: everything falls back to placeholders/originals */ }
  }

  tmp(ext) {
    return path.join(this.tmpDir, crypto.randomBytes(8).toString('hex') + ext);
  }

  // Run `make(tmpFile)` once per cache file; resolves the cache file path or null.
  cached(file, limit, make) {
    if (exists(file)) return Promise.resolve(file);
    const failedAt = this.failed.get(file);
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
    let p = this.inflight.get(file);
    if (p) return p;
    p = limit(async () => {
      if (exists(file)) return file;
      const tmp = this.tmp('.jpg');
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.mkdir(this.tmpDir, { recursive: true });
        const ok = await make(tmp);
        if (!ok || !exists(tmp)) throw new Error('nothing produced');
        this.dropOldVersions(file);
        await fsp.rename(tmp, file);
        this.failed.delete(file);
        return file;
      } catch (e) {
        this.failed.set(file, Date.now());
        fsp.unlink(tmp).catch(function () {});
        return null;
      }
    }).then((r) => { this.inflight.delete(file); return r; }, () => { this.inflight.delete(file); return null; });
    this.inflight.set(file, p);
    return p;
  }

  // Remove cache files for the same item made from an older version of the file.
  dropOldVersions(file) {
    const dir = path.dirname(file), id = path.basename(file).slice(0, 12), stamp = path.basename(file).split(/[-.]/)[1];
    try {
      fs.readdirSync(dir).forEach(function (n) {
        const parts = n.split(/[-.]/);
        // older file version, or the pre-sizes naming "<id>-<mtime>.jpg"
        if (n.startsWith(id + '-') && (parts[1] !== stamp || parts.length === 3)) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ } }
      });
    } catch (e) { /* ignore */ }
  }

  forget(rec) {
    [this.thumbDir, this.photoDir].forEach(function (dir) {
      try {
        fs.readdirSync(dir).forEach(function (n) {
          if (n.startsWith(rec.id + '-')) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ } }
        });
      } catch (e) { /* ignore */ }
    });
  }

  // ---- sips ----------------------------------------------------------------

  // Longest side of the stored image, 0 when unknown.
  async dims(rec, file) {
    if (rec.meta && rec.width && rec.height) return Math.max(rec.width, rec.height);
    const r = await run(this.tools.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 20000 });
    const w = /pixelWidth:\s*(\d+)/.exec(r.stdout), h = /pixelHeight:\s*(\d+)/.exec(r.stdout);
    return w && h ? Math.max(+w[1], +h[1]) : 0;
  }

  // Convert `src` to an upright JPEG at `dest` whose longer side is at most `max`.
  async toJpeg(src, dest, longest, max, quality) {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality)];
    if (!longest || longest > max) args.push('-Z', String(max)); // -Z would also enlarge small images
    args.push(src, '--out', dest);
    const r = await run(this.tools.sips, args, { timeout: 60000 });
    if (r.code !== 0 || !exists(dest)) return false;
    // sips keeps the "stored sideways" flag instead of turning the pixels; old TV browsers ignore the flag.
    const o = jpegOrientation(dest);
    if (o > 1) {
      const steps = { 2: [['-f', 'horizontal']], 3: [['-r', '180']], 4: [['-f', 'vertical']], 5: [['-f', 'horizontal'], ['-r', '270']], 6: [['-r', '90']], 7: [['-f', 'horizontal'], ['-r', '90']], 8: [['-r', '270']] }[o] || [];
      for (const step of steps) {
        const rr = await run(this.tools.sips, step.concat(['-s', 'formatOptions', String(quality), dest]), { timeout: 60000 });
        if (rr.code !== 0) return true; // keep the unrotated image rather than nothing
      }
      resetJpegOrientation(dest);
    }
    return true;
  }

  // ---- thumbnails ----------------------------------------------------------

  // `file` is the checked, real location of the item; `size` one of THUMB_SIZES.
  thumb(rec, size, file) {
    const out = path.join(this.thumbDir, rec.id + '-' + rec.mtime + '-' + size + '.jpg');
    let limit = this.thumbLimit;
    if (rec.kind === 'video' && !this.tools.ffmpeg) {
      // Quick Look can be slow on broken files: let it use one of the two slots at most.
      limit = (fn) => this.quickLookLimit(() => this.thumbLimit(fn));
    }
    return this.cached(out, limit, (tmp) => (rec.kind === 'video' ? this.videoThumb(rec, file, size, tmp) : this.photoThumb(rec, file, size, tmp)));
  }

  async photoThumb(rec, file, size, tmp) {
    if (!this.tools.sips) return false;
    return this.toJpeg(file, tmp, await this.dims(rec, file), size, size > 480 ? 84 : 80);
  }

  async videoThumb(rec, file, size, tmp) {
    if (this.tools.ffmpeg) {
      // Longest side at most `size`, never enlarged, even dimensions.
      const scale = "scale='if(gte(iw,ih),trunc(min(" + size + ",iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(" + size + ",ih)/2)*2)'";
      const at = rec.duration > 0 ? rec.duration * 0.1 : 3;
      for (const t of at > 0.5 ? [at, 0] : [0]) {
        await run(this.tools.ffmpeg, ['-nostdin', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', file, '-an', '-sn', '-frames:v', '1',
          '-vf', scale, '-q:v', size > 480 ? '3' : '5', '-f', 'image2', '-y', tmp], { timeout: 20000 });
        if (exists(tmp)) return true;
      }
      return false; // a file ffmpeg cannot read is not worth a second, slower attempt
    }
    if (this.tools.qlmanage && this.tools.sips) {
      const dir = this.tmp('');
      try {
        await fsp.mkdir(dir, { recursive: true });
        await run(this.tools.qlmanage, ['-t', '-s', String(size), '-o', dir, file], { timeout: QUICKLOOK_TIMEOUT_MS });
        const png = (await fsp.readdir(dir)).find(function (n) { return /\.png$/i.test(n); });
        if (!png) return false;
        return await this.toJpeg(path.join(dir, png), tmp, 0, size, 80);
      } finally {
        fsp.rm(dir, { recursive: true, force: true }).catch(function () {});
      }
    }
    return false;
  }

  // ---- full-size photos for the TV ------------------------------------------

  // Resolves { file, type } to send, or null when nothing usable can be produced.
  async photo(rec, w, file) {
    const native = PHOTO[rec.ext] && PHOTO[rec.ext].native;
    const original = { file: file, type: PHOTO[rec.ext] ? PHOTO[rec.ext].mime : 'application/octet-stream', original: true };
    if (rec.ext === 'gif') return original; // keep animations moving
    if (!this.tools.sips) return native ? original : null;
    const out = path.join(this.photoDir, rec.id + '-' + rec.mtime + '-' + w + '.jpg');
    const made = await this.cached(out, this.photoLimit, async (tmp) => this.toJpeg(file, tmp, await this.dims(rec, file), w, 88));
    if (made) return { file: made, type: 'image/jpeg' };
    return native ? original : null;
  }
}

// Snap a requested size up to the nearest allowed one (the largest when it asks for more).
function snap(value, sizes, fallback) {
  const n = parseInt(value, 10);
  if (!(n > 0)) return fallback;
  for (const s of sizes) if (n <= s) return s;
  return sizes[sizes.length - 1];
}

function thumbSize(value) { return snap(value, THUMB_SIZES, THUMB_SIZES[0]); }
function photoWidth(value) { return snap(value, PHOTO_WIDTHS, 1920); }

module.exports = { Media, placeholderSvg, thumbSize, photoWidth, THUMB_SIZES, PHOTO_WIDTHS };
