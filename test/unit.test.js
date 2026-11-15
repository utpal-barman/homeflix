'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isPrivateAddress, listAddresses } = require('../server/netinfo');
const { srtToVtt } = require('../server/subs');
const { parseRange, sanitiseName, uniquePath } = require('../server/util');
const { evaluateProgress } = require('../server/progress');
const { validatePatch } = require('../server/config');
const { qrMatrix, qrSvg } = require('../server/qr');
const { playability, kindOf } = require('../server/formats');
const { parseUrl } = require('../server/app');
const { titleFor, idFor } = require('../server/library');
const { findOrientation } = require('../server/exif');
const { tempDir } = require('./support/helpers');

test('private-address guard allows only loopback, private, link-local and ULA', () => {
  const yes = ['127.0.0.1', '127.8.9.10', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.106', '169.254.10.20',
    '::1', '::ffff:192.168.1.20', '::ffff:127.0.0.1', 'fe80::1c2a:3bff:fe4d:5e6f', 'fe80::1%en0', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'FD00::ABCD'];
  const no = ['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '192.167.1.1', '11.0.0.1', '100.64.0.1', '169.253.1.1', '1.2.3', '256.1.1.1',
    '::ffff:8.8.8.8', '2001:4860:4860::8888', 'fec0::1', 'fe00::1', '::', '::2', '', 'localhost', 'not an address', '192.168.0.1.evil.com'];
  for (const a of yes) assert.equal(isPrivateAddress(a), true, a + ' should be allowed');
  for (const a of no) assert.equal(isPrivateAddress(a), false, a + ' should be refused');
  assert.equal(isPrivateAddress(undefined), false);
  assert.equal(isPrivateAddress(null), false);
});

test('LAN address selection prefers en0, then en1, then other private addresses', () => {
  const list = listAddresses({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
    en1: [{ family: 'IPv4', address: '192.168.1.9', internal: false }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.0.106', internal: false }],
    en5: [{ family: 4, address: '169.254.3.4', internal: false }]
  }).map((a) => a.address);
  assert.deepEqual(list, ['192.168.0.106', '192.168.1.9', '10.8.0.2', '169.254.3.4']);
  assert.deepEqual(listAddresses({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), []);
});

test('srt is converted to WebVTT', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>there</i>\r\nsecond line\r\n\r\n2\r\n0:01:04,5 --> 0:01:06,25 X1:10 Y1:20\r\n{\\an8}<font color="#fff">Bye</font>\r\n\r\n3\r\n00:02:00,000 --> 00:02:01,000\r\n\r\n';
  const vtt = srtToVtt(srt);
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello <i>there</i>\nsecond line\n\n00:01:04.500 --> 00:01:06.250\nBye\n');
  assert.equal(srtToVtt(''), 'WEBVTT\n');
  // Latin-1 bytes that are not valid UTF-8 still decode
  const latin = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')]);
  assert.match(srtToVtt(latin), /café/);
});

test('range header parsing', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(parseRange('bytes=-0', 1000), 'invalid');
  assert.equal(parseRange('bytes=-', 1000), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});

test('upload names are reduced to one safe file name', () => {
  assert.equal(sanitiseName('Holiday 2024.mp4'), 'Holiday 2024.mp4');
  assert.equal(sanitiseName('../../etc/passwd.mp4'), 'passwd.mp4');
  assert.equal(sanitiseName('..\\..\\evil.mp4'), 'evil.mp4');
  assert.equal(sanitiseName('/abs/path/x.jpg'), 'x.jpg');
  assert.equal(sanitiseName('.hidden.mp4'), 'hidden.mp4');
  assert.equal(sanitiseName('a\u0000b\nc.mp4'), 'abc.mp4');
  assert.equal(sanitiseName('12:30 show.mp4'), '12-30 show.mp4');
  for (const bad of ['', '   ', '.', '..', '../', 'a/..', '...', null, undefined, 42]) assert.equal(sanitiseName(bad), null, JSON.stringify(bad));
  const long = sanitiseName('x'.repeat(500) + '.mp4');
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.mp4'));
});

test('name collisions get a numbered suffix', () => {
  const dir = tempDir();
  try {
    assert.equal(uniquePath(dir, 'a.mp4'), path.join(dir, 'a.mp4'));
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    assert.equal(uniquePath(dir, 'a.mp4'), path.join(dir, 'a (2).mp4'));
    fs.writeFileSync(path.join(dir, 'a (2).mp4'), 'x');
    assert.equal(uniquePath(dir, 'a.mp4'), path.join(dir, 'a (3).mp4'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('progress rules: under 30s and the last 5% clear the entry', () => {
  assert.equal(evaluateProgress(0, 100), null);
  assert.equal(evaluateProgress(29.9, 1000), null);
  assert.deepEqual(evaluateProgress(30, 1000), { position: 30, duration: 1000 });
  assert.deepEqual(evaluateProgress(949, 1000), { position: 949, duration: 1000 });
  assert.equal(evaluateProgress(950, 1000), null);
  assert.equal(evaluateProgress(1000, 1000), null);
  assert.deepEqual(evaluateProgress(45, 0), { position: 45, duration: 0 });
  assert.equal(evaluateProgress(NaN, 100), null);
});

test('config validation', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.deepEqual(validatePatch({}).value, {});
    assert.deepEqual(validatePatch({ name: '  Den  ', port: 9000, autoStart: true }).value, { name: 'Den', port: 9000, autoStart: true });
    assert.deepEqual(validatePatch({ libraryFolder: dir + '/', extraFolders: [dir, dir] }).value, { libraryFolder: dir, extraFolders: [dir] });
    assert.deepEqual(validatePatch({ unknown: 1 }).value, {});
    assert.equal(validatePatch({ name: '' }).code, 'bad_name');
    assert.equal(validatePatch({ name: 'x'.repeat(61) }).code, 'bad_name');
    assert.equal(validatePatch({ name: 5 }).code, 'bad_name');
    for (const port of [80, 0, 65536, 8080.5, '8080', null]) assert.equal(validatePatch({ port: port }).code, 'bad_port', String(port));
    assert.equal(validatePatch({ port: 7788 }, { controlPort: 7788 }).code, 'bad_port');
    assert.equal(validatePatch({ autoStart: 'yes' }).code, 'bad_request');
    assert.equal(validatePatch({ libraryFolder: path.join(dir, 'missing') }).code, 'folder_not_found');
    assert.equal(validatePatch({ libraryFolder: file }).code, 'folder_not_found');
    assert.equal(validatePatch({ libraryFolder: 'relative/path' }).code, 'bad_folder');
    assert.equal(validatePatch({ extraFolders: [path.join(dir, 'missing')] }).code, 'folder_not_found');
    assert.equal(validatePatch({ extraFolders: 'nope' }).code, 'bad_request');
    assert.equal(validatePatch([]).code, 'bad_request');
    assert.equal(typeof validatePatch({ port: 1 }).error, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QR code has the right structure', () => {
  const m = qrMatrix('http://192.168.0.106:8080');
  assert.equal(m.length, 25); // version 2 at level M
  assert.ok(m.every((row) => row.length === 25));
  // finder patterns: 7x7 dark ring, light ring, 3x3 dark core in three corners
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [r0, c0] of [[0, 0], [0, 18], [18, 0]]) {
    for (let r = 0; r < 7; r++) {
      assert.equal(m[r0 + r].slice(c0, c0 + 7).map((d) => (d ? '1' : '0')).join(''), finder[r]);
    }
  }
  // timing pattern alternates
  for (let i = 8; i < 17; i++) assert.equal(m[6][i], i % 2 === 0);
  const svg = qrSvg('http://192.168.0.106:8080');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 33 33"/);
  assert.ok(!/<script/i.test(svg));
  assert.ok(qrMatrix('http://some-very-long-host-name-for-a-mac.local:65535/with/a/path').length > 25);
});

test('formats and playability', () => {
  assert.equal(kindOf('mp4'), 'video');
  assert.equal(kindOf('heic'), 'photo');
  assert.equal(kindOf('txt'), null);
  assert.equal(kindOf('constructor'), null);
  assert.deepEqual(playability('mp4', null), { playable: 'yes', note: null });
  assert.deepEqual(playability('mp4', { vcodec: 'h264', acodec: 'aac' }), { playable: 'yes', note: null });
  assert.equal(playability('mp4', { vcodec: 'hevc', acodec: 'aac' }).playable, 'maybe');
  assert.match(playability('mp4', { vcodec: 'hevc' }).note, /HEVC/);
  assert.equal(playability('m4v', { vcodec: 'h264', acodec: 'ac3' }).playable, 'maybe');
  assert.equal(playability('webm', null).playable, 'maybe');
  assert.equal(playability('mov', { vcodec: 'h264' }).playable, 'maybe');
  for (const ext of ['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp']) {
    const p = playability(ext, null);
    assert.equal(p.playable, 'no');
    assert.equal(typeof p.note, 'string');
  }
});

test('request paths with traversal tricks are rejected', () => {
  for (const bad of ['/../x', '/a/../../b', '/%2e%2e/x', '/a/%2E%2E/b', '/a/..%2fb', '/a%5c..%5cb', '/a\\b', '/%00', '/a/./b', '/%252e%252e/x', '/a/%', 'relative', 'http://x/y', '']) {
    assert.equal(parseUrl(bad), null, bad);
  }
  assert.deepEqual(parseUrl('/media/abc?x=1').segments, ['media', 'abc']);
  assert.equal(parseUrl('/photo/abc?w=800').query.get('w'), '800');
  assert.deepEqual(parseUrl('/').segments, []);
  assert.deepEqual(parseUrl('/my%20file.js').segments, ['my file.js']);
});

test('titles and ids', () => {
  assert.equal(titleFor('Big_Buck.Bunny_2008.mp4'), 'Big Buck Bunny 2008');
  assert.equal(titleFor('photo.jpg'), 'photo');
  assert.match(idFor('/a/b.mp4'), /^[0-9a-f]{12}$/);
  assert.notEqual(idFor('/a/b.mp4'), idFor('/a/c.mp4'));
});

test('EXIF orientation is found in a JPEG header', () => {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4); head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(body.length + 2, 2);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), head, body, Buffer.from([0xff, 0xda, 0, 2])]);
  assert.equal(findOrientation(jpeg).orientation, 6);
  assert.equal(findOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.equal(findOrientation(Buffer.from('not a jpeg')), null);
});
