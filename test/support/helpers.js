'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { createApp } = require('../../server/app');

const zlib = require('zlib');

// A real (plain grey) PNG, so image tools have something valid to read.
function makePng(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Width and height of a JPEG, read from its frame header.
function jpegSize(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    }
    p += 2 + buf.readUInt16BE(p + 2);
  }
  return null;
}

const NO_TOOLS = { ffmpeg: null, ffprobe: null, sips: null, qlmanage: null };

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'homeflix-test-')));
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const port = s.address().port;
      s.close(function () { resolve(port); });
    });
  });
}

// Raw HTTP request: the path is sent exactly as given (no "../" clean-up like fetch does).
function request(port, method, rawPath, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    let body = null;
    if (opts.body !== undefined) body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (body) headers['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: rawPath, headers: headers, agent: false }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: body, text: body.toString('utf8'), json: json });
      });
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

// Start an isolated HomeFlix in a temp HOMEFLIX_HOME on ephemeral ports. No real Finder, Trash or dialogs.
async function startApp(options) {
  options = options || {};
  const home = tempDir();
  const lib = path.join(home, 'library');
  fs.mkdirSync(lib, { recursive: true });
  const tvPort = await freePort();
  const cfg = Object.assign({ port: tvPort }, options.config || {});
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  if (options.files) options.files(lib, home);
  const calls = { trash: [], reveal: [], choose: 0 };
  const app = createApp({
    env: { HOMEFLIX_HOME: home, PATH: process.env.PATH },
    controlPort: 0,
    tvHost: '127.0.0.1',
    recheckMs: options.recheckMs,
    tools: options.tools === undefined ? NO_TOOLS : options.tools,
    ui: {
      trash: async function (file) {
        calls.trash.push(file);
        fs.mkdirSync(path.join(home, 'fake-trash'), { recursive: true });
        fs.renameSync(file, path.join(home, 'fake-trash', path.basename(file)));
        return true;
      },
      reveal: async function (target, isFile) { calls.reveal.push({ target: target, isFile: isFile }); return true; },
      chooseFolder: async function () { calls.choose++; return options.chosenFolder === undefined ? null : options.chosenFolder; }
    }
  });
  await app.start();
  await app.library.whenIdle();
  return {
    app: app, home: home, lib: lib, tvPort: tvPort, calls: calls,
    control: function (method, p, opts) { return request(app.controlPort, method, p, opts); },
    tv: function (method, p, opts) { return request(app.tvPort, method, p, opts); },
    close: async function () {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function bytes(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

module.exports = { startApp, request, freePort, tempDir, bytes, makePng, jpegSize, NO_TOOLS };
