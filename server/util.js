'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---- child processes -------------------------------------------------------

const children = new Set();

function track(child) {
  children.add(child);
  child.once('exit', function () { children.delete(child); });
  child.once('error', function () { children.delete(child); });
  return child;
}

function killAllChildren() {
  children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* already gone */ } });
  children.clear();
}
process.on('exit', killAllChildren);

// Run a command, never throws. Resolves { code, stdout, stderr } (code -1 when it could not run or timed out).
function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message) });
    }
    track(child);
    const max = opts.maxBuffer || 4 * 1024 * 1024;
    let out = '', err = '', done = false, timer = null;
    function finish(code) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code, stdout: out, stderr: err });
    }
    child.stdout.on('data', function (d) { if (out.length < max) out += d; });
    child.stderr.on('data', function (d) { if (err.length < max) err += d; });
    child.on('error', function (e) { err += String(e && e.message); finish(-1); });
    child.on('close', function (code) { finish(code === null ? -1 : code); });
    if (opts.timeout) {
      timer = setTimeout(function () {
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        err += '\ntimed out';
        finish(-1);
      }, opts.timeout);
    }
  });
}

// ---- small helpers ---------------------------------------------------------

function limiter(max) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= max || !queue.length) return;
    active++;
    const job = queue.shift();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).then(function () { active--; next(); });
  }
  return function (fn) {
    return new Promise(function (resolve, reject) { queue.push({ fn: fn, resolve: resolve, reject: reject }); next(); });
  };
}

function writeFileAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// "name.ext" -> "name (2).ext" when taken.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate) && n < 10000; n++) {
    candidate = path.join(dir, base + ' (' + n + ')' + ext);
  }
  return candidate;
}

// Turn a client-supplied name into a safe single file/folder name, or null.
function sanitiseName(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.split(/[\\/]/).pop();
  n = n.replace(/:/g, '-').trim().replace(/^\.+/, '').trim();
  if (!n || n === '.' || n === '..') return null;
  const ext = path.extname(n);
  let base = n.slice(0, n.length - ext.length);
  while (base && Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
  base = base.trim();
  if (!base) return null;
  return base + ext;
}

// ---- HTTP ------------------------------------------------------------------

function sendJson(req, res, status, body, extraHeaders) {
  if (res.headersSent || res.destroyed) return;
  const buf = Buffer.from(JSON.stringify(body));
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendError(req, res, status, code, message, extraHeaders) {
  sendJson(req, res, status, { error: message, code: code }, extraHeaders);
}

function sendEmpty(res, status) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status || 204, { 'Cache-Control': 'no-cache' });
  res.end();
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function readJsonBody(req, limit) {
  limit = limit || 64 * 1024;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0, failed = false;
    req.on('data', function (c) {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'too_large', 'That request was too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('error', function () { if (!failed) { failed = true; reject(new HttpError(400, 'bad_request', 'The request was interrupted. Try again.')); } });
    req.on('end', function () {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch (e) {
        reject(new HttpError(400, 'bad_request', 'HomeFlix could not understand that request.'));
      }
    });
  });
}

// Parse a single "bytes=a-b" range. Returns null (no/ignored range), 'invalid' (416) or { start, end }.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range or other units: send the whole file
  if (m[1] === '' && m[2] === '') return 'invalid';
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!(start >= 0) || start >= size || end < start) return 'invalid';
  return { start: start, end: end };
}

// Stream a file with Range/HEAD support. `stat` is optional.
function sendFile(req, res, file, opts) {
  opts = opts || {};
  let st = opts.stat;
  try {
    if (!st) st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch (e) {
    return sendError(req, res, 404, 'not_found', 'That file is no longer there. It may have been moved or deleted.');
  }
  const size = st.size;
  const headers = {
    'Content-Type': opts.type || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache || 'no-cache',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'X-Content-Type-Options': 'nosniff'
  };
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    headers['Content-Range'] = 'bytes */' + size;
    headers['Content-Type'] = 'application/json; charset=utf-8';
    const body = Buffer.from(JSON.stringify({ error: 'That part of the file does not exist.', code: 'bad_range' }));
    headers['Content-Length'] = body.length;
    res.writeHead(416, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  let status = 200, start = 0, end = size - 1;
  if (range) {
    status = 206; start = range.start; end = range.end;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start: start, end: end });
  const cleanup = function () { stream.destroy(); };
  res.on('close', cleanup);
  stream.on('error', function () { res.destroy(); });
  stream.pipe(res);
}

module.exports = {
  track, run, killAllChildren, limiter, writeFileAtomicSync, isInside, uniquePath, sanitiseName,
  sendJson, sendError, sendEmpty, readJsonBody, HttpError, parseRange, sendFile
};
