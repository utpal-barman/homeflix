'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomicSync } = require('./util');

const DEFAULT_PORT = 8080;

function defaults(paths) {
  return { name: 'HomeFlix', port: DEFAULT_PORT, libraryFolder: paths.defaultLibrary, extraFolders: [], autoStart: false };
}

function normaliseFolder(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  if (!path.isAbsolute(s)) return null;
  s = path.resolve(s);
  return s;
}

function folderProblem(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return 'not_a_folder';
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return null;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function folderMessage(dir, problem) {
  if (problem === 'missing') return 'The folder "' + dir + '" could not be found. Choose a folder that exists.';
  if (problem === 'not_a_folder') return '"' + dir + '" is a file, not a folder. Choose a folder instead.';
  return 'HomeFlix is not allowed to read the folder "' + dir + '". Choose another folder, or allow access in System Settings > Privacy & Security > Files and Folders.';
}

function validPort(p) {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;
}

// Validate a partial config. Returns { value } (only the accepted keys, normalised)
// or { error, code }. `opts.controlPort` is refused as a TV port.
function validatePatch(patch, opts) {
  opts = opts || {};
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'HomeFlix could not understand those settings.', code: 'bad_request' };
  }
  if ('name' in patch) {
    const n = typeof patch.name === 'string' ? patch.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (!n || n.length > 60) return { error: 'Give your server a name between 1 and 60 characters.', code: 'bad_name' };
    out.name = n;
  }
  if ('port' in patch) {
    if (!validPort(patch.port)) return { error: 'The port must be a whole number between 1024 and 65535. If you are not sure, use 8080.', code: 'bad_port' };
    if (opts.controlPort && patch.port === opts.controlPort) return { error: 'Port ' + patch.port + ' is already used by this control panel. Choose a different number, for example 8080.', code: 'bad_port' };
    out.port = patch.port;
  }
  if ('autoStart' in patch) {
    if (typeof patch.autoStart !== 'boolean') return { error: 'The "start automatically" setting must be on or off.', code: 'bad_request' };
    out.autoStart = patch.autoStart;
  }
  if ('libraryFolder' in patch) {
    const dir = normaliseFolder(patch.libraryFolder);
    if (!dir) return { error: 'Choose a folder for your library.', code: 'bad_folder' };
    const problem = folderProblem(dir);
    if (problem) return { error: folderMessage(dir, problem), code: 'folder_not_found' };
    out.libraryFolder = dir;
  }
  if ('extraFolders' in patch) {
    if (!Array.isArray(patch.extraFolders) || patch.extraFolders.length > 50) return { error: 'The list of extra folders is not valid.', code: 'bad_request' };
    const list = [];
    for (const raw of patch.extraFolders) {
      const dir = normaliseFolder(raw);
      if (!dir) return { error: 'One of the extra folders is not valid. Remove it and add it again.', code: 'bad_folder' };
      const problem = folderProblem(dir);
      if (problem) return { error: folderMessage(dir, problem), code: 'folder_not_found' };
      if (list.indexOf(dir) === -1) list.push(dir);
    }
    out.extraFolders = list;
  }
  return { value: out };
}

class ConfigStore {
  constructor(paths) {
    this.paths = paths;
    this.value = defaults(paths);
    this.load();
  }

  // Never throws: a broken or missing file falls back to defaults.
  load() {
    const d = defaults(this.paths);
    let raw = null, firstRun = false;
    try {
      raw = JSON.parse(fs.readFileSync(this.paths.configFile, 'utf8'));
    } catch (e) {
      firstRun = !fs.existsSync(this.paths.configFile);
    }
    const v = d;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (typeof raw.name === 'string' && raw.name.trim() && raw.name.length <= 60) v.name = raw.name.trim();
      if (validPort(raw.port)) v.port = raw.port;
      const lib = normaliseFolder(raw.libraryFolder);
      if (lib) v.libraryFolder = lib;
      if (Array.isArray(raw.extraFolders)) {
        v.extraFolders = raw.extraFolders.map(normaliseFolder).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
      }
      if (typeof raw.autoStart === 'boolean') v.autoStart = raw.autoStart;
    }
    this.value = v;
    // The default library folder is created for the user; a custom one that went missing is reported, not recreated.
    if (v.libraryFolder === this.paths.defaultLibrary) {
      try { fs.mkdirSync(v.libraryFolder, { recursive: true }); } catch (e) { /* reported by the library scan */ }
    }
    if (firstRun || !raw) this.save();
    return v;
  }

  get() { return this.value; }

  public() {
    const v = this.value;
    return { name: v.name, port: v.port, libraryFolder: v.libraryFolder, extraFolders: v.extraFolders.slice(), autoStart: v.autoStart };
  }

  update(patchValue) {
    this.value = Object.assign({}, this.value, patchValue);
    this.save();
    return this.value;
  }

  save() {
    try {
      writeFileAtomicSync(this.paths.configFile, JSON.stringify(this.public(), null, 2) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = { ConfigStore, validatePatch, normaliseFolder, folderProblem, folderMessage, DEFAULT_PORT };
