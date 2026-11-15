'use strict';
// Lazy, cached thumbnails and resized photos.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { run, limiter } = require('./util');
const { PHOTO } = require('./formats');
const { jpegOrientation, resetJpegOrientation } = require('./exif');

const THUMB_SIZE = 480;
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
        if (n.startsWith(id + '-') && n.split(/[-.]/)[1] !== stamp) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ } }
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

  async dims(rec) {
    if (rec.meta && rec.width && rec.height) {
      // rec.width/height are upright; sips works on the stored (unrotated) pixels, but only the longer side matters here.
      return Math.max(rec.width, rec.height);
    }
    const r = await run(this.tools.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', rec.path], { timeout: 20000 });
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

  thumb(rec) {
    const file = path.join(this.thumbDir, rec.id + '-' + rec.mtime + '.jpg');
    return this.cached(file, this.thumbLimit, (tmp) => (rec.kind === 'video' ? this.videoThumb(rec, tmp) : this.photoThumb(rec, tmp)));
  }

  async photoThumb(rec, tmp) {
    if (!this.tools.sips) return false;
    return this.toJpeg(rec.path, tmp, await this.dims(rec), THUMB_SIZE, 80);
  }

  async videoThumb(rec, tmp) {
    if (this.tools.ffmpeg) {
      const at = rec.duration > 0 ? rec.duration * 0.1 : 3;
      for (const t of at > 0.5 ? [at, 0] : [0]) {
        await run(this.tools.ffmpeg, ['-nostdin', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', rec.path, '-an', '-sn', '-frames:v', '1',
          '-vf', 'scale=' + THUMB_SIZE + ':-2', '-q:v', '5', '-f', 'image2', '-y', tmp], { timeout: 30000 });
        if (exists(tmp)) return true;
      }
    }
    if (this.tools.qlmanage && this.tools.sips) {
      const dir = this.tmp('');
      try {
        await fsp.mkdir(dir, { recursive: true });
        await run(this.tools.qlmanage, ['-t', '-s', String(THUMB_SIZE), '-o', dir, rec.path], { timeout: 30000 });
        const png = (await fsp.readdir(dir)).find(function (n) { return /\.png$/i.test(n); });
        if (!png) return false;
        return await this.toJpeg(path.join(dir, png), tmp, THUMB_SIZE, THUMB_SIZE, 80);
      } finally {
        fsp.rm(dir, { recursive: true, force: true }).catch(function () {});
      }
    }
    return false;
  }

  // ---- full-size photos for the TV ------------------------------------------

  // Resolves { file, type } to send, or null when nothing usable can be produced.
  async photo(rec, w) {
    const native = PHOTO[rec.ext] && PHOTO[rec.ext].native;
    const original = { file: rec.path, type: PHOTO[rec.ext] ? PHOTO[rec.ext].mime : 'application/octet-stream', original: true };
    if (rec.ext === 'gif') return original; // keep animations moving
    if (!this.tools.sips) return native ? original : null;
    const file = path.join(this.photoDir, rec.id + '-' + rec.mtime + '-' + w + '.jpg');
    const made = await this.cached(file, this.photoLimit, async (tmp) => this.toJpeg(rec.path, tmp, await this.dims(rec), w, 88));
    if (made) return { file: made, type: 'image/jpeg' };
    return native ? original : null;
  }
}

module.exports = { Media, placeholderSvg };
