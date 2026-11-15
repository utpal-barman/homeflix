'use strict';
// Optional helper programs. None are required; features degrade without them.
const fs = require('fs');
const path = require('path');

function findExecutable(name, env) {
  const dirs = String((env || process.env).PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

function detectTools(env) {
  return {
    ffmpeg: findExecutable('ffmpeg', env),
    ffprobe: findExecutable('ffprobe', env),
    sips: findExecutable('sips', env),
    qlmanage: findExecutable('qlmanage', env)
  };
}

module.exports = { detectTools, findExecutable };
