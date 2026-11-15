'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const net = require('net');
const { startApp, bytes, makePng, jpegSize, tempDir } = require('./support/helpers');
const { detectTools } = require('../server/tools');

test('a missing library folder gives an empty library and a plain-language error, not a crash', async () => {
  const h = await startApp({ files: (lib) => fs.rmSync(lib, { recursive: true }), config: { libraryFolder: '/definitely/not/here/HomeFlix' } });
  try {
    const lib = await h.control('GET', '/api/library');
    assert.equal(lib.status, 200);
    assert.deepEqual(lib.json.videos, []);
    assert.deepEqual(lib.json.photos, []);
    assert.deepEqual(lib.json.collections, []);
    const s = (await h.control('GET', '/api/status')).json;
    assert.equal(typeof s.libraryError, 'string');
    assert.match(s.libraryError, /library folder/i);
    assert.ok(!/ENOENT|Error:|at \w+ \(/.test(s.libraryError), 'no jargon or stack traces');
    assert.equal(s.error, null, 'a folder problem is not a problem turning the TV server on');
    assert.deepEqual(s.counts, { videos: 0, photos: 0, bytes: 0 });
    const up = await h.control('POST', '/api/upload?name=a.mp4', { body: bytes(10) });
    assert.equal(up.status, 500);
    assert.equal(up.json.code, 'no_library_folder');
    assert.equal((await h.control('POST', '/api/rescan')).status, 200);
    // the TV server still starts
    const on = (await h.control('POST', '/api/server/start')).json;
    assert.equal(on.running, true);
    assert.equal(on.error, null);
    assert.equal(typeof on.libraryError, 'string');
  } finally {
    await h.close();
  }
});

test('a broken config.json and progress.json fall back to defaults', async () => {
  const h = await startApp({
    files: (lib, home) => {
      fs.writeFileSync(path.join(home, 'config.json'), '{ this is not json');
      fs.writeFileSync(path.join(home, 'progress.json'), '[[[');
      fs.writeFileSync(path.join(lib, 'a.mp4'), bytes(10));
    }
  });
  try {
    const s = (await h.control('GET', '/api/status')).json;
    assert.equal(s.config.name, 'HomeFlix');
    assert.equal(s.config.port, 8080);
    assert.equal(s.config.libraryFolder, h.lib);
    assert.equal(s.config.autoStart, false);
    assert.equal(s.counts.videos, 1);
    assert.equal(s.running, false);
  } finally {
    await h.close();
  }
});

test('autoStart switches the TV server on at launch, and a first run creates the library folder', async () => {
  const h = await startApp({ files: (lib) => fs.rmSync(lib, { recursive: true }), config: { autoStart: true } });
  try {
    assert.ok(fs.statSync(h.lib).isDirectory(), 'default library folder was created');
    const s = (await h.control('GET', '/api/status')).json;
    assert.equal(s.running, true);
    assert.equal(s.error, null);
    assert.equal((await h.tv('GET', '/api/ping')).status, 200);
  } finally {
    await h.close();
  }
});

const tools = detectTools(process.env);
const realMedia = !!(tools.ffmpeg && tools.ffprobe);

test('real media: duration, thumbnail, resized photo, conversion', { skip: realMedia ? false : 'ffmpeg/ffprobe not installed' }, async () => {
  const h = await startApp({
    tools: tools,
    files: (lib) => {
      const run = (args) => {
        const r = spawnSync(tools.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y'].concat(args));
        assert.equal(r.status, 0, String(r.stderr));
      };
      run(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(lib, 'clip.mp4')]);
      run(['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=5', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(lib, 'big.mp4')]);
      run(['-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=5', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(lib, 'tall.mp4')]);
      fs.writeFileSync(path.join(lib, 'huge.png'), makePng(3000, 2000));
      run(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', '-c:v', 'mpeg4', path.join(lib, 'old.avi')]);
      run(['-f', 'lavfi', '-i', 'testsrc=size=800x600:rate=1', '-frames:v', '1', path.join(lib, 'wide.png')]);
    }
  });
  try {
    const lib = (await h.control('GET', '/api/library')).json;
    const clip = lib.videos.find((v) => v.file === 'clip.mp4');
    assert.ok(Math.abs(clip.duration - 1) < 0.3, 'duration ' + clip.duration);
    assert.equal(clip.width, 320);
    assert.equal(clip.height, 180);
    assert.equal(clip.playable, 'yes');

    const thumb = await h.control('GET', clip.thumb);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
    assert.equal(thumb.headers['cache-control'], 'max-age=86400');
    assert.equal(thumb.body.readUInt16BE(0), 0xffd8, 'is a JPEG');
    const again = await h.control('GET', clip.thumb);
    assert.ok(again.body.equals(thumb.body), 'served from the cache');
    assert.deepEqual(fs.readdirSync(path.join(h.home, 'cache', 'thumbs')), [clip.id + '-' + clip.mtime + '-480.jpg']);
    assert.deepEqual(jpegSize(thumb.body), { width: 320, height: 180 }, 'small videos are not enlarged');
    assert.ok((await h.control('GET', '/thumb/' + clip.id)).body.equals(thumb.body), 'the v parameter is optional');

    // larger artwork: cut from the source at that size, cached per size
    const big = lib.videos.find((v) => v.file === 'big.mp4');
    const sizes = {};
    for (const [w, want] of [['', 480], ['&w=480', 480], ['&w=700', 960], ['&w=960', 960], ['&w=1280', 1280], ['&w=5000', 1280]]) {
      const r = await h.control('GET', big.thumb + w);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/jpeg');
      assert.equal(r.headers['cache-control'], 'max-age=86400');
      const size = jpegSize(r.body);
      assert.equal(size.width, want, 'w' + w);
      assert.equal(size.height, want * 9 / 16);
      sizes[want] = r.body.length;
    }
    assert.ok(sizes[1280] > sizes[960] && sizes[960] > sizes[480], 'bigger sizes carry more detail');
    assert.deepEqual(fs.readdirSync(path.join(h.home, 'cache', 'thumbs')).filter((n) => n.startsWith(big.id)).sort(),
      [480, 960, 1280].map((s) => big.id + '-' + big.mtime + '-' + s + '.jpg').sort());
    const tall = lib.videos.find((v) => v.file === 'tall.mp4');
    assert.deepEqual(jpegSize((await h.control('GET', tall.thumb)).body), { width: 270, height: 480 }, 'the longest side is the one that is limited');
    assert.deepEqual(jpegSize((await h.control('GET', tall.thumb + '&w=1280')).body), { width: 540, height: 960 });

    if (tools.sips) {
      const png = lib.photos.find((v) => v.file === 'wide.png');
      assert.equal(png.width, 800);
      assert.equal(png.height, 600);
      const small = await h.control('GET', '/photo/' + png.id + '?w=400');
      assert.equal(small.status, 200);
      assert.equal(small.headers['content-type'], 'image/jpeg');
      assert.equal(small.headers['cache-control'], 'max-age=86400');
      assert.equal(small.body.readUInt16BE(0), 0xffd8);
      const huge = lib.photos.find((v) => v.file === 'huge.png');
      for (const [w, want] of [['?w=1', 640], ['?w=400', 640], ['?w=640', 640], ['?w=1000', 1280], ['', 1920], ['?w=2000', 2560], ['?w=99999', 3000]]) {
        const r = await h.control('GET', '/photo/' + huge.id + w);
        assert.equal(r.status, 200);
        assert.equal(jpegSize(r.body).width, want, 'photo ' + w);
      }
      // many different requests, few cached files
      assert.deepEqual(fs.readdirSync(path.join(h.home, 'cache', 'photos')).filter((n) => n.startsWith(huge.id)).map((n) => n.split(/[-.]/)[2]).sort(),
        ['1280', '1920', '2560', '3840', '640']);
      assert.deepEqual(jpegSize((await h.control('GET', huge.thumb + '&w=1280')).body), { width: 1280, height: 853 });
      assert.deepEqual(jpegSize((await h.control('GET', huge.thumb)).body), { width: 480, height: 320 });
      const pthumb = await h.control('GET', png.thumb);
      assert.equal(pthumb.headers['content-type'], 'image/jpeg');
    }

    const avi = lib.videos.find((v) => v.file === 'old.avi');
    assert.equal(avi.playable, 'no');
    const start = await h.control('POST', '/api/items/' + avi.id + '/convert');
    assert.equal(start.status, 202);
    assert.deepEqual(Object.keys(start.json.job).sort(), ['error', 'id', 'itemId', 'percent', 'state', 'title']);
    assert.equal(start.json.job.itemId, avi.id);
    let job = null;
    for (let i = 0; i < 150; i++) {
      job = (await h.control('GET', '/api/jobs')).json.jobs.find((j) => j.id === start.json.job.id);
      if (job.state === 'done' || job.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.state, 'done', job.error || '');
    assert.equal(job.percent, 100);
    assert.ok(fs.existsSync(path.join(h.lib, 'old.mp4')));
    assert.ok(fs.existsSync(path.join(h.lib, 'old.avi')), 'the original is kept');
    const converted = (await h.control('GET', '/api/library')).json.videos.find((v) => v.file === 'old.mp4');
    assert.equal(converted.playable, 'yes');
    assert.equal((await h.control('DELETE', '/api/jobs/' + job.id)).status, 204);
    assert.deepEqual((await h.control('GET', '/api/jobs')).json.jobs, []);
    assert.deepEqual(fs.readdirSync(h.lib).filter((n) => n.startsWith('.homeflix-')), []);
  } finally {
    await h.close();
  }
});

test('unreadable videos do not hold up other thumbnails', { skip: tools.sips ? false : 'sips not installed' }, async () => {
  for (const variant of [tools, Object.assign({}, tools, { ffmpeg: null, ffprobe: null })]) {
    const h = await startApp({
      tools: variant,
      files: (lib) => {
        fs.writeFileSync(path.join(lib, 'junk1.mp4'), bytes(5000));
        fs.writeFileSync(path.join(lib, 'junk2.mp4'), '');
        fs.writeFileSync(path.join(lib, 'junk3.mp4'), bytes(9000));
        fs.writeFileSync(path.join(lib, 'good.png'), makePng(600, 400));
      }
    });
    try {
      const lib = (await h.control('GET', '/api/library')).json;
      const started = Date.now();
      const junk = lib.videos.map((v) => h.control('GET', v.thumb)); // asked for first, as a grid would
      junk.forEach((p) => p.catch(() => {})); // without ffmpeg these may still be waiting on Quick Look when the test ends
      await new Promise((resolve) => setTimeout(resolve, 50));
      const good = await h.control('GET', lib.photos[0].thumb);
      const took = Date.now() - started;
      assert.equal(good.headers['content-type'], 'image/jpeg');
      assert.ok(took < 3000, 'photo thumbnail took ' + took + 'ms behind broken videos (ffmpeg: ' + !!variant.ffmpeg + ')');
      if (variant.ffmpeg) {
        for (const r of await Promise.all(junk)) {
          assert.equal(r.status, 200);
          assert.equal(r.headers['content-type'], 'image/svg+xml');
        }
        assert.ok(Date.now() - started < 5000, 'broken videos fall back to the placeholder quickly');
      }
    } finally {
      await h.close();
    }
  }
});

test('photos with accented, non-Latin and emoji names get their size', { skip: tools.sips ? false : 'sips not installed' }, async () => {
  const names = ['naïve.png', 'café 日本 😀.png', '日本.png', 'plain.png', 'e\u0301cole.png' /* decomposed on purpose */];
  const h = await startApp({ tools: tools, files: (lib) => names.forEach((n) => fs.writeFileSync(path.join(lib, n), makePng(64, 48))) });
  try {
    const photos = (await h.control('GET', '/api/library')).json.photos;
    assert.equal(photos.length, names.length);
    for (const p of photos) {
      assert.equal(p.width, 64, p.file);
      assert.equal(p.height, 48, p.file);
    }
    const up = await h.control('POST', '/api/upload?name=' + encodeURIComponent('Ünïcödé ñame.png'), { body: makePng(32, 16) });
    assert.equal(up.status, 201);
    assert.equal(up.json.item.width, 32);
    assert.equal(up.json.item.height, 16);
  } finally {
    await h.close();
  }
});

test('stale temp files from a killed HomeFlix are cleaned up at start, fresh and foreign ones are kept', async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const extra = tempDir('homeflix-extra-');
  const h = await startApp({
    config: { extraFolders: [extra] },
    files: (lib) => {
      fs.mkdirSync(path.join(lib, 'Trip'));
      const make = (p, aged) => { fs.writeFileSync(p, 'x'); if (aged) fs.utimesSync(p, old, old); };
      make(path.join(lib, '.homeflix-upload-0123456789abcdef.part'), true);
      make(path.join(lib, 'Trip', '.homeflix-upload-aaaaaaaaaaaaaaaa.part'), true);
      make(path.join(lib, 'Trip', '.homeflix-convert-abcdef012345.mp4'), true);
      make(path.join(lib, '.homeflix-upload-ffffffffffffffff.part'), false);   // may belong to a running copy
      make(path.join(lib, '.homeflix-convert-ffffffffffff.mp4'), false);
      make(path.join(lib, '.homeflix-notes.txt'), true);                        // not one of ours
      make(path.join(lib, '.hidden-thing.part'), true);
      make(path.join(lib, 'homeflix-upload-0123456789abcdef.part'), true);
      make(path.join(lib, 'old-movie.mp4'), true);
      make(path.join(extra, '.homeflix-upload-0123456789abcdef.part'), true);  // extra folders are never written to
    }
  });
  try {
    const all = (dir) => fs.readdirSync(dir).sort();
    assert.deepEqual(all(h.lib), ['.hidden-thing.part', '.homeflix-convert-ffffffffffff.mp4', '.homeflix-notes.txt', '.homeflix-upload-ffffffffffffffff.part',
      'Trip', 'homeflix-upload-0123456789abcdef.part', 'old-movie.mp4']);
    assert.deepEqual(all(path.join(h.lib, 'Trip')), []);
    assert.deepEqual(all(extra), ['.homeflix-upload-0123456789abcdef.part']);
    assert.equal((await h.control('GET', '/api/library')).json.videos.length, 1);
  } finally {
    await h.close();
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test('a folder that appears later (a drive plugged back in) is noticed and watched', async () => {
  const parent = tempDir('homeflix-drive-');
  const drive = path.join(parent, 'Movies');
  const h = await startApp({ config: { extraFolders: [drive] }, recheckMs: 100 });
  const waitFor = async (check) => {
    for (let i = 0; i < 80; i++) {
      const v = await check();
      if (v) return v;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  const files = async () => (await h.control('GET', '/api/library')).json.videos.map((v) => v.file).sort();
  const status = async () => (await h.control('GET', '/api/status')).json;
  try {
    assert.match((await status()).libraryError, /extra folder/i);
    assert.deepEqual(await files(), []);

    fs.mkdirSync(drive);
    fs.writeFileSync(path.join(drive, 'film.mp4'), bytes(10));
    assert.ok(await waitFor(async () => (await files()).includes('film.mp4')), 'the reconnected folder was scanned without a rescan');
    assert.equal((await status()).libraryError, null);

    // and it is watched from now on
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(drive, 'second.mp4'), bytes(10));
    assert.ok(await waitFor(async () => (await files()).includes('second.mp4')), 'new files in the reconnected folder show up');

    // unplugged again: items go away and the problem is reported
    fs.rmSync(drive, { recursive: true });
    assert.ok(await waitFor(async () => (await files()).length === 0), 'items of a disconnected folder disappear');
    assert.match((await status()).libraryError, /extra folder/i);
  } finally {
    await h.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
