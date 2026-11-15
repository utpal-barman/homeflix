'use strict';
const os = require('os');
const { run } = require('./util');

function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = [+m[1], +m[2], +m[3], +m[4]];
  for (let i = 0; i < 4; i++) if (p[i] > 255) return null;
  return p;
}

function isPrivateV4(s) {
  const p = parseV4(s);
  if (!p) return false;
  if (p[0] === 127) return true;                           // loopback
  if (p[0] === 10) return true;                            // 10/8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
  if (p[0] === 192 && p[1] === 168) return true;           // 192.168/16
  if (p[0] === 169 && p[1] === 254) return true;           // link-local
  return false;
}

function stripMapped(addr) {
  let a = String(addr || '').trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  const m = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return m ? m[1] : a;
}

// True for loopback, RFC1918 private, link-local and IPv6 unique-local addresses only.
function isPrivateAddress(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  const a = stripMapped(addr);
  if (a.indexOf(':') === -1) return isPrivateV4(a);
  if (!/^[0-9a-f:]+$/.test(a)) return false;
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith(':')) return false; // "::", "::x" and other compressed-leading forms are not private
  const first = parseInt(a.split(':')[0], 16);
  if (isNaN(first)) return false;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  return false;
}

function isLoopback(addr) {
  const a = stripMapped(addr);
  return a === '::1' || /^127\./.test(a);
}

// Non-internal IPv4 addresses, best first: en0, en1, then other private ones, link-local last.
function listAddresses(ifaces) {
  ifaces = ifaces || os.networkInterfaces();
  const out = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (i) {
      const fam = i.family === 4 || i.family === 'IPv4';
      if (!fam || i.internal || !parseV4(i.address)) return;
      let score = 50;
      const linkLocal = /^169\.254\./.test(i.address);
      const priv = isPrivateV4(i.address) && !linkLocal;
      if (name === 'en0' && priv) score = 0;
      else if (name === 'en1' && priv) score = 1;
      else if (/^en\d+$/.test(name) && priv) score = 5;
      else if (/^192\.168\./.test(i.address)) score = 10;
      else if (priv) score = 12;
      else if (linkLocal) score = 90;
      out.push({ name: name, address: i.address, score: score });
    });
  });
  out.sort(function (a, b) { return a.score - b.score || a.name.localeCompare(b.name); });
  return out;
}

class NetInfo {
  constructor() {
    this.localHostName = null;
    this.wifiName = null;
    this.lastRefresh = 0;
    this.refreshing = null;
  }

  addresses() { return listAddresses().map(function (a) { return a.address; }); }

  // Refresh slow facts (hostname, Wi-Fi name) in the background, at most every 30s.
  refresh(force) {
    const self = this;
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastRefresh < 30000) return Promise.resolve();
    this.lastRefresh = Date.now();
    this.refreshing = Promise.all([readLocalHostName(), readWifiName()]).then(function (r) {
      self.localHostName = r[0];
      self.wifiName = r[1];
    }).catch(function () { /* best effort */ }).then(function () { self.refreshing = null; });
    return this.refreshing;
  }
}

async function readLocalHostName() {
  const r = await run('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 3000 });
  const name = r.code === 0 ? r.stdout.trim() : '';
  if (name && /^[A-Za-z0-9-]+$/.test(name)) return name;
  const h = os.hostname().replace(/\.local$/i, '');
  return /^[A-Za-z0-9-]+$/.test(h) ? h : null;
}

function cleanSsid(s) {
  s = (s || '').trim();
  if (!s || /redacted/i.test(s) || s === '<unknown>') return null;
  return s;
}

// Best effort: recent macOS versions hide the Wi-Fi name from command-line tools.
async function readWifiName() {
  for (const dev of ['en0', 'en1']) {
    const a = await run('/usr/sbin/networksetup', ['-getairportnetwork', dev], { timeout: 3000 });
    const m = /Current Wi-Fi Network:\s*(.+)/.exec(a.stdout);
    if (a.code === 0 && m && cleanSsid(m[1])) return cleanSsid(m[1]);
  }
  for (const dev of ['en0', 'en1']) {
    const b = await run('/usr/sbin/ipconfig', ['getsummary', dev], { timeout: 3000 });
    const m = /^\s*SSID\s*:\s*(.+)$/m.exec(b.stdout);
    if (b.code === 0 && m && cleanSsid(m[1])) return cleanSsid(m[1]);
  }
  return null;
}

module.exports = { isPrivateAddress, isLoopback, stripMapped, listAddresses, NetInfo };
