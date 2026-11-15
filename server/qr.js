'use strict';
const qrcode = require('./vendor/qrcode-generator');

// Module matrix (array of rows of booleans) for `text`. Error correction M, smallest version that fits.
function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(!!qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

// Inline SVG: dark ink modules on white (kept high-contrast so phone cameras read it), 4-module quiet zone.
function qrSvg(text) {
  const m = qrMatrix(text);
  const n = m.length, q = 4, size = n + q * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!m[r][c]) { c++; continue; }
      let e = c;
      while (e < n && m[r][e]) e++;
      d += 'M' + (c + q) + ' ' + (r + q) + 'h' + (e - c) + 'v1h-' + (e - c) + 'z';
      c = e;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size * 8 + '" height="' + size * 8 +
    '" shape-rendering="crispEdges" role="img" aria-label="QR code for the HomeFlix address">' +
    '<rect width="' + size + '" height="' + size + '" fill="#ffffff"/><path fill="#0b0a0f" d="' + d + '"/></svg>';
}

module.exports = { qrMatrix, qrSvg };
