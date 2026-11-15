'use strict';
// Where HomeFlix keeps its files. HOMEFLIX_HOME moves everything into one folder (used by tests).
const os = require('os');
const path = require('path');

function resolvePaths(env) {
  env = env || process.env;
  const webRoot = path.join(__dirname, '..', 'web');
  if (env.HOMEFLIX_HOME) {
    const d = path.resolve(env.HOMEFLIX_HOME);
    return {
      custom: true,
      dataDir: d,
      configFile: path.join(d, 'config.json'),
      progressFile: path.join(d, 'progress.json'),
      cacheDir: path.join(d, 'cache'),
      defaultLibrary: path.join(d, 'library'),
      // With HOMEFLIX_HOME set, "Move to Trash" goes here instead of the real macOS Trash.
      trashDir: path.join(d, 'trash'),
      webRoot
    };
  }
  const h = os.homedir();
  const dataDir = path.join(h, 'Library', 'Application Support', 'HomeFlix');
  return {
    custom: false,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    progressFile: path.join(dataDir, 'progress.json'),
    cacheDir: path.join(h, 'Library', 'Caches', 'HomeFlix'),
    defaultLibrary: path.join(h, 'Movies', 'HomeFlix'),
    trashDir: null,
    webRoot
  };
}

module.exports = { resolvePaths };
