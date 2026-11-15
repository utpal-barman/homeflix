'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startApp, request, tempDir, bytes } = require('./support/helpers');

const ITEM_KEYS = ['id', 'kind', 'title', 'file', 'collection', 'ext', 'size', 'mtime', 'duration', 'width', 'height',
  'playable', 'note', 'hasSubs', 'writable', 'src', 'thumb', 'progress'].sort();
const STATUS_KEYS = ['libraryError', 'name', 'version', 'running', 'port', 'address', 'url', 'altUrls', 'wifiName', 'qrSvg', 'config',
  'counts', 'tools', 'scanning', 'clients', 'error'].sort();

let h, extra;
const movie = bytes(1000);

function standardFiles(lib) {
  fs.writeFileSync(path.join(lib, 'Movie_One.mp4'), movie);
  fs.writeFileSync(path.join(lib, 'Movie_One.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  fs.mkdirSync(path.join(lib, 'Trip', 'Day 1'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Trip', 'Day 1', 'beach.JPG'), bytes(300));
  fs.writeFileSync(path.join(lib, 'Trip', 'old.mkv'), bytes(50));
  fs.writeFileSync(path.join(lib, 'Trip', 'scan.heic'), bytes(40));
  fs.writeFileSync(path.join(lib, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(lib, '.hidden.mp4'), 'ignored');
  fs.mkdirSync(path.join(lib, '.secret'));
  fs.writeFileSync(path.join(lib, '.secret', 'x.mp4'), 'ignored');
  fs.utimesSync(path.join(lib, 'Trip', 'old.mkv'), new Date(2001, 0, 1), new Date(2001, 0, 1));
  // a link pointing outside the library must not be followed
  fs.symlinkSync(path.join(path.dirname(lib), 'config.json'), path.join(lib, 'escape.mp4'));
}

async function library() {
  const r = await h.control('GET', '/api/library');
  assert.equal(r.status, 200);
  return r.json;
}
async function itemByFile(file) {
  const lib = await library();
  return lib.videos.concat(lib.photos).find((i) => i.file === file);
}

test.before(async () => {
  extra = tempDir('homeflix-extra-');
  fs.writeFileSync(path.join(extra, 'family.mov'), bytes(64));
  h = await startApp({ files: standardFiles, config: { extraFolders: [extra] } });
});

test.after(async () => {
  await h.close();
  fs.rmSync(extra, { recursive: true, force: true });
});

test('GET /api/ping', async () => {
  const r = await h.control('GET', '/api/ping');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.deepEqual(r.json, { ok: true, name: 'HomeFlix', version: require('../package.json').version });
});

test('GET /api/library has the contract shape', async () => {
  const lib = await library();
  assert.deepEqual(Object.keys(lib).sort(), ['collections', 'continueWatching', 'generatedAt', 'name', 'photos', 'recent', 'version', 'videos']);
  assert.deepEqual(lib.videos.map((v) => v.file).sort(), ['Movie_One.mp4', 'family.mov', 'old.mkv']);
  assert.deepEqual(lib.photos.map((v) => v.file).sort(), ['beach.JPG', 'scan.heic']);
  for (const item of lib.videos.concat(lib.photos)) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
    assert.match(item.id, /^[0-9a-f]{12}$/);
    assert.equal(item.src, '/media/' + item.id);
    assert.equal(item.thumb, '/thumb/' + item.id + '?v=' + item.mtime);
    assert.ok(!JSON.stringify(item).includes(h.home), 'no file system paths leak to clients');
  }
  const movieItem = lib.videos.find((v) => v.file === 'Movie_One.mp4');
  assert.equal(movieItem.title, 'Movie One');
  assert.equal(movieItem.kind, 'video');
  assert.equal(movieItem.ext, 'mp4');
  assert.equal(movieItem.size, 1000);
  assert.equal(movieItem.collection, 'library'); // top-level files use the folder's own name
  assert.equal(movieItem.playable, 'yes');
  assert.equal(movieItem.note, null);
  assert.equal(movieItem.hasSubs, true);
  assert.equal(movieItem.writable, true);
  assert.equal(movieItem.duration, null);
  assert.equal(movieItem.progress, null);

  const mkv = lib.videos.find((v) => v.file === 'old.mkv');
  assert.equal(mkv.playable, 'no');
  assert.equal(typeof mkv.note, 'string');
  assert.equal(mkv.collection, 'Trip');
  assert.equal(mkv.hasSubs, false);

  const mov = lib.videos.find((v) => v.file === 'family.mov');
  assert.equal(mov.playable, 'maybe');
  assert.equal(mov.writable, false);
  assert.equal(mov.collection, path.basename(extra));

  const beach = lib.photos.find((v) => v.file === 'beach.JPG');
  assert.equal(beach.ext, 'jpg');
  assert.equal(beach.collection, 'Trip'); // first-level subfolder, even when nested deeper
  assert.equal(beach.playable, 'yes');
  assert.equal(beach.duration, null);

  // newest first
  assert.equal(lib.videos[lib.videos.length - 1].file, 'old.mkv');
  for (const list of [lib.videos, lib.photos, lib.recent]) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].mtime >= list[i].mtime);
  }
  assert.equal(lib.recent.length, 5);
  assert.deepEqual(lib.continueWatching, []);
  assert.deepEqual(lib.collections.find((c) => c.name === 'Trip'), { name: 'Trip', videos: 1, photos: 2 });
  assert.deepEqual(lib.collections.find((c) => c.name === 'library'), { name: 'library', videos: 1, photos: 0 });
});

test('GET /media/<id> supports full, ranged and HEAD requests', async () => {
  const item = await itemByFile('Movie_One.mp4');
  const full = await h.control('GET', item.src);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], '1000');
  assert.ok(full.body.equals(movie));

  const part = await h.control('GET', item.src, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
  assert.equal(part.headers['content-length'], '100');
  assert.ok(part.body.equals(movie.subarray(100, 200)));

  const open = await h.control('GET', item.src, { headers: { Range: 'bytes=990-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], 'bytes 990-999/1000');
  assert.ok(open.body.equals(movie.subarray(990)));

  const tail = await h.control('GET', item.src, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.ok(tail.body.equals(movie.subarray(990)));

  const beyond = await h.control('GET', item.src, { headers: { Range: 'bytes=0-999999' } });
  assert.equal(beyond.status, 206);
  assert.equal(beyond.headers['content-range'], 'bytes 0-999/1000');

  const backwards = await h.control('GET', item.src, { headers: { Range: 'bytes=5-2' } });
  assert.equal(backwards.status, 200, 'a nonsense range is ignored');
  assert.ok(backwards.body.equals(movie));

  const bad = await h.control('GET', item.src, { headers: { Range: 'bytes=1000-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */1000');
  assert.equal(bad.json.code, 'bad_range');

  const head = await h.control('HEAD', item.src);
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '1000');
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.body.length, 0);

  const headRange = await h.control('HEAD', item.src, { headers: { Range: 'bytes=0-9' } });
  assert.equal(headRange.status, 206);
  assert.equal(headRange.headers['content-length'], '10');
  assert.equal(headRange.body.length, 0);

  const mkv = await itemByFile('old.mkv');
  assert.equal((await h.control('HEAD', mkv.src)).headers['content-type'], 'video/x-matroska');

  assert.equal((await h.control('GET', '/media/000000000000')).status, 404);
  assert.equal((await h.control('GET', '/media/not-an-id')).status, 404);
  for (const p of ['/media/a/b', '/media/' + item.id + '/extra', '/media', '/thumb/a/b/c', '/photo/', '/subs/a/b.vtt']) {
    const r = await h.control('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(r.json.code, 'not_found', p + ' is JSON, not the app page');
  }
  assert.equal((await h.control('POST', item.src)).status, 405);
});

test('GET /thumb/<id> falls back to an SVG placeholder, never an error', async () => {
  for (const file of ['Movie_One.mp4', 'beach.JPG']) {
    const item = await itemByFile(file);
    const r = await h.control('GET', item.thumb);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/svg+xml');
    assert.match(r.text, /^<svg /);
    assert.match(r.text, /#ffb454/);
  }
  assert.equal((await h.control('GET', '/thumb/000000000000')).status, 404);
});

test('GET /photo/<id> without sips: original for browser-native types, clear error otherwise', async () => {
  const beach = await itemByFile('beach.JPG');
  const r = await h.control('GET', '/photo/' + beach.id + '?w=99999');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.body.length, 300);
  const heic = await itemByFile('scan.heic');
  const e = await h.control('GET', '/photo/' + heic.id);
  assert.equal(e.status, 415);
  assert.equal(e.json.code, 'cannot_convert');
  const video = await itemByFile('Movie_One.mp4');
  assert.equal((await h.control('GET', '/photo/' + video.id)).status, 404);
});

test('GET /subs/<id>.vtt converts the sidecar .srt', async () => {
  const item = await itemByFile('Movie_One.mp4');
  const r = await h.control('GET', '/subs/' + item.id + '.vtt');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/vtt; charset=utf-8');
  assert.equal(r.text, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
  const none = await itemByFile('old.mkv');
  assert.equal((await h.control('GET', '/subs/' + none.id + '.vtt')).status, 404);
  assert.equal((await h.control('GET', '/subs/' + item.id)).status, 404);
});

test('progress: stored, cleared under 30s, cleared in the last 5%, deletable', async () => {
  const item = await itemByFile('Movie_One.mp4');
  const url = '/api/progress/' + item.id;
  const put = (body) => h.control('PUT', url, { body: body, headers: { 'Content-Type': 'application/json' } });

  let r = await put({ position: 120, duration: 1000 });
  assert.equal(r.status, 204);
  assert.equal(r.body.length, 0);
  let lib = await library();
  assert.equal(lib.continueWatching.length, 1);
  assert.equal(lib.continueWatching[0].id, item.id);
  const p = lib.continueWatching[0].progress;
  assert.deepEqual(Object.keys(p).sort(), ['duration', 'position', 'updatedAt']);
  assert.equal(p.position, 120);
  assert.equal(p.duration, 1000);
  assert.ok(Math.abs(Date.now() - p.updatedAt) < 5000);
  assert.deepEqual(lib.videos.find((v) => v.id === item.id).progress, p);

  assert.equal((await put({ position: 29, duration: 1000 })).status, 204); // not really started
  assert.equal((await library()).continueWatching.length, 0);

  await put({ position: 500, duration: 1000 });
  assert.equal((await library()).continueWatching.length, 1);
  assert.equal((await put({ position: 951, duration: 1000 })).status, 204); // finished
  assert.equal((await library()).continueWatching.length, 0);

  await put({ position: 500, duration: 1000 });
  assert.equal((await h.control('DELETE', url)).status, 204);
  assert.equal((await library()).continueWatching.length, 0);
  assert.equal((await h.control('DELETE', url)).status, 204);

  for (const bad of [{ position: 'x', duration: 10 }, { duration: 10 }, { position: -1, duration: 10 }, { position: 50, duration: 'long' }]) {
    const e = await put(bad);
    assert.equal(e.status, 400, JSON.stringify(bad));
    assert.equal(e.json.code, 'bad_request');
  }
  assert.equal((await h.control('PUT', url, { body: 'not json' })).status, 400);
  assert.equal((await h.control('PUT', '/api/progress/000000000000', { body: { position: 50, duration: 100 } })).status, 404);
  assert.equal((await h.control('GET', url)).status, 405);
});

test('progress is saved to progress.json', async () => {
  const item = await itemByFile('Movie_One.mp4');
  await h.control('PUT', '/api/progress/' + item.id, { body: { position: 300, duration: 1000 } });
  h.app.progress.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'progress.json'), 'utf8'));
  assert.equal(saved[item.id].position, 300);
  await h.control('DELETE', '/api/progress/' + item.id);
});

test('upload: happy path, collection, name collision, rejections', async () => {
  const data = bytes(2048);
  const up = (query, body) => h.control('POST', '/api/upload?' + query, { body: body === undefined ? data : body });

  const a = await up('name=' + encodeURIComponent('New Film.mp4'));
  assert.equal(a.status, 201);
  assert.deepEqual(Object.keys(a.json.item).sort(), ITEM_KEYS);
  assert.equal(a.json.item.file, 'New Film.mp4');
  assert.equal(a.json.item.size, 2048);
  assert.equal(a.json.item.writable, true);
  assert.equal(a.json.item.collection, 'library');
  assert.ok(fs.readFileSync(path.join(h.lib, 'New Film.mp4')).equals(data));
  assert.ok((await library()).videos.some((v) => v.id === a.json.item.id), 'appears in the library straight away');
  assert.ok((await h.control('GET', a.json.item.src)).body.equals(data));

  const b = await up('name=' + encodeURIComponent('New Film.mp4'));
  assert.equal(b.status, 201);
  assert.equal(b.json.item.file, 'New Film (2).mp4');
  assert.notEqual(b.json.item.id, a.json.item.id);
  const c = await up('name=' + encodeURIComponent('New Film.mp4'));
  assert.equal(c.json.item.file, 'New Film (3).mp4');
  assert.ok(fs.readFileSync(path.join(h.lib, 'New Film.mp4')).equals(data), 'the first file was not overwritten');

  const d = await up('name=pic.png&collection=' + encodeURIComponent('Summer 2024'));
  assert.equal(d.status, 201);
  assert.equal(d.json.item.kind, 'photo');
  assert.equal(d.json.item.collection, 'Summer 2024');
  assert.ok(fs.existsSync(path.join(h.lib, 'Summer 2024', 'pic.png')));

  const txt = await up('name=notes.txt');
  assert.equal(txt.status, 415);
  assert.equal(txt.json.code, 'unsupported_type');
  assert.equal(typeof txt.json.error, 'string');
  assert.equal((await up('name=noextension')).status, 415);
  assert.equal((await up('name=virus.mp4.exe')).status, 415);

  for (const q of ['', 'name=', 'name=..', 'name=' + encodeURIComponent('../'), 'name=ok.mp4&collection=..']) {
    const r = await up(q);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.code, 'bad_name');
  }
  const empty = await up('name=empty.mp4', '');
  assert.equal(empty.status, 400);

  // a hostile name cannot escape the library folder
  const evil = await up('name=' + encodeURIComponent('../../../escaped.mp4') + '&collection=' + encodeURIComponent('../../outside'));
  assert.equal(evil.status, 201);
  assert.equal(evil.json.item.file, 'escaped.mp4');
  assert.ok(fs.existsSync(path.join(h.lib, 'outside', 'escaped.mp4')));
  assert.ok(!fs.existsSync(path.join(h.home, 'escaped.mp4')));
  assert.ok(!fs.existsSync(path.join(path.dirname(h.home), 'escaped.mp4')));

  // no temp files left behind
  const leftovers = fs.readdirSync(h.lib).filter((n) => n.includes('.part'));
  assert.deepEqual(leftovers, []);
  assert.equal((await h.control('GET', '/api/upload?name=x.mp4')).status, 405);
});

test('an upload that is cut off leaves nothing behind', async () => {
  await new Promise((resolve) => {
    const s = net.connect(h.app.controlPort, '127.0.0.1', () => {
      s.write('POST /api/upload?name=cut.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\n' + 'x'.repeat(500));
      setTimeout(() => { s.destroy(); setTimeout(resolve, 150); }, 100);
    });
  });
  assert.ok(!fs.existsSync(path.join(h.lib, 'cut.mp4')));
  assert.deepEqual(fs.readdirSync(h.lib).filter((n) => n.includes('.part')), []);
});

test('path traversal attempts never leave the web or library folders', async () => {
  const secret = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const attempts = [
    '/../package.json', '/../../package.json', '/shared/../../package.json', '/tv/../../package.json',
    '/%2e%2e/package.json', '/shared/%2e%2e/%2e%2e/package.json', '/shared/..%2f..%2fpackage.json',
    '/shared/%2E%2E%5C%2E%2E%5Cpackage.json', '/shared/..\\..\\package.json', '/%252e%252e/package.json',
    '/shared/....//....//package.json', '/media/../../package.json', '/media/..%2f..%2fpackage.json',
    '/media/' + encodeURIComponent(path.join(__dirname, '..', 'package.json')),
    '/thumb/..%2f..%2f..%2fetc%2fpasswd', '/photo/%2e%2e', '/subs/..%2f..%2fpackage.json.vtt',
    '//etc/passwd', '/shared//etc/passwd', '/shared/%00', '/.git/config', '/shared/.DS_Store'
  ];
  for (const port of [h.app.controlPort]) {
    for (const a of attempts) {
      const r = await request(port, 'GET', a);
      assert.ok([400, 404].includes(r.status), a + ' -> ' + r.status);
      assert.ok(!r.text.includes(secret.slice(0, 40)), a + ' leaked a file');
      assert.ok(!r.text.includes('root:'), a + ' leaked a file');
    }
  }
  // files in the library that are not media are not reachable by any id
  const lib = await library();
  assert.ok(!JSON.stringify(lib).includes('notes.txt'));
  assert.ok(!JSON.stringify(lib).includes('escape.mp4'), 'links out of the library are not followed');
  assert.ok(!JSON.stringify(lib).includes('.hidden'));
});

test('static files: shared assets, friendly page when the interface is missing, JSON 404 for unknown API', async () => {
  const logo = await h.control('GET', '/shared/logo.svg');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers['content-type'], 'image/svg+xml');
  assert.equal(logo.headers['cache-control'], 'no-cache');
  assert.equal((await h.control('GET', '/shared/nope.png')).status, 404);
  assert.equal((await h.control('POST', '/shared/logo.svg')).status, 405);

  const root = await h.control('GET', '/');
  assert.ok(root.status === 200 || root.status === 503);
  assert.match(root.headers['content-type'], /^text\/html/);
  const redirect = await h.control('GET', '/tv');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/tv/');
  assert.match((await h.control('GET', '/tv/')).headers['content-type'], /^text\/html/);

  const unknown = await h.control('GET', '/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'not_found');
  assert.equal(typeof unknown.json.error, 'string');
  assert.equal((await h.control('POST', '/api/items/000000000000/unknown')).status, 404);
});

test('control server only answers the local browser', async () => {
  const foreignHost = await h.control('GET', '/api/status', { headers: { Host: 'evil.example.com' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.json.code, 'forbidden');
  const foreignOrigin = await h.control('POST', '/api/server/stop', { headers: { Origin: 'http://evil.example.com' } });
  assert.equal(foreignOrigin.status, 403);
  const port = h.app.controlPort;
  const sameOrigin = await h.control('POST', '/api/rescan', { headers: { Origin: 'http://127.0.0.1:' + port } });
  assert.equal(sameOrigin.status, 200);
  const viaLocalhost = await h.control('POST', '/api/rescan', { headers: { Host: 'localhost:' + port, Origin: 'http://localhost:' + port } });
  assert.equal(viaLocalhost.status, 200);
  // another program's page on this Mac (a different localhost port) is not the control panel
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:' + (port + 1), 'http://localhost', 'https://127.0.0.1:' + port, 'null', 'garbage']) {
    const r = await h.control('POST', '/api/rescan', { headers: { Origin: origin } });
    assert.equal(r.status, 403, origin);
    assert.equal(r.json.code, 'forbidden');
  }
  assert.equal((await h.control('GET', '/api/status', { headers: { Origin: 'http://localhost:3000' } })).status, 200, 'reads are not affected');
  assert.equal((await h.control('POST', '/api/rescan')).status, 200, 'no Origin header (curl, same-origin GET forms) is fine');
  assert.equal(h.app.controlPort > 0, true);
});

test('GET /api/status has the contract shape', async () => {
  const r = await h.control('GET', '/api/status');
  assert.equal(r.status, 200);
  const s = r.json;
  assert.deepEqual(Object.keys(s).sort(), STATUS_KEYS);
  assert.equal(s.name, 'HomeFlix');
  assert.equal(s.running, false);
  assert.equal(s.port, h.tvPort);
  assert.deepEqual(Object.keys(s.config).sort(), ['autoStart', 'extraFolders', 'libraryFolder', 'name', 'port']);
  assert.equal(s.config.libraryFolder, h.lib);
  assert.deepEqual(s.config.extraFolders, [extra]);
  assert.deepEqual(Object.keys(s.counts).sort(), ['bytes', 'photos', 'videos']);
  assert.ok(s.counts.videos >= 3 && s.counts.photos >= 2 && s.counts.bytes > 1000);
  assert.deepEqual(s.tools, { ffmpeg: false, sips: false });
  assert.equal(typeof s.scanning, 'boolean');
  assert.deepEqual(s.clients, []);
  assert.equal(s.error, null);
  assert.equal(s.libraryError, null);
  assert.ok(Array.isArray(s.altUrls));
  if (s.address) {
    assert.equal(s.url, 'http://' + s.address + ':' + s.port);
    assert.match(s.qrSvg, /^<svg /);
  } else {
    assert.equal(s.url, null);
    assert.equal(s.qrSvg, null);
  }
});

test('TV server: start/stop toggle, read-only surface, port fallback', async () => {
  const refused = () => request(h.tvPort, 'GET', '/api/ping').then(() => false, (e) => e.code === 'ECONNREFUSED');
  assert.equal(await refused(), true, 'nothing listens while off');

  let r = await h.control('POST', '/api/server/start');
  assert.equal(r.status, 200);
  assert.equal(r.json.running, true);
  assert.equal(r.json.port, h.tvPort);
  assert.equal(r.json.error, null);
  assert.equal((await h.control('POST', '/api/server/start')).json.running, true, 'starting twice is fine');

  const ping = await h.tv('GET', '/api/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.json.ok, true);
  const lib = await h.tv('GET', '/api/library');
  assert.equal(lib.status, 200);
  const item = lib.json.videos.find((v) => v.file === 'Movie_One.mp4');
  const part = await h.tv('GET', item.src, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.ok(part.body.equals(movie.subarray(0, 10)));
  assert.equal((await h.tv('GET', item.thumb)).status, 200);
  assert.equal((await h.tv('GET', '/shared/logo.svg')).status, 200);
  assert.match((await h.tv('GET', '/')).headers['content-type'], /^text\/html/);
  assert.match((await h.tv('GET', '/some/page')).headers['content-type'], /^text\/html/);
  assert.equal((await h.tv('GET', '/missing.js')).status, 404);
  const icon = await h.tv('GET', '/favicon.ico');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
  assert.equal((await h.tv('GET', '/media/a/b')).status, 404);

  // only answers to its address, localhost or a .local name
  for (const host of ['192.168.0.106:' + h.tvPort, 'localhost:' + h.tvPort, 'my-mac.local:' + h.tvPort, '[::1]:' + h.tvPort]) {
    assert.equal((await h.tv('GET', '/api/ping', { headers: { Host: host } })).status, 200, host);
  }
  for (const host of ['evil.example.com', 'evil.example.com:' + h.tvPort, 'homeflix.attacker.net']) {
    const r = await h.tv('GET', '/api/library', { headers: { Host: host } });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.code, 'forbidden');
    assert.equal((await h.tv('PUT', '/api/progress/' + item.id, { headers: { Host: host }, body: { position: 100, duration: 1000 } })).status, 403);
  }

  // progress is the only thing the TV may write
  assert.equal((await h.tv('PUT', '/api/progress/' + item.id, { body: { position: 100, duration: 1000 } })).status, 204);
  assert.equal((await h.tv('GET', '/api/library')).json.continueWatching.length, 1);
  assert.equal((await h.tv('DELETE', '/api/progress/' + item.id)).status, 204);

  // no admin endpoints on the LAN side
  const admin = [['GET', '/api/status'], ['POST', '/api/server/stop'], ['POST', '/api/server/start'], ['PUT', '/api/config'],
    ['POST', '/api/upload?name=x.mp4'], ['DELETE', '/api/items/' + item.id], ['POST', '/api/items/' + item.id + '/convert'],
    ['GET', '/api/jobs'], ['POST', '/api/rescan'], ['POST', '/api/folders/choose'], ['POST', '/api/folders/reveal']];
  for (const [method, p] of admin) {
    const a = await h.tv(method, p, { body: '{}' });
    assert.equal(a.status, 404, method + ' ' + p);
    assert.equal(a.json.code, 'not_found');
  }
  assert.ok(fs.existsSync(path.join(h.lib, 'Movie_One.mp4')));
  assert.equal((await h.tv('GET', '/../package.json')).status, 400);

  r = await h.control('POST', '/api/server/stop');
  assert.equal(r.status, 200);
  assert.equal(r.json.running, false);
  assert.equal(await refused(), true, 'nothing listens after stop');
  assert.equal((await h.control('POST', '/api/server/stop')).json.running, false, 'stopping twice is fine');
  assert.equal((await h.control('GET', '/api/ping')).status, 200, 'control server stays up');

  // busy port: the next free one is used and reported
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(h.tvPort, '127.0.0.1', resolve));
  try {
    r = await h.control('POST', '/api/server/start');
    assert.equal(r.status, 200);
    assert.equal(r.json.running, true);
    assert.ok(r.json.port > h.tvPort && r.json.port <= h.tvPort + 20);
    assert.equal(r.json.config.port, h.tvPort, 'the setting itself is unchanged');
    assert.equal((await request(r.json.port, 'GET', '/api/ping')).status, 200);
  } finally {
    await h.control('POST', '/api/server/stop');
    await new Promise((resolve) => blocker.close(resolve));
  }
  assert.equal((await h.control('GET', '/api/server/start')).status, 405);
});

test('TV server refuses clients that are not on the home network', async () => {
  const call = (remoteAddress) => new Promise((resolve) => {
    const res = {
      headersSent: false, destroyed: false, status: null, body: '',
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(b) { this.body = b ? b.toString() : ''; resolve(this); },
      on() {}
    };
    const req = { method: 'GET', url: '/api/ping', headers: { 'user-agent': 'TestTV/1.0', host: '192.168.0.106:8080' }, socket: { remoteAddress: remoteAddress }, resume() {}, on() {} };
    h.app._handleTv(req, res);
  });
  for (const addr of ['8.8.8.8', '::ffff:93.184.216.34', '2001:db8::1', '172.32.0.1', '']) {
    const res = await call(addr);
    assert.equal(res.status, 403, addr);
    assert.equal(JSON.parse(res.body).code, 'forbidden');
  }
  h.app._clients.clear();
  for (const addr of ['192.168.0.50', '::ffff:10.0.0.7', '127.0.0.1', 'fd00::5']) {
    const res = await call(addr);
    assert.equal(res.status, 200, addr);
  }
  // connected TVs are remembered (the Mac itself is not listed)
  assert.deepEqual(Array.from(h.app._clients.keys()).sort(), ['10.0.0.7', '192.168.0.50', 'fd00::5']);
  assert.equal(h.app._clients.get('192.168.0.50').userAgent, 'TestTV/1.0');
  await h.control('POST', '/api/server/start');
  const on = (await h.control('GET', '/api/status')).json;
  assert.deepEqual(on.clients.map((c) => c.address).sort(), ['10.0.0.7', '192.168.0.50', 'fd00::5']);
  for (const c of on.clients) {
    assert.deepEqual(Object.keys(c).sort(), ['address', 'lastSeen', 'userAgent']);
    assert.equal(c.userAgent, 'TestTV/1.0');
    assert.ok(Math.abs(Date.now() - c.lastSeen) < 5000);
  }
  // TVs not heard from for 2 minutes drop off the list
  h.app._clients.get('10.0.0.7').lastSeen = Date.now() - 121000;
  assert.deepEqual((await h.control('GET', '/api/status')).json.clients.map((c) => c.address).sort(), ['192.168.0.50', 'fd00::5']);
  await h.control('POST', '/api/server/stop');
  assert.deepEqual((await h.control('GET', '/api/status')).json.clients, [], 'switching off clears the list');
});

test('PUT /api/config validates and applies', async () => {
  const put = (body) => h.control('PUT', '/api/config', { body: body });
  let r = await put({ name: 'Living Room' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Living Room');
  assert.equal(r.json.config.name, 'Living Room');
  assert.equal((await h.control('GET', '/api/ping')).json.name, 'Living Room');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8')).name, 'Living Room');

  for (const [body, code] of [[{ port: 80 }, 'bad_port'], [{ port: 'x' }, 'bad_port'], [{ port: h.app.controlPort }, 'bad_port'], [{ name: '' }, 'bad_name'],
    [{ libraryFolder: path.join(h.home, 'does-not-exist') }, 'folder_not_found'], [{ extraFolders: [path.join(h.home, 'nope')] }, 'folder_not_found'],
    [{ autoStart: 'maybe' }, 'bad_request']]) {
    r = await put(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, code);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal((await h.control('PUT', '/api/config', { body: '{broken' })).status, 400);
  assert.equal((await h.control('GET', '/api/status')).json.config.name, 'Living Room', 'rejected changes are not applied');

  // removing the extra folder removes its items; adding it back restores them
  r = await put({ extraFolders: [] });
  assert.equal(r.status, 200);
  await h.app.library.whenIdle();
  assert.ok(!(await library()).videos.some((v) => v.file === 'family.mov'));
  r = await put({ extraFolders: [extra], name: 'HomeFlix' });
  await h.app.library.whenIdle();
  assert.ok((await library()).videos.some((v) => v.file === 'family.mov'));

  // changing the port while running restarts the TV server on the new port
  await h.control('POST', '/api/server/start');
  const { freePort } = require('./support/helpers');
  const next = await freePort();
  r = await put({ port: next });
  assert.equal(r.json.running, true);
  assert.equal(r.json.port, next);
  assert.equal((await request(next, 'GET', '/api/ping')).status, 200);
  await h.control('POST', '/api/server/stop');
  await put({ port: h.tvPort });
});

test('folders: choose and reveal go through the Mac helpers', async () => {
  const cancelled = await h.control('POST', '/api/folders/choose');
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.json, { cancelled: true });
  assert.equal(h.calls.choose, 1);

  let r = await h.control('POST', '/api/folders/reveal', { body: { path: h.lib } });
  assert.equal(r.status, 204);
  assert.deepEqual(h.calls.reveal.pop(), { target: h.lib, isFile: false });
  r = await h.control('POST', '/api/folders/reveal', { body: { path: extra } });
  assert.equal(r.status, 204);
  const item = await itemByFile('Movie_One.mp4');
  r = await h.control('POST', '/api/folders/reveal', { body: { id: item.id } });
  assert.equal(r.status, 204);
  assert.deepEqual(h.calls.reveal.pop(), { target: path.join(h.lib, 'Movie_One.mp4'), isFile: true });

  const before = h.calls.reveal.length;
  r = await h.control('POST', '/api/folders/reveal', { body: { path: '/etc' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'not_a_library_folder');
  assert.equal((await h.control('POST', '/api/folders/reveal', { body: { path: path.join(h.lib, 'Trip') } })).status, 400);
  assert.equal((await h.control('POST', '/api/folders/reveal', { body: { id: '000000000000' } })).status, 404);
  assert.equal((await h.control('POST', '/api/folders/reveal', { body: {} })).status, 400);
  assert.equal(h.calls.reveal.length, before, 'nothing was opened for rejected requests');
});

test('convert without ffmpeg answers 501; jobs list is empty', async () => {
  const mkv = await itemByFile('old.mkv');
  const r = await h.control('POST', '/api/items/' + mkv.id + '/convert');
  assert.equal(r.status, 501);
  assert.equal(r.json.code, 'no_ffmpeg');
  const photo = await itemByFile('beach.JPG');
  assert.equal((await h.control('POST', '/api/items/' + photo.id + '/convert')).status, 400);
  assert.equal((await h.control('POST', '/api/items/000000000000/convert')).status, 404);
  assert.deepEqual((await h.control('GET', '/api/jobs')).json, { jobs: [] });
  assert.equal((await h.control('DELETE', '/api/jobs/nope')).status, 404);
});

test('DELETE /api/items/<id>: Trash for library files, 403 for extra folders', async () => {
  const ro = await itemByFile('family.mov');
  let r = await h.control('DELETE', '/api/items/' + ro.id);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'read_only');
  assert.ok(fs.existsSync(path.join(extra, 'family.mov')));
  assert.equal(h.calls.trash.length, 0);

  const up = await h.control('POST', '/api/upload?name=delete-me.mp4', { body: bytes(100) });
  const id = up.json.item.id;
  await h.control('PUT', '/api/progress/' + id, { body: { position: 100, duration: 1000 } });
  r = await h.control('DELETE', '/api/items/' + id);
  assert.equal(r.status, 204);
  assert.deepEqual(h.calls.trash, [path.join(h.lib, 'delete-me.mp4')]);
  assert.ok(!fs.existsSync(path.join(h.lib, 'delete-me.mp4')));
  assert.ok(fs.existsSync(path.join(h.home, 'fake-trash', 'delete-me.mp4')), 'moved, not destroyed');
  const lib = await library();
  assert.ok(!lib.videos.some((v) => v.id === id));
  assert.ok(!lib.continueWatching.some((v) => v.id === id));
  assert.equal((await h.control('GET', '/media/' + id)).status, 404);
  assert.equal((await h.control('DELETE', '/api/items/' + id)).status, 404);
  assert.equal((await h.control('DELETE', '/api/items/..%2f..')).status, 400);
});

test('POST /api/rescan picks up files added behind our back', async () => {
  fs.writeFileSync(path.join(h.lib, 'Trip', 'dropped.webm'), bytes(10));
  const r = await h.control('POST', '/api/rescan');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), STATUS_KEYS);
  const item = await itemByFile('dropped.webm');
  assert.equal(item.playable, 'maybe');
  assert.equal(item.collection, 'Trip');
});

test('the folder watcher notices new files on its own', async () => {
  fs.writeFileSync(path.join(h.lib, 'watched.mp4'), bytes(10));
  let found = null;
  for (let i = 0; i < 60 && !found; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = await itemByFile('watched.mp4');
  }
  assert.ok(found, 'the new file showed up without a rescan');
});

test('files that vanish or are swapped for links are never served', async () => {
  const outside = path.join(h.home, 'config.json'); // exists, but is not in any library folder
  // a vanished file
  fs.writeFileSync(path.join(h.lib, 'gone.mp4'), bytes(20));
  fs.writeFileSync(path.join(h.lib, 'swap.mp4'), bytes(20));
  fs.writeFileSync(path.join(h.lib, 'swap.jpg'), bytes(20));
  fs.writeFileSync(path.join(h.lib, 'linked.mp4'), bytes(20));
  fs.symlinkSync(outside, path.join(h.lib, 'linked.srt')); // subtitle "file" pointing out of the library
  fs.writeFileSync(path.join(h.lib, 'inner.mp4'), bytes(20));
  fs.writeFileSync(path.join(h.lib, 'Trip', 'real.vtt'), 'WEBVTT\n');
  fs.symlinkSync(path.join(h.lib, 'Trip', 'real.vtt'), path.join(h.lib, 'inner.vtt')); // a link that stays inside is fine
  await h.control('POST', '/api/rescan');

  const gone = await itemByFile('gone.mp4');
  fs.unlinkSync(path.join(h.lib, 'gone.mp4'));
  const r = await h.control('GET', gone.src);
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'file_missing');
  assert.ok(r.json.error.length > 20 && !/ENOENT/.test(r.json.error));
  assert.equal((await h.control('HEAD', gone.src)).status, 404);
  const goneThumb = await h.control('GET', gone.thumb);
  assert.equal(goneThumb.status, 200);
  assert.equal(goneThumb.headers['content-type'], 'image/svg+xml');

  // subtitles linked from outside are ignored, links inside the library work
  const linked = await itemByFile('linked.mp4');
  assert.equal(linked.hasSubs, false);
  assert.equal((await h.control('GET', '/subs/' + linked.id + '.vtt')).status, 404);
  const inner = await itemByFile('inner.mp4');
  assert.equal(inner.hasSubs, true);
  assert.equal((await h.control('GET', '/subs/' + inner.id + '.vtt')).text, 'WEBVTT\n');
  // ... until the link is re-pointed after it was indexed
  fs.unlinkSync(path.join(h.lib, 'inner.vtt'));
  fs.symlinkSync(outside, path.join(h.lib, 'inner.vtt'));
  const subs = await h.control('GET', '/subs/' + inner.id + '.vtt');
  assert.equal(subs.status, 404);
  assert.ok(!subs.text.includes('port'));

  // an indexed file replaced by a link to somewhere else, before any rescan
  const secret = fs.readFileSync(outside, 'utf8');
  for (const name of ['swap.mp4', 'swap.jpg']) {
    const item = await itemByFile(name);
    fs.unlinkSync(path.join(h.lib, name));
    fs.symlinkSync(outside, path.join(h.lib, name));
    const urls = [item.src, '/photo/' + item.id];
    for (const url of urls) {
      const res = await h.control('GET', url);
      assert.equal(res.status, 404, name + ' ' + url);
      assert.ok(!res.text.includes(secret.slice(0, 20)));
    }
    const thumb = await h.control('GET', item.thumb);
    assert.equal(thumb.headers['content-type'], 'image/svg+xml');
    assert.ok(!thumb.text.includes(secret.slice(0, 20)));
    fs.unlinkSync(path.join(h.lib, name));
  }
  fs.unlinkSync(path.join(h.lib, 'linked.srt'));
  fs.unlinkSync(path.join(h.lib, 'inner.vtt'));
});
