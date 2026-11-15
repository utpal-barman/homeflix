'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startApp, bytes } = require('./support/helpers');
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
    assert.equal(typeof s.error, 'string');
    assert.match(s.error, /library folder/i);
    assert.ok(!/ENOENT|Error:|at \w+ \(/.test(s.error), 'no jargon or stack traces');
    assert.deepEqual(s.counts, { videos: 0, photos: 0, bytes: 0 });
    const up = await h.control('POST', '/api/upload?name=a.mp4', { body: bytes(10) });
    assert.equal(up.status, 500);
    assert.equal(up.json.code, 'no_library_folder');
    assert.equal((await h.control('POST', '/api/rescan')).status, 200);
    // the TV server still starts
    assert.equal((await h.control('POST', '/api/server/start')).json.running, true);
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
    assert.equal(fs.readdirSync(path.join(h.home, 'cache', 'thumbs')).length, 1);

    if (tools.sips) {
      const png = lib.photos.find((v) => v.file === 'wide.png');
      assert.equal(png.width, 800);
      assert.equal(png.height, 600);
      const small = await h.control('GET', '/photo/' + png.id + '?w=400');
      assert.equal(small.status, 200);
      assert.equal(small.headers['content-type'], 'image/jpeg');
      assert.equal(small.headers['cache-control'], 'max-age=86400');
      assert.equal(small.body.readUInt16BE(0), 0xffd8);
      const tiny = await h.control('GET', '/photo/' + png.id + '?w=1'); // clamped to 320
      assert.equal(tiny.status, 200);
      assert.ok(fs.readdirSync(path.join(h.home, 'cache', 'photos')).some((n) => n.endsWith('-320.jpg')));
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
