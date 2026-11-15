'use strict';

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('windows-1252').decode(buf); } catch (e2) { return buf.toString('latin1'); }
  }
}

function pad(s, n) { s = String(s); while (s.length < n) s = '0' + s; return s; }

// "0:01:02,5" / "01:02.500" -> "00:01:02.500"
function normaliseTime(t) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/.exec(t.trim());
  if (!m) return null;
  let ms = m[4] || '0';
  while (ms.length < 3) ms += '0';
  return pad(m[1] || '0', 2) + ':' + pad(m[2], 2) + ':' + pad(m[3], 2) + '.' + ms;
}

const TIMING = /^\s*([\d:,.]+)\s*-->\s*([\d:,.]+)/;

// Convert SubRip text (string or Buffer) to WebVTT.
function srtToVtt(input) {
  let text = Buffer.isBuffer(input) ? decodeText(input) : String(input);
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out = ['WEBVTT', ''];
  const blocks = text.split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length && !TIMING.test(lines[i])) i++;
    if (i >= lines.length) continue;
    const m = TIMING.exec(lines[i]);
    const start = normaliseTime(m[1]), end = normaliseTime(m[2]);
    if (!start || !end) continue;
    const body = lines.slice(i + 1)
      .map(function (l) { return l.replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, '').replace(/-->/g, '->').trimEnd(); })
      .filter(function (l) { return l.trim() !== ''; });
    if (!body.length) continue;
    out.push(start + ' --> ' + end);
    for (const l of body) out.push(l);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { srtToVtt, decodeText };
