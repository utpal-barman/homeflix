'use strict';
const fs = require('fs');
const { writeFileAtomicSync } = require('./util');

// Decide what a progress report means: an entry to store, or null to clear
// (under 30s counts as not started, the last 5% counts as finished).
function evaluateProgress(position, duration) {
  if (!(position >= 30)) return null;
  if (duration > 0 && position >= duration * 0.95) return null;
  return { position: Math.round(position * 10) / 10, duration: duration > 0 ? Math.round(duration * 10) / 10 : 0 };
}

class ProgressStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.timer = null;
    this.dirty = false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach((id) => {
          const e = raw[id];
          if (/^[0-9a-f]{12}$/.test(id) && e && typeof e.position === 'number' && typeof e.duration === 'number' && typeof e.updatedAt === 'number') {
            this.map.set(id, { position: e.position, duration: e.duration, updatedAt: e.updatedAt });
          }
        });
      }
    } catch (e) { /* no progress yet */ }
  }

  get(id) { return this.map.get(id) || null; }

  set(id, position, duration) {
    const entry = evaluateProgress(position, duration);
    if (!entry) return this.clear(id);
    entry.updatedAt = Date.now();
    this.map.set(id, entry);
    this.touch();
    return entry;
  }

  clear(id) {
    if (this.map.delete(id)) this.touch();
    return null;
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    const obj = {};
    this.map.forEach(function (v, k) { obj[k] = v; });
    try { writeFileAtomicSync(this.file, JSON.stringify(obj)); } catch (e) { /* try again on the next change */ }
  }
}

module.exports = { ProgressStore, evaluateProgress };
