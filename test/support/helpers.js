'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { createApp } = require('../../server/app');

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

module.exports = { startApp, request, freePort, tempDir, bytes, NO_TOOLS };
