'use strict';
// Just enough JPEG/EXIF parsing to read and reset the Orientation tag.
const fs = require('fs');

// Returns { orientation, offset, little } where offset is the byte position of the tag value, or null.
function findOrientation(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    if (marker === 0xe1 && p + 10 <= buf.length && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10;
      if (t + 8 > buf.length) return null;
      const bo = buf.toString('latin1', t, t + 2);
      const little = bo === 'II';
      if (!little && bo !== 'MM') return null;
      const u16 = function (o) { return little ? buf.readUInt16LE(o) : buf.readUInt16BE(o); };
      const u32 = function (o) { return little ? buf.readUInt32LE(o) : buf.readUInt32BE(o); };
      const ifd = t + u32(t + 4);
      if (ifd + 2 > buf.length) return null;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) return null;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return { orientation: v >= 1 && v <= 8 ? v : 1, offset: e + 8, little: little };
        }
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// EXIF orientation (1-8) of a JPEG file; 1 when absent or unreadable.
function jpegOrientation(file) {
  try {
    const found = findOrientation(readHead(file, 256 * 1024));
    return found ? found.orientation : 1;
  } catch (e) {
    return 1;
  }
}

// Set the orientation tag of a JPEG file back to 1 ("upright"), in place.
function resetJpegOrientation(file) {
  try {
    const found = findOrientation(readHead(file, 256 * 1024));
    if (!found || found.orientation === 1) return;
    const b = Buffer.alloc(2);
    if (found.little) b.writeUInt16LE(1, 0); else b.writeUInt16BE(1, 0);
    const fd = fs.openSync(file, 'r+');
    try { fs.writeSync(fd, b, 0, 2, found.offset); } finally { fs.closeSync(fd); }
  } catch (e) { /* leave the file as it is */ }
}

module.exports = { findOrientation, jpegOrientation, resetJpegOrientation };
